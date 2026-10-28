import * as core from "@actions/core";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { keccak256, toBytes, type PrivateKeyAccount } from "viem";

import { amount, type Preset } from "./presets.js";

const MAX_TIMEOUT_SECONDS = 600;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface Brief {
  title: string;
  brief: string;
  levels: string[];
}

export interface Posted {
  order: `0x${string}`;
  /** What was signed, in token units. */
  price: bigint;
  /** The connection dropped after the payment was signed: the order may exist, so it is followed, never paid again. */
  uncertain: boolean;
}

/** Pays the desk for one task. Throws only when nothing was charged. */
export async function post(preset: Preset, account: PrivateKeyAccount, maxPrice: bigint, brief: Brief, fetchImpl: typeof fetch = fetch): Promise<Posted> {
  let signed: { payload: unknown } | undefined;
  let price = maxPrice;
  let asked: bigint | undefined;
  const client = x402Client.fromConfig({
    schemes: [{ network: preset.network, client: new ExactEvmScheme(account) }],
    spendControls: { allowedAssets: [{ network: preset.network, asset: preset.asset, maxAmountPerPayment: maxPrice.toString() }] },
    policies: [
      (_version, requirements) =>
        requirements.filter((r) => r.network === preset.network && same(r.asset, preset.asset) && same(r.payTo, preset.payTo) && r.maxTimeoutSeconds <= MAX_TIMEOUT_SECONDS),
    ],
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    price = BigInt(selectedRequirements.amount);
  });
  client.onAfterPaymentCreation(async ({ paymentPayload }) => {
    signed = paymentPayload;
  });

  // The price is read off the 402 challenge: x402 refuses a price above max-price without saying what it was.
  const observed: typeof fetch = async (input, init) => {
    const reply = await fetchImpl(input, init);
    if (reply.status === 402) asked = challengePrice(reply, preset);
    return reply;
  };
  let response: Response;
  try {
    response = await wrapFetchWithPayment(observed, client)(`${preset.desk}/x402/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(brief),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    if (signed) return { order: orderId(signed), price, uncertain: true };
    const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
    // x402's own wording names its settings, not this action's inputs, so it goes to the debug log only.
    core.debug(`x402: ${message}`);
    const refused = refusal(message, preset, maxPrice, asked);
    if (refused) throw new Error(`${refused} Nothing was charged.`);
    throw new Error(`The payment could not be made: ${message.replace(/\.$/, "")}. Nothing was charged.`, { cause: error });
  }

  const reply = (await response.json().catch(() => ({}))) as { order?: unknown; error?: unknown };
  const order = typeof reply.order === "string" && /^0x[0-9a-f]{64}$/.test(reply.order) ? (reply.order as `0x${string}`) : undefined;
  if (response.ok && order) return { order, price, uncertain: false };
  // The desk answers 400 (a brief it refuses) and 402 (a payment it refuses)
  // before settling. Any other answer to a signed payment may have charged it,
  // so the order is followed, never paid for again.
  if (signed && response.status !== 400 && response.status !== 402) return { order: order ?? orderId(signed), price, uncertain: true };
  const error = typeof reply.error === "string" ? reply.error : undefined;
  // A brief within 32,000 characters can still pass 64,000 bytes once encoded: non-ASCII text and escapes grow it.
  if (response.status === 400 && error && /too large to post/i.test(error)) throw new Error("BrainChain refused the brief as too large to post: over 64,000 bytes as JSON. Nothing was charged.");
  throw new Error(`${error ?? `BrainChain answered ${response.status}.`} Nothing was charged.`);
}

/** The price in this preset's token among a desk offer's terms, as both the 402 challenge and GET /x402/tasks list them. */
function priceIn(offer: unknown, preset: Preset): bigint | undefined {
  const accepts = (offer as { accepts?: unknown } | null | undefined)?.accepts;
  if (!Array.isArray(accepts)) return undefined;
  const terms = (accepts as { network?: string; asset?: string; payTo?: string; amount?: unknown }[]).find(
    (a) => a.network === preset.network && same(a.asset ?? "", preset.asset) && same(a.payTo ?? "", preset.payTo),
  );
  return typeof terms?.amount === "string" && /^\d+$/.test(terms.amount) ? BigInt(terms.amount) : undefined;
}

function challengePrice(response: Response, preset: Preset): bigint | undefined {
  try {
    return priceIn(JSON.parse(Buffer.from(response.headers.get("payment-required") ?? "", "base64").toString("utf8")), preset);
  } catch {
    // An unreadable challenge only means the error cannot name the price.
    return undefined;
  }
}

/** The desk's price in this preset's token, read without paying, or undefined when it cannot be read. */
export async function quote(preset: Preset, fetchImpl: typeof fetch = fetch): Promise<bigint | undefined> {
  try {
    const response = await fetchImpl(`${preset.desk}/x402/tasks`, { signal: AbortSignal.timeout(15_000) });
    return response.ok ? priceIn(await response.json(), preset) : undefined;
  } catch {
    // Without a quote, x402 still refuses a price above max-price; only the early refusal is lost.
    return undefined;
  }
}

export const overPrice = (preset: Preset, asked: bigint, maxPrice: bigint) =>
  `BrainChain charges ${amount(asked)} ${preset.token} per review, above max-price ${amount(maxPrice)}. Set max-price to at least ${amount(asked)}.`;

/** Why x402 refused to pay, in this action's terms; undefined for any other error. */
function refusal(message: string, preset: Preset, maxPrice: bigint, asked?: bigint): string | undefined {
  if (asked !== undefined && asked > maxPrice) return overPrice(preset, asked, maxPrice);
  if (/rejected by spendControls.*maxAmountPerPayment/.test(message)) return `BrainChain charges more per review than max-price ${amount(maxPrice)}. Raise max-price.`;
  if (/rejected by spendControls|filtered out by policies|No network\/scheme registered/.test(message)) return `BrainChain did not offer ${preset.token} on ${preset.chain} on the terms this action accepts.`;
  return undefined;
}

/** The desk names an order after the hash of the signed payment: sorted keys, no whitespace. */
export function orderId(payment: { payload: unknown }): `0x${string}` {
  return keccak256(toBytes(canonical(payment.payload)));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`)
    .join(",")}}`;
}

export type Outcome =
  | { kind: "accepted"; taskId?: string; review: string }
  | { kind: "rejected"; taskId?: string }
  | { kind: "refund-failed"; taskId?: string }
  | { kind: "failed"; reason: string }
  | { kind: "waiting"; taskId?: string; state: string };

interface OrderView {
  state?: string;
  taskId?: string;
  task?: { status?: string; accepted?: boolean };
  result?: string;
}

export async function check(preset: Preset, order: string, fetchImpl: typeof fetch = fetch): Promise<Outcome> {
  const response = await fetchImpl(`${preset.desk}/x402/tasks/${order}`, { signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return { kind: "waiting", state: "unknown" };
  if (!response.ok) return { kind: "waiting", state: `http ${response.status}` };
  const view = (await response.json()) as OrderView;
  const taskId = view.taskId;
  if (view.state === "failed") return { kind: "failed", reason: "The payment did not settle. Nothing was charged." };
  if (view.state === "refund-failed") return { kind: "refund-failed", ...(taskId ? { taskId } : {}) };
  if (view.state === "refunding" || view.state === "refunded" || view.task?.accepted === false) return { kind: "rejected", ...(taskId ? { taskId } : {}) };
  // Only an explicit accept counts, and results are served by the desk itself; any other link is ignored.
  if (view.task?.accepted === true && view.result?.startsWith(`${preset.desk}/records/`)) {
    const text = await fetchImpl(view.result, { signal: AbortSignal.timeout(20_000) });
    if (text.ok) return { kind: "accepted", ...(taskId ? { taskId } : {}), review: await text.text() };
  }
  return { kind: "waiting", ...(taskId ? { taskId } : {}), state: view.task?.status ?? view.state ?? "unknown" };
}

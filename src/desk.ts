import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { keccak256, toBytes, type PrivateKeyAccount } from "viem";

import type { Preset } from "./presets.js";

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

  let response: Response;
  try {
    response = await wrapFetchWithPayment(fetchImpl, client)(`${preset.desk}/x402/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(brief),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    if (signed) return { order: orderId(signed), price, uncertain: true };
    throw new Error(`${explain(error, preset)} Nothing was charged.`, { cause: error });
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
  if (response.status === 400 && error && /too large to post/i.test(error)) throw new Error("The desk refused the brief as too large to post: over 64,000 bytes as JSON. Nothing was charged.");
  throw new Error(`${error ?? `The desk answered ${response.status}.`} Nothing was charged.`);
}

function explain(error: unknown, preset: Preset): string {
  const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
  if (/rejected by spendControls/.test(message)) return `The desk asked more than max-price, or in a token other than ${preset.token}.`;
  if (/filtered out by policies|No network\/scheme registered/.test(message)) return `The desk did not offer ${preset.token} on ${preset.chain} on the terms this action accepts.`;
  return `The payment could not be made: ${message}.`;
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

/** Reads an order once and says where it stands. */
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

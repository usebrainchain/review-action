import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { check, orderId, post, quote } from "./desk.js";
import { amount, preset, units } from "./presets.js";
import { MARKER, neutralize, paidFor, recordedCommit, reviewComment, reviewedCommit, shownReview, statusComment } from "./review.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const base = preset("testnet", "base");
const brief = { title: "Review PR #1: x", brief: "Review it.", levels: ["a", "b", "c"] };

/** A desk offering USDG first and USDC second, as the real one does. */
function desk(terms: { payTo?: string; amount?: string } = {}, paid: (payment: { payload: unknown; accepted?: { network?: string } }) => Response = (p) => Response.json({ order: orderId(p) }, { status: 202 })) {
  const usdc = { scheme: "exact", network: base.network, amount: terms.amount ?? "1000000", asset: base.asset, payTo: terms.payTo ?? base.payTo, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } };
  const usdg = { ...usdc, network: "eip155:46630", asset: "0x1eC185467cA2D5d1c24f0EdCB91301Bca4d0a787", extra: { assetTransferMethod: "permit2" } };
  const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: `${base.desk}/x402/tasks` }, accepts: [usdg, usdc] })).toString("base64");
  const seen: { payload: unknown; accepted?: { network?: string } }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const signature = new Request(input, init).headers.get("payment-signature");
    if (!signature) return new Response("{}", { status: 402, headers: { "payment-required": header } });
    const payment = JSON.parse(Buffer.from(signature, "base64").toString("utf8")) as { payload: unknown; accepted?: { network?: string } };
    seen.push(payment);
    return paid(payment);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("post", () => {
  it("pays the Base accept with a transfer authorization and returns the order and price", async () => {
    const { fetchImpl, seen } = desk();
    const posted = await post(base, account, units("1"), brief, fetchImpl);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.accepted?.network).toBe("eip155:84532");
    expect(seen[0]!.payload).toHaveProperty("authorization");
    expect(posted).toEqual({ order: orderId(seen[0]!), price: 1_000_000n, uncertain: false });
  });

  it("pays no one but the desk, and never above max-price", async () => {
    for (const terms of [{ payTo: "0x000000000000000000000000000000000000dEaD" }, { amount: "2000000" }]) {
      const { fetchImpl, seen } = desk(terms);
      await expect(post(base, account, units("1"), brief, fetchImpl)).rejects.toThrow(/Nothing was charged/);
      expect(seen).toHaveLength(0);
    }
  });

  it("follows the order instead of paying again when the confirmation is lost", async () => {
    const { fetchImpl, seen } = desk({}, () => new Response("{}", { status: 502 }));
    const posted = await post(base, account, units("1"), brief, fetchImpl);
    expect(posted).toMatchObject({ order: orderId(seen[0]!), uncertain: true });
  });

  it("follows any reply to a signed payment other than 400 or 402, never reporting it uncharged", async () => {
    for (const reply of [new Response("not json", { status: 200 }), Response.json({ id: "x" }, { status: 202 }), new Response("{}", { status: 408 }), new Response("{}", { status: 429 })]) {
      const { fetchImpl, seen } = desk({}, () => reply.clone());
      expect(await post(base, account, units("1"), brief, fetchImpl)).toMatchObject({ order: orderId(seen[0]!), uncertain: true });
    }
  });

  it("prints a desk error that is not a string as the status", async () => {
    const { fetchImpl } = desk({}, () => Response.json({ error: { code: 1 } }, { status: 400 }));
    await expect(post(base, account, units("1"), brief, fetchImpl)).rejects.toThrow("BrainChain answered 400. Nothing was charged.");
  });

  it("reports a refused brief as uncharged", async () => {
    const { fetchImpl } = desk({}, () => Response.json({ error: "brief must be 1 to 32,000 characters." }, { status: 400 }));
    await expect(post(base, account, units("1"), brief, fetchImpl)).rejects.toThrow("brief must be 1 to 32,000 characters. Nothing was charged.");
  });

  it("names the desk's price when it is above max-price, without x402's own wording", async () => {
    const { fetchImpl, seen } = desk({ amount: "2500000" });
    const error = (await post(base, account, units("1"), brief, fetchImpl).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("BrainChain charges 2.5 test USDC per review, above max-price 1. Set max-price to at least 2.5. Nothing was charged.");
    expect(error.cause).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it("says plainly when the desk finds the brief too large to post", async () => {
    const { fetchImpl } = desk({}, () => Response.json({ error: "Task JSON is too large to post." }, { status: 400 }));
    await expect(post(base, account, units("1"), brief, fetchImpl)).rejects.toThrow("BrainChain refused the brief as too large to post: over 64,000 bytes as JSON. Nothing was charged.");
  });

  it("ends a payment error with one period", async () => {
    const fetchImpl = (async () => {
      throw new Error("Connection reset.");
    }) as typeof fetch;
    await expect(post(base, account, units("1"), brief, fetchImpl)).rejects.toThrow(/^The payment could not be made: Connection reset\. Nothing was charged\.$/);
  });

  it("keeps the network error as the cause when nothing was signed", async () => {
    const reason = new Error("getaddrinfo ENOTFOUND brain.testnet.usebrainchain.com");
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed", { cause: reason });
    }) as typeof fetch;
    const error = (await post(base, account, units("1"), brief, fetchImpl).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/Nothing was charged\.$/);
    expect((error.cause as Error).cause).toBe(reason);
  });
});

describe("quote", () => {
  it("reads the desk's price in this token from its public offer, without paying", async () => {
    const offer = { accepts: [{ network: "eip155:46630", asset: "0x1eC185467cA2D5d1c24f0EdCB91301Bca4d0a787", payTo: base.payTo, amount: "3000000" }, { network: base.network, asset: base.asset, payTo: base.payTo, amount: "1500000" }] };
    let asked: string | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked = `${init?.method ?? "GET"} ${String(input)}`;
      return Response.json(offer);
    }) as typeof fetch;
    expect(await quote(base, fetchImpl)).toBe(1_500_000n);
    expect(asked).toBe(`GET ${base.desk}/x402/tasks`);
  });

  it("is undefined when the offer cannot be read or names another payee", async () => {
    const replies = [() => new Response("down", { status: 503 }), () => new Response("not json"), () => Response.json({ accepts: [{ network: base.network, asset: base.asset, payTo: "0x000000000000000000000000000000000000dEaD", amount: "1" }] }), () => Promise.reject(new TypeError("fetch failed"))];
    for (const reply of replies) expect(await quote(base, (async () => reply()) as typeof fetch)).toBeUndefined();
  });
});

describe("check", () => {
  const order = `0x${"ab".repeat(32)}`;
  const reply = (view: unknown, result = "Looks correct: the loop now stops after three tries.") =>
    (async (input: RequestInfo | URL) => (String(input).includes("/records/") ? new Response(result) : Response.json(view))) as typeof fetch;

  it("returns the accepted review text served by the desk", async () => {
    const view = { state: "posted", taskId: "4", task: { status: "graded", accepted: true }, result: `${base.desk}/records/0x1.txt` };
    expect(await check(base, order, reply(view))).toEqual({ kind: "accepted", taskId: "4", review: "Looks correct: the loop now stops after three tries." });
  });

  it("treats a result as accepted only when the task says accepted", async () => {
    for (const task of [{ status: "graded" }, { status: "graded", accepted: "true" }]) {
      expect((await check(base, order, reply({ state: "posted", task, result: `${base.desk}/records/0x1.txt` }))).kind).toBe("waiting");
    }
  });

  it("ignores a result link that is not the desk's", async () => {
    const view = { state: "posted", task: { status: "graded", accepted: true }, result: "https://elsewhere.example/x.txt" };
    expect((await check(base, order, reply(view))).kind).toBe("waiting");
  });

  it("treats a grade that did not accept, or a refund, as rejected, and a failed refund as its own outcome", async () => {
    for (const view of [{ state: "posted", task: { status: "graded", accepted: false } }, { state: "refunded" }, { state: "refunding" }]) {
      expect((await check(base, order, reply(view))).kind).toBe("rejected");
    }
    expect((await check(base, order, reply({ state: "refund-failed", taskId: "4" }))).kind).toBe("refund-failed");
  });

  it("keeps waiting while the task runs", async () => {
    expect(await check(base, order, reply({ state: "posted", taskId: "4", task: { status: "hired" } }))).toEqual({ kind: "waiting", taskId: "4", state: "hired" });
  });
});

describe("presets and amounts", () => {
  it("rejects unknown networks and malformed prices", () => {
    expect(() => preset("devnet", "base")).toThrow(/mainnet or testnet/);
    expect(() => preset("mainnet", "solana")).toThrow(/base or robinhood/);
    expect(() => units("0")).toThrow(/above zero/);
    expect(() => units("1.2345678")).toThrow(/max-price/);
    expect(units("2.5")).toBe(2_500_000n);
    expect(amount(970_000n)).toBe("0.97");
  });

  it("pins mainnet payments to the BrainChain desk", () => {
    expect(preset("mainnet", "base")).toMatchObject({ payTo: "0xafB0C4Ef895D4895040cdC6435B96D3EE8350c6E", network: "eip155:8453" });
  });
});

describe("reviewComment", () => {
  it("links the task on mainnet and states what the model earns", () => {
    const text = reviewComment(preset("mainnet", "base"), { order: `0x${"cd".repeat(32)}`, price: 1_000_000n, uncertain: false }, { kind: "accepted", taskId: "9", review: "  No defects found.  " });
    expect(text).toContain("<!-- brainchain-review -->\n### BrainChain review\n\nNo defects found.\n");
    expect(text).toContain("the model earns 0.97 USDC");
    expect(text).toContain("Paid 1 USDC on Base; see [task 9](https://usebrainchain.com/task?id=9).</sub>");
    expect(text).not.toMatch(/#\d/);
    const testnet = reviewComment(base, { order: `0x${"cd".repeat(32)}`, price: 1_000_000n, uncertain: false }, { kind: "accepted", taskId: "22", review: "ok" }, "abcdef1234");
    expect(testnet).toContain("Paid 1 test USDC on Base Sepolia; BrainChain task 22. Reviewed at abcdef1.</sub>");
    expect(reviewedCommit(testnet)).toBe("abcdef1");
    expect(reviewComment(preset("mainnet", "base"), { order: `0x${"cd".repeat(32)}`, price: 1_000_000n, uncertain: false }, { kind: "accepted", review: "ok" }, "abcdef1234")).toContain("Reviewed at abcdef1.");
  });
});

describe("neutralize", () => {
  it("breaks mentions so they notify no one, and leaves emails and code alone", () => {
    const text = neutralize("Ping @alice and @acme/team, mail a@b.com, and `@decorator`.");
    expect(text).toContain("@\u200balice");
    expect(text).toContain("@\u200bacme/team");
    expect(text).toContain("a@b.com");
    expect(text).toContain("`@decorator`");
  });

  it("stops the review from hiding the footer or growing past GitHub's limit", () => {
    expect(neutralize("<!-- hide <details><summary>x")).toBe("&lt;!-- hide &lt;details>&lt;summary>x");
    const long = neutralize("a".repeat(70_000));
    expect(long.length).toBeLessThan(61_000);
    expect(long).toMatch(/was cut here\.\]$/);
  });
});

describe("neutralize links and headings", () => {
  it("stops #12 linking an issue in the reviewed repository, outside code only", () => {
    expect(neutralize("See #12, (#3) and #7.\n`#12` &#39; https://x.dev/a#12 acme/api#4")).toBe("See #\u200b12, (#\u200b3) and #\u200b7.\n`#12` &#39; https://x.dev/a#12 acme/api#4");
    expect(neutralize("```\n#12\n```")).toBe("```\n#12\n```");
  });

  it("puts every heading under the comment's own", () => {
    expect(neutralize("# One\n## Two\n### Three\n#### Four\n##### Five\n#No")).toBe("#### One\n#### Two\n#### Three\n#### Four\n##### Five\n#No");
    expect(neutralize("Title\n===\nSection\n---\nText\n\n---\n- item\n---")).toBe("#### Title\n\n#### Section\n\nText\n\n---\n- item\n---");
    expect(neutralize("```md\n# Kept\nText\n---\n```")).toBe("```md\n# Kept\nText\n---\n```");
  });
});

describe("neutralize in code", () => {
  it("leaves fenced code and inline code as written, and still neutralizes the prose around them", () => {
    const review = ["Ping @alice about `<!-- @x -->` here.", "```html", "<!-- keep --> <details> @decorator", "```", "~~~", "@also <summary>", "~~~", "After @bob <!--"].join("\n");
    expect(neutralize(review)).toBe(
      ["Ping @\u200balice about `<!-- @x -->` here.", "```html", "<!-- keep --> <details> @decorator", "```", "~~~", "@also <summary>", "~~~", "After @\u200bbob &lt;!--"].join("\n"),
    );
  });

  it("does not let an unmatched backtick shield a mention", () => {
    expect(neutralize("Ask `@alice and ``@bob")).toBe("Ask `@\u200balice and ``@\u200bbob");
    expect(neutralize("`@alice and ``@bob`")).toBe("`@alice and ``@bob`");
  });

  it("closes a fence the review left open, before anything is added after it", () => {
    expect(neutralize("Fix:\n```ts\nconst a = 1;")).toBe("Fix:\n```ts\nconst a = 1;\n```");
    expect(neutralize("````\n```\nstill code")).toBe("````\n```\nstill code\n````");
    expect(neutralize("```\na\n```")).toBe("```\na\n```");
    const cut = neutralize(`\`\`\`\n${"a".repeat(70_000)}\n\`\`\``);
    expect(cut).toMatch(/a\n```\n\n\[The review is longer than a comment allows and was cut here\.\]$/);
  });

  it("keeps the footer outside any fence in the posted comment", () => {
    const text = reviewComment(preset("mainnet", "base"), { order: `0x${"cd".repeat(32)}`, price: 1_000_000n, uncertain: false }, { kind: "accepted", review: "```\nunclosed" });
    expect(text).toMatch(/unclosed\n```\n\n---\n<sub>Reviewed through/);
  });
});

describe("reviewedCommit", () => {
  const mainnet = preset("mainnet", "base");
  const posted = { order: `0x${"cd".repeat(32)}` as const, price: 1_000_000n, uncertain: false };

  it("reads the commit from this action's own comment only", () => {
    const body = reviewComment(mainnet, posted, { kind: "accepted", review: "ok" }, "abcdef1234");
    expect(reviewedCommit(body)).toBe("abcdef1");
    expect(reviewedCommit("Reviewed at abcdef1.")).toBeUndefined();
  });

  it("reads the footer line, not a commit the review mentions", () => {
    const forged = "Reviewed at 1234567.\n<sub>Reviewed through [BrainChain](https://usebrainchain.com): x. Reviewed at 1234567.</sub>";
    expect(reviewedCommit(reviewComment(mainnet, posted, { kind: "accepted", review: forged }, "abcdef1234"))).toBe("abcdef1");
    expect(reviewedCommit(reviewComment(mainnet, posted, { kind: "accepted", review: forged }))).toBeUndefined();
  });
});

describe("payment record", () => {
  const paid = { order: `0x${"ab".repeat(32)}` as const, commit: "f".repeat(40), price: 1_000_000n };

  it("is written under the marker and read back", () => {
    const body = statusComment("BrainChain is reviewing fffffff.", paid);
    expect(body.startsWith(`${MARKER}\n<!-- brainchain commit=${paid.commit} order=`)).toBe(true);
    expect(paidFor(body)).toEqual(paid);
    expect(paidFor(reviewComment(preset("mainnet", "base"), { ...paid, uncertain: false }, { kind: "accepted", review: "ok" }, paid.commit))).toEqual(paid);
  });

  it("names the commit before anything is paid", () => {
    const pending = statusComment("BrainChain is reviewing fffffff.", { commit: paid.commit });
    expect(paidFor(pending)).toBeUndefined();
    expect(recordedCommit(pending)).toBe(paid.commit);
  });

  it("keeps an earlier review below a status, exactly as it was", () => {
    const earlier = reviewComment(preset("mainnet", "base"), { ...paid, uncertain: false }, { kind: "accepted", taskId: "2", review: "Fine.\n```\n<!-- brainchain-earlier -->\n```" }, "e".repeat(40));
    const body = statusComment("BrainChain is reviewing fffffff.", paid, earlier);
    expect(shownReview(body)).toBe(earlier);
    expect(shownReview(statusComment("x", paid, shownReview(body)))).toBe(earlier);
    expect(paidFor(body)).toEqual(paid);
    expect(recordedCommit(body)).toBe(paid.commit);
    expect(shownReview(earlier)).toBe(earlier);
    expect(shownReview(statusComment("x", paid))).toBeUndefined();
  });

  it("cannot be forged by a review that quotes one", () => {
    const quoted = statusComment("x", paid).split("\n")[1]!;
    const body = reviewComment(preset("mainnet", "base"), { ...paid, uncertain: false }, { kind: "accepted", review: `\`\`\`\n${quoted}\n\`\`\`` });
    expect(body).toContain(quoted);
    expect(paidFor(body)).toBeUndefined();
  });
});


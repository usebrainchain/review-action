import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { failure, run } from "./main.js";
import { paidFor, statusComment } from "./review.js";

const state = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  log: [] as string[],
  notices: [] as string[],
  warnings: [] as string[],
  outputs: {} as Record<string, string>,
  reads: {} as Record<string, bigint | Error>,
}));
const desk = vi.hoisted(() => ({ post: vi.fn(), check: vi.fn() }));

vi.mock("@actions/core", () => ({
  getInput: (name: string) => state.inputs[name] ?? "",
  getBooleanInput: (name: string) => state.inputs[name] === "true",
  setSecret: () => undefined,
  info: () => undefined,
  notice: (message: string) => state.notices.push(message),
  warning: (message: string) => state.warnings.push(message),
  setOutput: (name: string, value: string) => {
    state.outputs[name] = value;
    state.log.push(`output ${name}=${value}`);
  },
  setFailed: (message: string) => {
    throw new Error(message);
  },
  summary: {
    addRaw() {
      return this;
    },
    write: async () => undefined,
  },
}));
vi.mock("./desk.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./desk.js")>()), post: desk.post, check: desk.check }));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      state.log.push(`read ${functionName}`);
      const value = state.reads[functionName];
      if (value instanceof Error) throw value;
      return value;
    },
  }),
}));

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SHA = "a".repeat(40);
const ORDER = `0x${"ab".repeat(32)}` as const;
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const PAID = { order: ORDER, commit: SHA, price: 1_000_000n };

/** A pull request's comments and state, served the way GitHub's REST API serves them. */
let gh: {
  login?: string;
  comments: { id: number; body: string; login: string }[];
  pr: { state: string; head: { sha: string } };
  diff: string | number;
  postStatus?: number;
};

const visible = (body: string) => body.split("\n").find((line) => !line.startsWith("<!--"));

function stubGitHub() {
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const { pathname } = new URL(input);
    const method = init.method ?? "GET";
    const write = (c: { id: number; body: string }) => Response.json({ id: c.id, body: c.body, html_url: `https://gh/c/${c.id}` });
    if (pathname === "/user") return gh.login ? Response.json({ login: gh.login }) : new Response("Resource not accessible by integration", { status: 403 });
    if (pathname === "/repos/acme/api/pulls/3") {
      if (new Headers(init.headers).get("accept") !== "application/vnd.github.diff") return Response.json(gh.pr);
      return typeof gh.diff === "number" ? new Response("{}", { status: gh.diff }) : new Response(gh.diff);
    }
    if (pathname === "/repos/acme/api/issues/3/comments" && method === "GET") {
      return Response.json(gh.comments.map((c) => ({ id: c.id, body: c.body, html_url: `https://gh/c/${c.id}`, user: { login: c.login, type: c.login.endsWith("[bot]") ? "Bot" : "User" } })));
    }
    if (pathname === "/repos/acme/api/issues/3/comments" && method === "POST") {
      if (gh.postStatus) return new Response("Resource not accessible by integration", { status: gh.postStatus });
      const c = { id: 100 + gh.comments.length, body: (JSON.parse(String(init.body)) as { body: string }).body, login: gh.login ?? "github-actions[bot]" };
      gh.comments.push(c);
      state.log.push(`post ${visible(c.body)}`);
      return write(c);
    }
    const edited = gh.comments.find((c) => pathname === `/repos/acme/api/issues/comments/${c.id}`);
    if (edited && method === "PATCH") {
      edited.body = (JSON.parse(String(init.body)) as { body: string }).body;
      state.log.push(`edit ${visible(edited.body)}`);
      return write(edited);
    }
    return new Response("unexpected", { status: 500 });
  });
}

function event(pr: Record<string, unknown> = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "review-action-")), "event.json");
  const base = { number: 3, title: "Fix the retry loop", body: null, user: { login: "dev", type: "User" }, head: { sha: SHA, repo: { full_name: "acme/api" } }, base: { repo: { full_name: "acme/api" } } };
  writeFileSync(path, JSON.stringify({ pull_request: { ...base, ...pr } }));
  vi.stubEnv("GITHUB_EVENT_PATH", path);
  vi.stubEnv("GITHUB_EVENT_NAME", "pull_request");
}

/** Runs the action to the end, moving the clock past each 15-second wait. */
async function go(): Promise<void> {
  const end: { done?: boolean; error?: unknown } = {};
  void run().then(
    () => (end.done = true),
    (error: unknown) => Object.assign(end, { done: true, error }),
  );
  for (let i = 0; !end.done && i < 100; i++) {
    await vi.advanceTimersByTimeAsync(15_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!end.done) throw new Error("run did not finish");
  if (end.error) throw end.error;
}

beforeEach(() => {
  Object.assign(state, { inputs: { "payer-key": KEY, "github-token": "t", "wait-minutes": "1", network: "testnet" }, log: [], notices: [], warnings: [], outputs: {}, reads: { balanceOf: 5_000_000n, allowance: 0n } });
  gh = { comments: [], pr: { state: "open", head: { sha: SHA } }, diff: DIFF };
  desk.post.mockReset().mockImplementation(async () => {
    state.log.push("pay");
    return { order: ORDER, price: 1_000_000n, uncertain: false };
  });
  desk.check.mockReset().mockResolvedValue({ kind: "accepted", taskId: "4", review: "Looks correct." });
  event();
  stubGitHub();
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("paying once per commit", () => {
  it("comments before paying, records the order and commit once paid, and sets accepted after the review is posted", async () => {
    await go();
    expect(state.log).toEqual([
      "read balanceOf",
      "post BrainChain is reviewing aaaaaaa.",
      "pay",
      `output order=${ORDER}`,
      `edit BrainChain is reviewing aaaaaaa (order \`${ORDER}\`). The review replaces this comment if Jev accepts it; if not, the payment is refunded.`,
      "output task-id=4",
      "edit ### BrainChain review",
      "output accepted=true",
    ]);
    expect(gh.comments).toHaveLength(1);
    expect(paidFor(gh.comments[0]!.body)).toEqual(PAID);
  });

  it("follows the recorded order on a re-run and pays nothing", async () => {
    gh.comments = [{ id: 1, login: "github-actions[bot]", body: statusComment("BrainChain is reviewing aaaaaaa.", PAID) }];
    desk.check.mockResolvedValue({ kind: "rejected", taskId: "4" });
    await go();
    expect(desk.post).not.toHaveBeenCalled();
    expect(desk.check).toHaveBeenCalledWith(expect.anything(), ORDER);
    expect(state.log).toEqual([`output order=${ORDER}`, "output task-id=4", "edit Jev did not accept BrainChain's review of aaaaaaa, so it is not posted and the payment is refunded.", "output accepted=false"]);
    expect(paidFor(gh.comments[0]!.body)).toEqual(PAID);
    expect(state.notices[0]).toMatch(/the 1 test USDC is refunded/);
  });

  it.each([
    { token: "github-actions[bot]", author: "mallory", pays: true },
    { token: "github-actions[bot]", author: "github-actions[bot]", pays: false },
    { token: "github-actions[bot]", author: "acme-reviews[bot]", pays: false },
    { token: "octo", author: "github-actions[bot]", pays: true },
    { token: "octo", author: "octo", pays: false },
  ])("trusts a record only from its own identity (token $token, written by $author)", async ({ token, author, pays }) => {
    if (token !== "github-actions[bot]") gh.login = token;
    gh.comments = [{ id: 1, login: author, body: statusComment("BrainChain is reviewing aaaaaaa.", PAID) }];
    await go();
    expect(desk.post).toHaveBeenCalledTimes(pays ? 1 : 0);
  });

  it("pays for a new commit even when an older one is recorded", async () => {
    gh.comments = [{ id: 1, login: "github-actions[bot]", body: statusComment("BrainChain is reviewing bbbbbbb.", { ...PAID, commit: "b".repeat(40) }) }];
    await go();
    expect(desk.post).toHaveBeenCalledTimes(1);
    expect(paidFor(gh.comments[0]!.body)?.commit).toBe(SHA);
  });

  it("pays nothing when it cannot comment", async () => {
    gh.postStatus = 403;
    await expect(go()).rejects.toThrow(/Could not comment on the pull request, so no review was paid for\. The github-token needs pull-requests: write\./);
    expect(desk.post).not.toHaveBeenCalled();
  });

  it("says nothing was charged when the payment is not made", async () => {
    desk.post.mockRejectedValue(new Error("The desk answered 402. Nothing was charged."));
    await expect(go()).rejects.toThrow("The desk answered 402. Nothing was charged.");
    expect(state.log.at(-1)).toBe("edit BrainChain did not review aaaaaaa: the payment was not made, so nothing was charged.");
  });

  it("drops the record when the payment did not settle, so a re-run pays anew", async () => {
    desk.check.mockResolvedValue({ kind: "failed", reason: "The payment did not settle. Nothing was charged." });
    await expect(go()).rejects.toThrow("The payment did not settle.");
    expect(paidFor(gh.comments[0]!.body)).toBeUndefined();
  });

  it("leaves accepted empty and the record in place when the job stops waiting", async () => {
    desk.check.mockResolvedValue({ kind: "waiting", state: "hired" });
    await go();
    expect(state.outputs.accepted).toBeUndefined();
    expect(state.warnings.at(-1)).toMatch(/^No graded review within 1 minutes/);
    expect(paidFor(gh.comments[0]!.body)).toEqual(PAID);
  });
});

describe("skipping without payment", () => {
  it("skips bot pull requests unless review-bots is true", async () => {
    event({ user: { login: "dependabot[bot]", type: "Bot" } });
    await go();
    expect(state.notices).toEqual(["Pull request opened by dependabot[bot]: no review was paid for. Set review-bots to true to review these."]);
    expect(desk.post).not.toHaveBeenCalled();
    state.inputs["review-bots"] = "true";
    await go();
    expect(desk.post).toHaveBeenCalledTimes(1);
  });

  it("skips a diff with nothing to review, before reading the balance", async () => {
    gh.diff = "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n";
    await go();
    expect(state.notices).toEqual(["The diff changes no lines outside lockfiles, build output and binary files: no review was paid for."]);
    expect(state.log).toEqual([]);
  });

  it("skips a pull request too large for GitHub's diff", async () => {
    gh.diff = 406;
    await go();
    expect(state.notices[0]).toMatch(/over 300 files or 20,000 lines, so no review was paid for/);
    expect(state.log).toEqual([]);
  });

  it("skips a closed pull request, and one that has moved past the event's commit", async () => {
    gh.pr = { state: "closed", head: { sha: SHA } };
    await go();
    gh.pr = { state: "open", head: { sha: "b".repeat(40) } };
    await go();
    expect(state.notices).toEqual(["The pull request is closed: no review was paid for.", "The pull request has moved on from aaaaaaa to bbbbbbb: no review was paid for aaaaaaa."]);
    expect(state.log).toEqual([]);
  });
});

describe("funds", () => {
  it("pays with a warning when the balance cannot be read", async () => {
    state.reads.balanceOf = new Error("HTTP request failed.\n\nURL: https://sepolia.base.org", { cause: new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND sepolia.base.org") }) });
    await go();
    expect(state.warnings).toEqual(["Could not read the paying wallet's test USDC balance on Base Sepolia, so paying without that check: HTTP request failed. (getaddrinfo ENOTFOUND sepolia.base.org)"]);
    expect(desk.post).toHaveBeenCalledTimes(1);
  });

  it("fails before paying a wallet that holds less than max-price", async () => {
    state.reads.balanceOf = 500_000n;
    await expect(go()).rejects.toThrow(/holds 0\.5 test USDC on Base Sepolia; a review costs up to 1\. Nothing was charged\./);
    expect(desk.post).not.toHaveBeenCalled();
  });

  it("on Robinhood Chain, fails before paying until Permit2 is approved for max-price", async () => {
    state.inputs["pay-on"] = "robinhood";
    await expect(go()).rejects.toThrow(/lets Permit2 spend 0 test USDG.*call approve\(0x000000000022D473030F116dDEE9F6B43aC78BA3, amount\) on the test USDG contract/);
    expect(desk.post).not.toHaveBeenCalled();
    expect(gh.comments).toEqual([]);
    state.reads.allowance = 2n ** 256n - 1n;
    await go();
    expect(desk.post).toHaveBeenCalledTimes(1);
  });
});

describe("failure", () => {
  it("adds the root cause a fetch error hides", () => {
    const error = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
    expect(failure(error)).toBe("fetch failed (getaddrinfo ENOTFOUND api.github.com)");
    expect(failure(new Error("GitHub answered 403 for /x"))).toBe("GitHub answered 403 for /x");
    const refused = new AggregateError([new Error("connect ECONNREFUSED 10.0.0.1:443")], "");
    expect(failure(new TypeError("fetch failed", { cause: refused }))).toBe("fetch failed (Error: connect ECONNREFUSED 10.0.0.1:443)");
  });
});

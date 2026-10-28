import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { failure, run } from "./main.js";
import { preset } from "./presets.js";
import { paidFor, reviewComment, shownReview, statusComment } from "./review.js";

const state = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  log: [] as string[],
  infos: [] as string[],
  notices: [] as string[],
  warnings: [] as string[],
  outputs: {} as Record<string, string>,
  reads: {} as Record<string, bigint | Error>,
  summary: [] as string[],
}));
const desk = vi.hoisted(() => ({ post: vi.fn(), check: vi.fn(), quote: vi.fn() }));

vi.mock("@actions/core", () => ({
  getInput: (name: string) => state.inputs[name] ?? "",
  getBooleanInput: (name: string) => state.inputs[name] === "true",
  setSecret: () => undefined,
  info: (message: string) => state.infos.push(message),
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
    addRaw(body: string) {
      state.summary.push(body);
      return this;
    },
    write: async () => undefined,
  },
}));
vi.mock("./desk.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./desk.js")>()), post: desk.post, check: desk.check, quote: desk.quote }));
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
  /** Files at the head commit, served by the contents API. */
  files: Record<string, string>;
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
    if (pathname.startsWith("/repos/acme/api/contents/")) {
      const file = gh.files[decodeURIComponent(pathname.slice("/repos/acme/api/contents/".length))];
      return file === undefined ? new Response("Not Found", { status: 404 }) : new Response(file);
    }
    const edited = gh.comments.find((c) => pathname === `/repos/acme/api/issues/comments/${c.id}`);
    if (edited && method === "PATCH") {
      edited.body = (JSON.parse(String(init.body)) as { body: string }).body;
      state.log.push(`edit ${visible(edited.body)}`);
      return write(edited);
    }
    if (edited && method === "DELETE") {
      gh.comments = gh.comments.filter((c) => c !== edited);
      state.log.push(`delete ${edited.id}`);
      return new Response(null, { status: 204 });
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
  Object.assign(state, {
    inputs: { "payer-key": KEY, "github-token": "t", "wait-minutes": "1", network: "testnet" },
    log: [],
    infos: [],
    notices: [],
    warnings: [],
    outputs: {},
    reads: { balanceOf: 5_000_000n, allowance: 0n },
    summary: [],
  });
  gh = { comments: [], pr: { state: "open", head: { sha: SHA } }, diff: DIFF, files: {} };
  desk.post.mockReset().mockImplementation(async () => {
    state.log.push("pay");
    return { order: ORDER, price: 1_000_000n, uncertain: false };
  });
  desk.check.mockReset().mockResolvedValue({ kind: "accepted", taskId: "4", review: "Looks correct." });
  desk.quote.mockReset().mockResolvedValue(1_000_000n);
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
      `edit BrainChain is reviewing aaaaaaa (order \`${ORDER}\`). The review replaces this comment if Jev accepts it; if not, the payment will be refunded.`,
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
    expect(state.log).toEqual([`output order=${ORDER}`, "output task-id=4", "edit Jev did not accept the review of aaaaaaa, so it is not posted and the payment is being refunded.", "output accepted=false"]);
    expect(paidFor(gh.comments[0]!.body)).toEqual(PAID);
    expect(state.notices[0]).toMatch(/the 1 test USDC is being refunded/);
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

  it("refuses a price above max-price before writing any comment", async () => {
    desk.quote.mockResolvedValue(2_000_000n);
    await expect(go()).rejects.toThrow(/^BrainChain charges 2 test USDC per review, above max-price 1\. Set max-price to at least 2\. Nothing was charged\.$/);
    expect(gh.comments).toEqual([]);
    expect(desk.post).not.toHaveBeenCalled();
    desk.quote.mockResolvedValue(undefined);
    await go();
    expect(desk.post).toHaveBeenCalledTimes(1);
  });

  it("pays nothing for a commit that already has a review, and says where it is", async () => {
    gh.comments = [{ id: 1, login: "github-actions[bot]", body: reviewComment(preset("testnet", "base"), { order: ORDER, price: 1_000_000n, uncertain: false }, { kind: "accepted", review: "ok" }, SHA) }];
    await go();
    expect(state.notices).toEqual(["This commit (aaaaaaa) already has a BrainChain review: no review was paid for. https://gh/c/1"]);
    expect(state.outputs).toEqual({ order: ORDER, accepted: "true" });
    expect(desk.post).not.toHaveBeenCalled();
  });

  it("logs where the task stands without repeating the word task", async () => {
    desk.check.mockResolvedValueOnce({ kind: "waiting", state: "posted", taskId: "22" }).mockResolvedValueOnce({ kind: "waiting", state: "hired", taskId: "22" });
    await go();
    expect(state.infos).toContain("Task 22 is on BrainChain; Jev is hiring a model.");
    expect(state.infos).toContain("Task 22: A model is reviewing the diff.");
  });

  it("pays nothing when it cannot comment", async () => {
    gh.postStatus = 403;
    await expect(go()).rejects.toThrow(/Could not comment on the pull request, so no review was paid for\. The github-token needs pull-requests: write\./);
    expect(desk.post).not.toHaveBeenCalled();
  });

  it("takes away the comment it made when the payment is not made, or when it does not settle", async () => {
    desk.post.mockRejectedValue(new Error("The desk answered 402. Nothing was charged."));
    await expect(go()).rejects.toThrow("The desk answered 402. Nothing was charged.");
    expect(state.log.slice(-2)).toEqual(["post BrainChain is reviewing aaaaaaa.", "delete 100"]);
    expect(gh.comments).toEqual([]);
    desk.post.mockResolvedValue({ order: ORDER, price: 1_000_000n, uncertain: false });
    desk.check.mockResolvedValue({ kind: "failed", reason: "The payment did not settle. Nothing was charged." });
    await expect(go()).rejects.toThrow("The payment did not settle.");
    expect(gh.comments).toEqual([]);
  });

  it("leaves accepted empty, and says a re-run posts the review, when the job stops waiting", async () => {
    desk.check.mockResolvedValue({ kind: "waiting", state: "hired" });
    await go();
    expect(state.outputs.accepted).toBeUndefined();
    expect(state.warnings.at(-1)).toMatch(/^No graded review within 1 minute of the job starting, so none is posted yet\./);
    expect(visible(gh.comments[0]!.body)).toBe("The review of aaaaaaa is taking longer than this job waits for it. Re-running the job posts it once Jev accepts it, without paying again.");
    expect(paidFor(gh.comments[0]!.body)).toEqual(PAID);
    state.inputs["wait-minutes"] = "2";
    gh.comments = [];
    await go();
    expect(state.warnings.at(-1)).toMatch(/^No graded review within 2 minutes of the job starting/);
  });

  it("counts wait-minutes from the start of the job, payment included", async () => {
    desk.post.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 45_000));
      return { order: ORDER, price: 1_000_000n, uncertain: false };
    });
    desk.check.mockResolvedValue({ kind: "waiting", state: "hired" });
    await go();
    expect(desk.check).toHaveBeenCalledTimes(1);
  });
});

describe("the earlier review", () => {
  const OLD = "b".repeat(40);
  const earlier = reviewComment(preset("testnet", "base"), { order: `0x${"cd".repeat(32)}`, price: 1_000_000n, uncertain: false }, { kind: "accepted", taskId: "3", review: "The old commit looks correct." }, OLD);
  beforeEach(() => {
    gh.comments = [{ id: 1, login: "github-actions[bot]", body: earlier }];
  });

  it("stays below the status while the new review runs, and after it is rejected or runs late", async () => {
    desk.check.mockResolvedValue({ kind: "rejected" });
    await go();
    expect(state.log.filter((line) => line.startsWith("edit"))).toEqual([
      "edit BrainChain is reviewing aaaaaaa. The review of bbbbbbb stays below until the new one is accepted.",
      `edit BrainChain is reviewing aaaaaaa (order \`${ORDER}\`). The review replaces this comment if Jev accepts it; if not, the payment will be refunded. The review of bbbbbbb stays below until the new one is accepted.`,
      "edit Jev did not accept the review of aaaaaaa, so it is not posted and the payment is being refunded. The review of bbbbbbb is below.",
    ]);
    expect(shownReview(gh.comments[0]!.body)).toBe(earlier);
    expect(paidFor(gh.comments[0]!.body)).toEqual(PAID);

    desk.check.mockResolvedValue({ kind: "waiting", state: "hired" });
    await go();
    expect(visible(gh.comments[0]!.body)).toMatch(/^The review of aaaaaaa is taking longer than this job waits for it\..* The review of bbbbbbb stays below until the new one is accepted\.$/);
    expect(shownReview(gh.comments[0]!.body)).toBe(earlier);
  });

  it("is replaced by the new review once accepted", async () => {
    await go();
    expect(gh.comments[0]!.body).not.toContain("The old commit looks correct.");
    expect(gh.comments[0]!.body).toContain("Looks correct.");
  });

  it("is put back exactly when the payment is not made", async () => {
    desk.post.mockRejectedValue(new Error("The desk answered 402. Nothing was charged."));
    await expect(go()).rejects.toThrow("Nothing was charged.");
    expect(gh.comments).toEqual([{ id: 1, login: "github-actions[bot]", body: earlier }]);
  });

  it("is put back when a re-run finds the payment did not settle", async () => {
    gh.comments[0]!.body = statusComment("BrainChain is reviewing aaaaaaa.", PAID, earlier);
    desk.check.mockResolvedValue({ kind: "failed", reason: "The payment did not settle. Nothing was charged." });
    await expect(go()).rejects.toThrow("The payment did not settle.");
    expect(desk.post).not.toHaveBeenCalled();
    expect(gh.comments[0]!.body).toBe(earlier);
  });
});

describe("a review overtaken by a newer commit", () => {
  it("is kept in the job summary, and the newer commit's comment is left alone", async () => {
    const newer = statusComment("BrainChain is reviewing ccccccc.", { commit: "c".repeat(40) });
    desk.check.mockImplementation(async () => {
      gh.comments[0]!.body = newer;
      return { kind: "accepted", taskId: "4", review: "Looks correct." };
    });
    await go();
    expect(gh.comments[0]!.body).toBe(newer);
    expect(state.summary[0]).toContain("Looks correct.");
    expect(state.outputs.accepted).toBe("true");
    expect(state.notices.at(-1)).toBe("The pull request moved on to ccccccc while this review ran, so the review of aaaaaaa is kept in this job's summary and the comment is left to the newer commit.");
  });

  it("does not write its rejection over the newer commit's comment", async () => {
    const newer = statusComment("BrainChain is reviewing ccccccc.", { commit: "c".repeat(40) });
    desk.check.mockImplementation(async () => {
      gh.comments[0]!.body = newer;
      return { kind: "rejected" };
    });
    await go();
    expect(gh.comments[0]!.body).toBe(newer);
    expect(state.outputs.accepted).toBe("false");
  });
});

describe("the brief", () => {
  it("shows wider context from the file itself when it fits", async () => {
    gh.files["src/a.ts"] = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    gh.diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -17,7 +17,7 @@\n line 17\n line 18\n line 19\n-old 20\n+line 20\n line 21\n line 22\n line 23\n";
    await go();
    const { brief } = desk.post.mock.calls[0]![3] as { brief: string };
    expect(brief).toContain(" 1 line 1\n");
    expect(brief).toContain(" 40 line 40\n");
    expect(brief).toContain("+20 line 20\n");
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
    expect(state.notices).toEqual(["The pull request changes no lines outside lockfiles, generated and binary files: no review was paid for."]);
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
    expect(state.notices).toEqual(["The pull request is closed: no review was paid for.", "The pull request has moved on from aaaaaaa to bbbbbbb: no review was paid for."]);
    expect(state.log).toEqual([]);
  });

  it("warns, naming the likely cause, when payer-key is empty", async () => {
    state.inputs["payer-key"] = "";
    await go();
    expect(state.warnings).toEqual([
      "payer-key is empty: no review was paid for. Check that the secret name in the workflow matches the repository secret. Pull requests opened by Dependabot read Dependabot secrets instead.",
    ]);
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
    await expect(go()).rejects.toThrow(/holds 0\.5 test USDC on Base Sepolia, less than max-price 1 test USDC\. Send it at least 0\.5 test USDC more\. Nothing was charged\./);
    expect(desk.post).not.toHaveBeenCalled();
  });

  it("on Robinhood Chain, fails before paying until Permit2 is approved for max-price", async () => {
    state.inputs["pay-on"] = "robinhood";
    await expect(go()).rejects.toThrow(/lets Permit2 spend 0 test USDG on Robinhood Chain testnet, less than max-price 1 test USDG\. From that wallet, call approve\(0x000000000022D473030F116dDEE9F6B43aC78BA3, 1000000\) on the test USDG contract .* once; 1000000 is 1 test USDG.*Nothing was charged\./);
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

import { afterEach, describe, expect, it, vi } from "vitest";

import { comment, commenter, diff, fileAt, ownComment, remove } from "./github.js";

const MARKER = "<!-- brainchain-review -->";

afterEach(() => vi.unstubAllGlobals());

/** Answers each request with the reply for its method, recording what was asked. */
function github(replies: Partial<Record<string, () => Response>>) {
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url });
    return replies[method]?.() ?? new Response("unexpected", { status: 500 });
  });
  return calls;
}

describe("comment", () => {
  it("writes over the earlier comment", async () => {
    const calls = github({ PATCH: () => Response.json({ id: 7, html_url: "https://gh/c/7" }) });
    expect(await comment("t", "acme/api", 3, "new", { id: 7 })).toMatchObject({ id: 7 });
    expect(calls).toEqual([{ method: "PATCH", url: "https://api.github.com/repos/acme/api/issues/comments/7" }]);
  });

  it("posts anew when the earlier comment is gone or cannot be edited", async () => {
    for (const status of [403, 404]) {
      const calls = github({ PATCH: () => new Response("no", { status }), POST: () => Response.json({ id: 9, html_url: "https://gh/c/new" }) });
      expect((await comment("t", "acme/api", 3, "new", { id: 7 })).html_url).toBe("https://gh/c/new");
      expect(calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
    }
  });

  it("fails on any other error instead of posting a second comment", async () => {
    const calls = github({ PATCH: () => new Response("down", { status: 502 }), POST: () => Response.json({ id: 9 }) });
    await expect(comment("t", "acme/api", 3, "new", { id: 7 })).rejects.toThrow(/GitHub answered 502/);
    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
  });

  it("posts a new comment when there is none", async () => {
    const calls = github({ POST: () => Response.json({ id: 9, html_url: "https://gh/c/new" }) });
    await comment("t", "acme/api", 3, "new");
    expect(calls).toEqual([{ method: "POST", url: "https://api.github.com/repos/acme/api/issues/3/comments" }]);
  });
});

describe("ownComment", () => {
  const user = (login: string) => ({ login, type: login.endsWith("[bot]") ? "Bot" : "User" });
  const at = (id: number, body: string, login: string) => ({ id, body, html_url: "x", user: user(login) });

  it("takes the newest comment by this login that starts with the marker, across pages", async () => {
    const first = Array.from({ length: 100 }, (_, i) => at(1000 + i, "chatter", "dev"));
    first[10] = at(10, `${MARKER}\nold`, "octo");
    const second = [at(20, `${MARKER}\nnewer`, "octo"), at(21, `${MARKER}\nby a bot`, "github-actions[bot]"), at(22, `quoting ${MARKER}`, "octo")];
    vi.stubGlobal("fetch", async (url: string) => Response.json(url.endsWith("&page=1") ? first : second));
    expect((await ownComment("t", "acme/api", 3, "octo", MARKER))?.id).toBe(20);
    expect(await ownComment("t", "acme/api", 3, "someone", MARKER)).toBeUndefined();
  });

  it("takes the newest bot comment when the token's login is unknown, as with an App token", async () => {
    const comments = [at(1, `${MARKER}\nold`, "github-actions[bot]"), at(2, `${MARKER}\nnewer`, "acme-reviews[bot]"), at(3, `${MARKER}\nby a person`, "mallory")];
    vi.stubGlobal("fetch", async () => Response.json(comments));
    expect((await ownComment("t", "acme/api", 3, undefined, MARKER))?.id).toBe(2);
  });
});

describe("commenter", () => {
  it("is a person's token's own login, and undefined for a token GitHub will not name", async () => {
    github({ GET: () => Response.json({ login: "octo" }) });
    expect(await commenter("t")).toBe("octo");
    github({ GET: () => new Response("Resource not accessible by integration", { status: 403 }) });
    expect(await commenter("t")).toBeUndefined();
  });
});

describe("diff", () => {
  it("is undefined when GitHub will not produce one, and fails on other errors", async () => {
    github({ GET: () => Response.json({ errors: [{ code: "too_large" }] }, { status: 406 }) });
    expect(await diff("t", "acme/api", 3)).toBeUndefined();
    github({ GET: () => new Response("down", { status: 502 }) });
    await expect(diff("t", "acme/api", 3)).rejects.toThrow(/GitHub answered 502/);
  });
});

describe("remove", () => {
  it("deletes the comment, and needs nothing when it is already gone", async () => {
    const calls = github({ DELETE: () => new Response(null, { status: 204 }) });
    await remove("t", "acme/api", 7);
    expect(calls).toEqual([{ method: "DELETE", url: "https://api.github.com/repos/acme/api/issues/comments/7" }]);
    github({ DELETE: () => new Response("Not Found", { status: 404 }) });
    await remove("t", "acme/api", 7);
    github({ DELETE: () => new Response("down", { status: 502 }) });
    await expect(remove("t", "acme/api", 7)).rejects.toThrow(/GitHub answered 502/);
  });
});

describe("fileAt", () => {
  it("reads a file's raw text at a commit, or gives undefined", async () => {
    let asked: { url: string; accept: string | null } | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      asked = { url, accept: new Headers(init.headers).get("accept") };
      return new Response("const a = 1;\n");
    });
    expect(await fileAt("t", "acme/api", "src/my file.ts", "abc")).toBe("const a = 1;\n");
    expect(asked).toEqual({ url: "https://api.github.com/repos/acme/api/contents/src/my%20file.ts?ref=abc", accept: "application/vnd.github.raw" });
    github({ GET: () => new Response("Not Found", { status: 404 }) });
    expect(await fileAt("t", "acme/api", "gone.ts", "abc")).toBeUndefined();
  });
});

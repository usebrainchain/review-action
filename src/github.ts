const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(token: string, path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: init.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "brainchain-review-action",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} for ${path}: ${(await response.text()).slice(0, 200)}`, response.status);
  return response;
}

/** The pull request's diff, or undefined when GitHub will not produce one: over 300 files or 20,000 lines. */
export async function diff(token: string, repo: string, number: number): Promise<string | undefined> {
  try {
    return await (await call(token, `/repos/${repo}/pulls/${number}`, { accept: "application/vnd.github.diff" })).text();
  } catch (error) {
    if (error instanceof GitHubError && error.status === 406) return undefined;
    throw error;
  }
}

/** The pull request as it stands now, which may be past the event that started the run. */
export async function pullRequest(token: string, repo: string, number: number): Promise<{ state: string; head: { sha: string } }> {
  return (await (await call(token, `/repos/${repo}/pulls/${number}`)).json()) as { state: string; head: { sha: string } };
}

/**
 * The login a person's token comments as. GET /user refuses the workflow token
 * and App installation tokens, which comment as bots: undefined stands for those.
 */
export async function commenter(token: string): Promise<string | undefined> {
  try {
    const user = (await (await call(token, "/user")).json()) as { login?: unknown };
    return typeof user.login === "string" ? user.login : undefined;
  } catch {
    return undefined;
  }
}

export interface IssueComment {
  id: number;
  body?: string;
  html_url: string;
  user?: { login?: string; type?: string };
}

/**
 * The newest comment starting with the marker that this action's identity left:
 * `login` for a person's token, otherwise any bot, since an App's own login
 * cannot be read with its token. The comment records what was paid for, so no
 * one else may write it.
 */
export async function ownComment(token: string, repo: string, number: number, login: string | undefined, marker: string): Promise<IssueComment | undefined> {
  let newest: IssueComment | undefined;
  for (let page = 1; page <= 10; page++) {
    const comments = (await (await call(token, `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`)).json()) as IssueComment[];
    for (const c of comments) if ((login ? c.user?.login === login : c.user?.type === "Bot") && c.body?.startsWith(marker)) newest = c;
    if (comments.length < 100) break;
  }
  return newest;
}

export async function comment(token: string, repo: string, number: number, body: string, earlier?: { id: number }): Promise<IssueComment> {
  if (earlier) {
    try {
      return (await (await call(token, `/repos/${repo}/issues/comments/${earlier.id}`, { method: "PATCH", body: JSON.stringify({ body }) })).json()) as IssueComment;
    } catch (error) {
      // Deleted (404) or no longer this token's to edit (403): post anew. Anything else would fail a new post too.
      if (!(error instanceof GitHubError) || (error.status !== 403 && error.status !== 404)) throw error;
    }
  }
  return (await (await call(token, `/repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) })).json()) as IssueComment;
}

export async function remove(token: string, repo: string, id: number): Promise<void> {
  try {
    await call(token, `/repos/${repo}/issues/comments/${id}`, { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }
}

/** A file's text at a commit, or undefined when it cannot be read: the brief then keeps the diff's own context. */
export async function fileAt(token: string, repo: string, path: string, ref: string): Promise<string | undefined> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return call(token, `/repos/${repo}/contents/${encoded}?ref=${ref}`, { accept: "application/vnd.github.raw" }).then(
    (response) => response.text(),
    () => undefined,
  );
}

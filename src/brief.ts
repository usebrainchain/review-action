// A pull request as a BrainChain brief. The desk takes a title of up to 120
// characters, a brief of up to 32,000 and two or three quality levels of up to
// 200 each, best first; the work is paid if it reaches the second level.

export const LIMITS = { title: 120, brief: 32_000, level: 200 } as const;

export const LEVELS = [
  "Names real defects in the diff with file, line and a concrete fix, or correctly finds none, and invents nothing",
  "Accurate and useful: at least one real point about the diff, nothing invented, though it may miss a defect",
  "Generic, wrong about the code, or reports problems that are not in the diff",
];

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  repo: string;
}

/** Files whose diffs say little about correctness and crowd out the rest. */
const NOISE = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|deno\.lock)$/,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|wasm)$/,
  /(^|\/)(dist|build|vendor|node_modules)\//,
  /\.snap$/,
];

interface FileDiff {
  path: string;
  text: string;
}

/** Splits a unified diff into one entry per file. */
export function splitDiff(diff: string): FileDiff[] {
  const parts = diff.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git "));
  return parts.map((text) => ({ path: newPath(text.split("\n", 1)[0]!.slice("diff --git ".length)), text }));
}

/** The b/ side of a `diff --git` line. Git quotes a path that holds a quote, a backslash, or a control or non-ASCII byte. */
function newPath(sides: string): string {
  const quoted = /"b\/((?:[^"\\]|\\.)*)"$/.exec(sides);
  if (quoted) return unquote(quoted[1]!);
  // Unrenamed, both sides name the same path, so an even split is right even when the path holds " b/".
  const half = (sides.length - 1) / 2;
  if (sides.startsWith("a/") && sides.slice(half).startsWith(" b/") && sides.slice(2, half) === sides.slice(half + 3)) return sides.slice(half + 3);
  return /^(?:"a\/(?:[^"\\]|\\.)*"|a\/.+?) b\/(.+)$/.exec(sides)?.[1] ?? "";
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** Reverses git's C-style quoting; octal escapes are UTF-8 bytes. */
function unquote(path: string): string {
  const bytes = path.split(/(\\[0-7]{3}|\\.)/).flatMap((part) => {
    if (!part.startsWith("\\") || part.length < 2) return [...Buffer.from(part)];
    return [/^\\[0-7]{3}$/.test(part) ? parseInt(part.slice(1), 8) : (ESCAPES[part[1]!] ?? part.charCodeAt(1))];
  });
  return Buffer.from(bytes).toString("utf8");
}

/** Whether the file adds or removes a line. A rename, a mode change or a binary file has no hunk to review. */
const changed = (file: FileDiff) => file.text.split(/^(?=@@ )/m).slice(1).some((hunk) => /\n[+-]/.test(hunk));

/**
 * One file's changes with `context` lines kept around each change, every kept
 * line prefixed with its line number in the new file so the reviewer can cite it.
 */
export function compact(file: FileDiff, context = 3): string {
  const out = [`File: ${file.path}`];
  for (const hunk of file.text.split(/^(?=@@ )/m).slice(1)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/m.exec(hunk);
    if (!header) continue;
    let line = Number(header[1]);
    const rows = hunk
      .split("\n")
      .slice(1)
      .filter((row) => row !== "" && !row.startsWith("\\"))
      .map((row) => {
        const kind = row[0];
        const text = row.slice(1);
        if (kind === "-") return { change: true, text: `- ${text}` };
        const numbered = `${kind === "+" ? "+" : " "}${line} ${text}`;
        line += 1;
        return { change: kind === "+", text: numbered };
      });
    const near = (i: number) => rows.slice(Math.max(0, i - context), i + context + 1).some((row) => row.change);
    let gap = false;
    out.push(`@@${header[2]?.trimEnd() ? ` ${header[2].trim()}` : ""}`);
    rows.forEach((row, i) => {
      if (near(i)) {
        out.push(row.text);
        gap = false;
      } else if (!gap) {
        out.push(" …");
        gap = true;
      }
    });
  }
  return out.join("\n");
}

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

export function buildBrief(pr: PullRequest, diff: string): { title: string; brief: string; levels: string[]; skipped: string[]; truncated: boolean; reviewable: boolean } {
  const files = splitDiff(diff);
  const skipped = files.filter((f) => NOISE.some((pattern) => pattern.test(f.path))).map((f) => f.path);
  const kept = files.filter((f) => !skipped.includes(f.path));

  const description = (pr.body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  const head = [
    `Review pull request #${pr.number} to ${pr.repo}. Report real defects only: bugs, security problems, broken edge cases and mistakes that would fail in use. For each, name the file and line from the diff, say what goes wrong and give the fix. If the change looks correct, say so in one line and name what you checked. Skip style and formatting. In the diff, numbers are lines in the new file, + marks an added line and - a removed one. Start with the findings, with no title, in Markdown under 300 words.`,
    "",
    `Title: ${cut(pr.title, 200)}`,
    ...(description ? [`Description: ${cut(description, 500)}`] : []),
    ...(skipped.length ? [`Not shown (lockfiles, build output, binaries): ${cut(skipped.join(", "), 200)}`] : []),
    "",
  ].join("\n");

  const open = "```diff\n";
  const close = "\n```";
  const note = (shown: number, total: number) => `\nThe diff is cut at ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters. Review only what is shown.`;
  const room = LIMITS.brief - head.length - open.length - close.length;
  // Full context when it fits: a reviewer who cannot see the surrounding lines invents problems in them.
  const bodies = [3, 2, 1].map((lines) => kept.map((f) => compact(f, lines)).join("\n\n"));
  const body = bodies.find((b) => b.length <= room) ?? bodies.at(-1)!;

  let shown = body;
  let truncated = false;
  if (body.length > room) {
    truncated = true;
    // Leave space for the note, then cut on a line boundary.
    const budget = room - note(body.length, body.length).length;
    const slice = body.slice(0, Math.max(0, budget));
    shown = slice.slice(0, Math.max(0, slice.lastIndexOf("\n")));
  }
  const brief = body.length === 0 ? `${head}The diff has no reviewable changes.` : `${head}${open}${shown}${close}${truncated ? note(shown.length, body.length) : ""}`;

  return { title: cut(`Review PR #${pr.number}: ${pr.title}`, LIMITS.title), brief, levels: LEVELS, skipped, truncated, reviewable: kept.some(changed) };
}

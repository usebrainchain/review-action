import type { Outcome, Posted } from "./desk.js";
import { amount, type Preset } from "./presets.js";

const FEE_BPS = 300n;
export const MARKER = "<!-- brainchain-review -->";
/** GitHub refuses comments over 65,536 characters; the footer needs the rest. */
const MAX_REVIEW = 60_000;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const escapeProse = (text: string) =>
  text
    .replace(/<!--/g, "&lt;!--")
    .replace(/<(\/?)(details|summary)\b/gi, "&lt;$1$2")
    .replace(/(^|\W)@(?=[A-Za-z0-9])/g, "$1@​");

/** Escapes a line outside its code spans. A backtick run with no closing run of the same length is plain text. */
const escapeLine = (line: string) => line.replace(/(`+)(?!`).*?(?<!`)\1(?!`)|[^`]+|`+/g, (part, span?: string) => (span ? part : escapeProse(part)));

/**
 * Makes model output inert on the page: mentions notify no one, and an opened
 * HTML comment, tag or code block cannot swallow the footer that says who wrote
 * the review and what it cost. Code is left as written: GitHub shows it as
 * text, so nothing in it notifies or hides anything.
 */
export function neutralize(review: string): string {
  const long = review.length > MAX_REVIEW;
  const lines = (long ? review.slice(0, MAX_REVIEW) : review).split("\n");
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const match = FENCE.exec(lines[i]!);
    if (fence) {
      if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
      continue;
    }
    // A backtick fence's info string holds no backtick; a line like ```x``` is inline code.
    if (match && !(match[1]![0] === "`" && match[2]!.includes("`"))) {
      fence = match[1];
      continue;
    }
    lines[i] = escapeLine(lines[i]!);
  }
  if (fence) lines.push(fence);
  if (long) lines.push("", "[The review is longer than a comment allows and was cut here.]");
  return lines.join("\n");
}

/** What was paid for a commit, so a re-run follows the order instead of paying again. */
export interface Paid {
  order: `0x${string}`;
  commit: string;
  price: bigint;
}

const RECORD = /^<!-- brainchain order=(0x[0-9a-f]{64}) commit=([0-9a-f]{7,64}) price=(\d+) -->$/;
const record = (paid: Paid) => `<!-- brainchain order=${paid.order} commit=${paid.commit} price=${paid.price} -->`;

/** The record is read only from the line under the marker, so a review that quotes one cannot forge it. */
export function paidFor(body: string): Paid | undefined {
  const [first, second = ""] = body.split(/\r?\n/, 2);
  const match = first === MARKER ? RECORD.exec(second) : null;
  return match ? { order: match[1] as `0x${string}`, commit: match[2]!, price: BigInt(match[3]!) } : undefined;
}

/** The comment that holds the review's place: before payment, while the review runs, or when none is posted. */
export function statusComment(text: string, paid?: Paid): string {
  return [MARKER, ...(paid ? [record(paid)] : []), text].join("\n");
}

/** The commit a review comment says it reviewed, read from this action's footer line only. */
export function reviewedCommit(body: string): string | undefined {
  if (!body.startsWith(MARKER)) return undefined;
  const footer = body.trimEnd().split(/\r?\n/).at(-1) ?? "";
  return /^<sub>Reviewed through \[BrainChain\]\(.* Reviewed at ([0-9a-f]{7})\.<\/sub>$/.exec(footer)?.[1];
}

/** The PR comment for an accepted review. */
export function reviewComment(preset: Preset, posted: Posted, outcome: Extract<Outcome, { kind: "accepted" }>, commit?: string): string {
  const paid = amount((posted.price * (10_000n - FEE_BPS)) / 10_000n);
  const task = outcome.taskId ? (preset.taskPage ? `[task #${outcome.taskId}](${preset.taskPage(outcome.taskId)})` : `task #${outcome.taskId}`) : "its task";
  return [
    MARKER,
    ...(commit ? [record({ order: posted.order, commit, price: posted.price })] : []),
    "### BrainChain review",
    "",
    neutralize(outcome.review.trim()),
    "",
    "---",
    `<sub>Reviewed through [BrainChain](https://usebrainchain.com): Jev hired a model, graded this review and accepted it, so the model earns ${paid} ${preset.token}. Paid ${amount(posted.price)} ${preset.token} on ${preset.chain}; see ${task}.${commit ? ` Reviewed at ${commit.slice(0, 7)}.` : ""}</sub>`,
  ].join("\n");
}

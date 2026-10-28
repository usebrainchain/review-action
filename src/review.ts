import type { Outcome, Posted } from "./desk.js";
import { amount, type Preset } from "./presets.js";

const FEE_BPS = 300n;
export const MARKER = "<!-- brainchain-review -->";
/** GitHub refuses comments over 65,536 characters; the footer needs the rest. */
const MAX_REVIEW = 60_000;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** Headings at levels 1 to 3 would rank with or above the comment's own "### BrainChain review". */
const HEADING = /^( {0,3})#{1,3}(?=[ \t]|$)/;
const UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
/** Lines a === or --- under them cannot turn into a heading. */
const NOT_PARAGRAPH = /^\s*$|^ {0,3}([-*+][ \t]|\d+[.)][ \t]|[>#|<])/;

const escapeProse = (text: string) =>
  text
    .replace(/<!--/g, "&lt;!--")
    .replace(/<(\/?)(details|summary)\b/gi, "&lt;$1$2")
    .replace(/(^|\W)@(?=[A-Za-z0-9])/g, "$1@\u200b")
    // GitHub links #12 to issue or pull request 12 of the reviewed repository, which the model never meant.
    .replace(/(^|[^\w&/])#(?=\d)/g, "$1#\u200b");

/** Escapes a line outside its code spans. A backtick run with no closing run of the same length is plain text. */
const escapeLine = (line: string) => line.replace(/(`+)(?!`).*?(?<!`)\1(?!`)|[^`]+|`+/g, (part, span?: string) => (span ? part : escapeProse(part)));

/**
 * Mentions notify no one, issue numbers link nowhere, headings sit under the
 * comment's own, and nothing the model opens can hide the footer that says who
 * wrote the review and what it cost. Code is left as written, since GitHub shows
 * it as text.
 */
export function neutralize(review: string): string {
  const long = review.length > MAX_REVIEW;
  const lines = (long ? review.slice(0, MAX_REVIEW) : review).split("\n");
  let fence: string | undefined;
  let paragraph = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = FENCE.exec(line);
    if (fence) {
      if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
      continue;
    }
    // A backtick fence's info string holds no backtick; a line like ```x``` is inline code.
    if (match && !(match[1]![0] === "`" && match[2]!.includes("`"))) {
      fence = match[1];
      paragraph = false;
      continue;
    }
    if (paragraph && UNDERLINE.test(line)) {
      lines[i - 1] = `#### ${lines[i - 1]!.trim()}`;
      lines[i] = "";
      paragraph = false;
      continue;
    }
    lines[i] = escapeLine(line.replace(HEADING, "$1####"));
    paragraph = !NOT_PARAGRAPH.test(line);
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

/** The commit a comment is about, and what was paid for it once paid. */
type Recorded = { commit: string } | Paid;

const RECORD = /^<!-- brainchain commit=([0-9a-f]{7,64})(?: order=(0x[0-9a-f]{64}) price=(\d+))? -->$/;
const recordLine = (record: Recorded) => `<!-- brainchain commit=${record.commit}${"order" in record ? ` order=${record.order} price=${record.price}` : ""} -->`;
/** Separates a status from the earlier review it keeps on show. */
const EARLIER = "<!-- brainchain-earlier -->";

/** The record is read only from the line under the marker, so a review that quotes one cannot forge it. */
function recordOf(body: string): RegExpExecArray | null {
  const [first, second = ""] = body.split(/\r?\n/, 2);
  return first === MARKER ? RECORD.exec(second) : null;
}

export function paidFor(body: string): Paid | undefined {
  const match = recordOf(body);
  return match?.[2] ? { order: match[2] as `0x${string}`, commit: match[1]!, price: BigInt(match[3]!) } : undefined;
}

/** The commit this action's comment is about: the one under way, or else the one its review covers. */
export function recordedCommit(body: string): string | undefined {
  return recordOf(body)?.[1] ?? reviewedCommit(body);
}

/** Whether two commit ids name the same commit, when one may be the 7-character short form. */
export const sameCommit = (a: string, b: string) => (a.length <= b.length ? b.startsWith(a) : a.startsWith(b));

/**
 * The comment that holds the review's place while it runs, or when it is not
 * posted: one line of `text`, and an earlier accepted review kept on show below.
 */
export function statusComment(text: string, record: Recorded, earlier?: string): string {
  return [MARKER, recordLine(record), text.replace(/\n/g, " "), ...(earlier ? ["", EARLIER, earlier.slice(MARKER.length + 1)] : [])].join("\n");
}

/** The accepted review on show, as it was posted: the comment itself, or the review a status keeps below it. */
export function shownReview(body: string): string | undefined {
  // The separator is read at its place only, so a review that quotes it is not taken for a status.
  const lines = body.split("\n");
  if (recordOf(body) && lines[4] === EARLIER) return [MARKER, ...lines.slice(5)].join("\n");
  return reviewedCommit(body) ? body : undefined;
}

/** The commit a review comment says it reviewed, read from this action's footer line only. */
export function reviewedCommit(body: string): string | undefined {
  if (!body.startsWith(MARKER)) return undefined;
  const footer = body.trimEnd().split(/\r?\n/).at(-1) ?? "";
  return /^<sub>Reviewed through \[BrainChain\]\(.* Reviewed at ([0-9a-f]{7})\.<\/sub>$/.exec(footer)?.[1];
}

export function reviewComment(preset: Preset, posted: Posted, outcome: Extract<Outcome, { kind: "accepted" }>, commit?: string): string {
  const paid = amount((posted.price * (10_000n - FEE_BPS)) / 10_000n);
  // "task #12" would link issue 12 of the reviewed repository.
  const task = !outcome.taskId ? "" : preset.taskPage ? `; see [task ${outcome.taskId}](${preset.taskPage(outcome.taskId)})` : `; BrainChain task ${outcome.taskId}`;
  return [
    MARKER,
    ...(commit ? [recordLine({ order: posted.order, commit, price: posted.price })] : []),
    "### BrainChain review",
    "",
    neutralize(outcome.review.trim()),
    "",
    "---",
    `<sub>Reviewed through [BrainChain](https://usebrainchain.com). Jev, a decision model from TypeSafe, hired the model and accepted this review, so the model earns ${paid} ${preset.token}. Paid ${amount(posted.price)} ${preset.token} on ${preset.chain}${task}.${commit ? ` Reviewed at ${commit.slice(0, 7)}.` : ""}</sub>`,
  ].join("\n");
}

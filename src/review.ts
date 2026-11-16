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
  const whole = escapeReview(review);
  if (whole.length <= MAX_REVIEW) return whole;
  // Escaping lengthens the text: find the longest cut whose escaped form fits. Each candidate is escaped on its own,
  // because a cut can leave a code span or fence open. lo always fits.
  let lo = 0;
  let hi = review.length;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (escapeReview(review.slice(0, mid)).length <= MAX_REVIEW) lo = mid;
    else hi = mid;
  }
  return `${escapeReview(review.slice(0, lo))}\n\n[The review is longer than a comment allows and was cut here.]`;
}

function escapeReview(review: string): string {
  const lines = review.split("\n");
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
  return lines.join("\n");
}

/** What was paid for a commit. A re-run follows this order instead of paying again. */
export interface Paid {
  order: `0x${string}`;
  commit: string;
  price: bigint;
}

/** The commit a comment is about, plus the payment once there is one. */
type Recorded = { commit: string } | Paid;

const RECORD = /^<!-- brainchain commit=([0-9a-f]{7,64})(?: order=(0x[0-9a-f]{64}) price=(\d+))? -->$/;
const recordLine = (record: Recorded) => `<!-- brainchain commit=${record.commit}${"order" in record ? ` order=${record.order} price=${record.price}` : ""} -->`;
/** Separates a status from the earlier review it keeps on show. */
const EARLIER = "<!-- brainchain-earlier -->";

/** Read only from the line under the marker: a review that quotes a record cannot forge one. */
function recordOf(body: string): RegExpExecArray | null {
  const [first, second = ""] = body.split(/\r?\n/, 2);
  return first === MARKER ? RECORD.exec(second) : null;
}

export function paidFor(body: string): Paid | undefined {
  const match = recordOf(body);
  return match?.[2] ? { order: match[2] as `0x${string}`, commit: match[1]!, price: BigInt(match[3]!) } : undefined;
}

/**
 * The commit a record names without an order. Runs before 1.4.4 wrote one
 * before paying and added the order once paid, so it may stand for a payment
 * whose order was lost. Later runs record the order before the payment leaves.
 */
export function orderless(body: string): string | undefined {
  const match = recordOf(body);
  return match && !match[2] ? match[1] : undefined;
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
  // Only the separator at its fixed line counts; a review that quotes it is not a status.
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
    `<sub>Reviewed through [BrainChain](https://usebrainchain.com), which hired the model and accepted this review, so the model earns ${paid} ${preset.token}. Paid ${amount(posted.price)} ${preset.token} on ${preset.chain}${task}.${commit ? ` Reviewed at ${commit.slice(0, 7)}.` : ""}</sub>`,
  ].join("\n");
}

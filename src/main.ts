import { readFileSync } from "node:fs";

import * as core from "@actions/core";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { buildBrief } from "./brief.js";
import { check, overPrice, post, quote, type Outcome, type Posted } from "./desk.js";
import { comment, commenter, diff, fileAt, ownComment, pullRequest, remove, type IssueComment } from "./github.js";
import { amount, PERMIT2, preset as presetFor, units, type Preset } from "./presets.js";
import { MARKER, paidFor, recordedCommit, reviewComment, reviewedCommit, sameCommit, shownReview, statusComment, type Paid } from "./review.js";

interface PullRequestEvent {
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    draft?: boolean;
    user?: { login?: string; type?: string };
    head: { sha: string; repo: { full_name: string } | null };
    base: { repo: { full_name: string } };
  };
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address, address) view returns (uint256)"]);
/** Each file's text costs an API call, so a wider context is fetched for small pull requests only. */
const MAX_SOURCES = 20;

const minutes = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/** The error's first line, with its root cause (the host that failed, the refused connection) when that line hides it. */
export function failure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
  let cause = error instanceof Error ? error.cause : undefined;
  while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause;
  if (!(cause instanceof Error)) return message;
  const reason = cause.message || (cause instanceof AggregateError ? cause.errors.map(String).join("; ") : "");
  return reason && !message.includes(reason) ? `${message} (${reason})` : message;
}

/** A read that fails only warns: BrainChain refuses a payment the wallet cannot cover before it settles. */
async function checkFunds(preset: Preset, owner: `0x${string}`, maxPrice: bigint): Promise<void> {
  const reader = createPublicClient({ transport: http(preset.rpc, { timeout: 15_000, retryCount: 2 }) });
  const read = (what: string, call: Promise<bigint>) =>
    call.catch((error: unknown) => {
      core.warning(`Could not read the paying wallet's ${what} on ${preset.chain}, so paying without that check: ${failure(error)}`);
      return undefined;
    });
  const balance = await read(`${preset.token} balance`, reader.readContract({ address: preset.asset, abi: erc20, functionName: "balanceOf", args: [owner] }));
  if (balance !== undefined && balance < maxPrice) {
    throw new Error(
      `The paying wallet ${owner} holds ${amount(balance)} ${preset.token} on ${preset.chain}, less than max-price ${amount(maxPrice)} ${preset.token}. Send it at least ${amount(maxPrice - balance)} ${preset.token} more. Nothing was charged.`,
    );
  }
  if (!preset.permit2) return;
  const allowance = await read("Permit2 allowance", reader.readContract({ address: preset.asset, abi: erc20, functionName: "allowance", args: [owner, PERMIT2] }));
  if (allowance !== undefined && allowance < maxPrice) {
    throw new Error(
      `The paying wallet ${owner} lets Permit2 spend ${amount(allowance)} ${preset.token} on ${preset.chain}, less than max-price ${amount(maxPrice)} ${preset.token}. From that wallet, call approve(${PERMIT2}, ${maxPrice}) on the ${preset.token} contract ${preset.asset} once; ${maxPrice} is ${amount(maxPrice)} ${preset.token}, and a larger amount covers more reviews. Nothing was charged.`,
    );
  }
}

export async function run(): Promise<void> {
  // wait-minutes counts from here, so paying and posting are inside it.
  const started = Date.now();
  const path = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const pr = path && (eventName === "pull_request" || eventName === "pull_request_target") ? (JSON.parse(readFileSync(path, "utf8")) as PullRequestEvent).pull_request : undefined;
  if (!pr) throw new Error("Run this action in a GitHub workflow, on pull_request or pull_request_target events.");
  if (pr.draft) {
    core.notice("Draft pull request: no review was paid for.");
    return;
  }
  if (pr.user?.type === "Bot" && !core.getBooleanInput("review-bots")) {
    core.notice(`Pull request opened by ${pr.user.login ?? "a bot"}: no review was paid for. Set review-bots to true to review these.`);
    return;
  }
  const repo = pr.base.repo.full_name;
  // A fork's author is not the wallet's owner. Under pull_request_target a fork
  // would get the secret, and every pull request it opened would be paid for.
  if (pr.head.repo?.full_name !== repo) {
    core.notice("Pull request from a fork: no review was paid for.");
    return;
  }
  const raw = core.getInput("payer-key").trim();
  if (!raw) {
    core.warning(
      "payer-key is empty: no review was paid for. Check that the secret name in the workflow matches the repository secret. Pull requests opened by Dependabot read Dependabot secrets instead.",
    );
    return;
  }
  core.setSecret(raw);
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("payer-key must be a private key: 64 hex characters, with or without 0x.");
  core.setSecret(key);

  const preset = presetFor(core.getInput("network") || "mainnet", core.getInput("pay-on") || "base");
  const maxPrice = units(core.getInput("max-price") || "1");
  const waitMinutes = Number(core.getInput("wait-minutes") || "20");
  if (!Number.isFinite(waitMinutes) || waitMinutes < 1 || waitMinutes > 300) throw new Error("wait-minutes must be between 1 and 300.");
  const token = core.getInput("github-token", { required: true });
  const account = privateKeyToAccount(key as `0x${string}`);
  const deadline = started + waitMinutes * 60_000;
  const head = pr.head.sha;
  const short = head.slice(0, 7);

  // This action's newest comment on the pull request records what was paid for which commit.
  const login = await commenter(token);
  let mine: IssueComment | undefined = await ownComment(token, repo, pr.number, login, MARKER);
  if (mine?.body && reviewedCommit(mine.body) === short) {
    // The review on show may sit below a newer commit's status, whose record names that commit's order.
    const order = paidFor(shownReview(mine.body) ?? "")?.order;
    if (order) core.setOutput("order", order);
    core.setOutput("accepted", "true");
    core.notice(`This commit (${short}) already has a BrainChain review: no review was paid for. ${mine.html_url}`);
    return;
  }

  // An accepted review on show stays below the status until the new one replaces it.
  const earlier = mine?.body ? shownReview(mine.body) : undefined;
  const keep = (text: string, record: { commit: string } | Paid, below = "stays below until the new one is accepted") =>
    statusComment(earlier ? `${text} The review of ${reviewedCommit(earlier)} ${below}.` : text, record, earlier);
  const update = (body: string) =>
    comment(token, repo, pr.number, body, mine).catch((error: unknown) => {
      core.warning(`Could not update the comment on the pull request: ${failure(error)}`);
    });
  // Nothing was charged: put back what the comment held before this run, or remove it.
  let restore: string | undefined = earlier;
  const undo = async () => {
    if (!mine) return;
    await (restore ? comment(token, repo, pr.number, restore, mine) : remove(token, repo, mine.id)).catch((error: unknown) => {
      core.warning(`Could not restore the comment on the pull request: ${failure(error)}`);
    });
  };

  let posted: Posted;
  const recorded = mine?.body ? paidFor(mine.body) : undefined;
  if (recorded?.commit === head) {
    posted = { order: recorded.order, price: recorded.price, uncertain: false };
    core.setOutput("order", posted.order);
    core.info(`This commit was paid for already, as order ${posted.order}. Waiting on that order; nothing more is paid.`);
  } else {
    const text = await diff(token, repo, pr.number);
    if (text === undefined) {
      core.notice("GitHub gives no diff for a pull request over 300 files or 20,000 lines, so no review was paid for.");
      return;
    }
    const live = await pullRequest(token, repo, pr.number);
    if (live.state !== "open") {
      core.notice("The pull request is closed: no review was paid for.");
      return;
    }
    if (live.head.sha !== head) {
      core.notice(`The pull request has moved on from ${short} to ${live.head.sha.slice(0, 7)}: no review was paid for.`);
      return;
    }
    const about = { number: pr.number, title: pr.title, body: pr.body, repo };
    let brief = buildBrief(about, text);
    if (!brief.reviewable) {
      core.notice("The pull request changes no lines outside lockfiles, generated and binary files: no review was paid for.");
      return;
    }
    // The diff holds three lines around each change; when the brief has room, the files' own text gives more.
    if (brief.context >= 3 && brief.files.length <= MAX_SOURCES) {
      const texts = await Promise.all(brief.files.map((file) => fileAt(token, repo, file, head)));
      brief = buildBrief(about, text, new Map(brief.files.flatMap((file, i) => (texts[i] === undefined ? [] : [[file, texts[i]!] as [string, string]]))));
    }
    if (brief.skipped.length) core.info(`Left out of the brief: ${brief.skipped.join(", ")}`);
    if (brief.truncated) core.warning("The diff is longer than a BrainChain brief allows, so the review covers its first part only.");

    // Refused before the status comment, so a wrong max-price does not notify the pull request's subscribers.
    const asked = await quote(preset);
    if (asked !== undefined && asked > maxPrice) throw new Error(`${overPrice(preset, asked, maxPrice)} Nothing was charged.`);
    await checkFunds(preset, account.address, maxPrice);

    // Written before any money moves: it proves the token can comment, and it is where the order is recorded.
    restore = mine?.body;
    mine = await comment(token, repo, pr.number, keep(`BrainChain is reviewing ${short}.`, { commit: head }), mine).catch((error: unknown) => {
      throw new Error(`Could not comment on the pull request, so no review was paid for. The github-token needs pull-requests: write. ${failure(error)}`);
    });
    try {
      posted = await post(preset, account, maxPrice, brief);
    } catch (error) {
      await undo();
      throw error;
    }
    core.setOutput("order", posted.order);
    core.info(`Paid ${amount(posted.price)} ${preset.token} on ${preset.chain}. Order ${posted.order}${posted.uncertain ? " (the confirmation was lost; waiting on that order)" : ""}.`);
    const reviewing = keep(
      `BrainChain is reviewing ${short} (order \`${posted.order}\`). The review replaces this comment if Jev accepts it; if not, the payment will be refunded.`,
      { order: posted.order, commit: head, price: posted.price },
    );
    mine = await comment(token, repo, pr.number, reviewing, mine).catch((error: unknown) => {
      core.warning(`Could not record order ${posted.order} on the pull request, so a re-run of this job would pay again: ${failure(error)}`);
      return mine;
    });
  }

  const progress: Record<string, string> = {
    paying: "The payment is settling.",
    paid: "Paid; posting the task on BrainChain.",
    open: "Waiting for Jev to hire a model.",
    hired: "A model is reviewing the diff.",
    delivered: "The review is in; Jev is grading it.",
    submitted: "The review is in; Jev is grading it.",
    graded: "Graded; fetching the review.",
    disputed: "The grade is disputed; waiting for the dispute to close.",
    unknown: "BrainChain has no record of the order yet; asking again.",
  };
  let outcome: Outcome = { kind: "waiting", state: "paying" };
  let last = "";
  while (outcome.kind === "waiting" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    outcome = await check(preset, posted.order).catch((error: unknown): Outcome => ({ kind: "waiting", state: `BrainChain did not answer (${failure(error)}); trying again.` }));
    if (outcome.kind === "waiting" && outcome.state !== last) {
      const task = outcome.taskId ? `Task ${outcome.taskId}` : "The task";
      // "paid" is also a task status: the model was paid, so the review was accepted.
      const step = outcome.taskId && outcome.state === "paid" ? "Jev accepted the review; fetching it." : (progress[outcome.state] ?? outcome.state);
      core.info(outcome.state === "posted" ? `${task} is on BrainChain; Jev is hiring a model.` : outcome.taskId ? `${task}: ${step}` : step);
      last = outcome.state;
    }
  }
  if ("taskId" in outcome && outcome.taskId) core.setOutput("task-id", outcome.taskId);

  const paid = { order: posted.order, commit: head, price: posted.price };
  // A run for a newer commit may have taken the comment over while this one waited; its record must stand.
  const latest = await ownComment(token, repo, pr.number, login, MARKER).catch((error: unknown) => {
    core.warning(`Could not read the comment on the pull request again: ${failure(error)}`);
    return mine;
  });
  const newer = latest?.body ? recordedCommit(latest.body) : undefined;
  const superseded = newer !== undefined && !sameCommit(newer, head);
  mine = latest;

  switch (outcome.kind) {
    case "accepted": {
      const body = reviewComment(preset, posted, outcome, head);
      // The job summary keeps the paid review even if the comment cannot be posted.
      const summarized = await core.summary
        .addRaw(body)
        .write()
        .then(() => true)
        .catch((error: unknown) => {
          core.warning(`Could not write the job summary: ${failure(error)}`);
          return false;
        });
      // accepted is set once the review is kept somewhere a reader can find it.
      if (superseded) {
        if (summarized) core.setOutput("accepted", "true");
        core.notice(`The pull request moved on to ${newer!.slice(0, 7)} while this review ran, so the review of ${short} is kept in this job's summary and the comment is left to the newer commit.`);
        return;
      }
      const url = await comment(token, repo, pr.number, body, mine).then(
        (posting) => posting.html_url,
        (error: unknown) => {
          if (summarized) core.setOutput("accepted", "true");
          throw error;
        },
      );
      core.setOutput("accepted", "true");
      core.info(`Review posted: ${url}`);
      return;
    }
    case "rejected":
      if (!superseded) await update(keep(`Jev did not accept the review of ${short}, so it is not posted and the payment is being refunded.`, paid, "is below"));
      core.setOutput("accepted", "false");
      core.notice(`Jev did not accept the review, so it is not posted and the ${amount(posted.price)} ${preset.token} is being refunded to ${account.address} on ${preset.chain}.`);
      return;
    case "refund-failed":
      if (!superseded) await update(keep(`Jev did not accept the review of ${short}. The refund could not be sent automatically, and BrainChain has been alerted.`, paid, "is below"));
      core.setOutput("accepted", "false");
      throw new Error(`Jev did not accept the review, and the refund to ${account.address} could not be sent automatically. BrainChain has been alerted; write to hello@usebrainchain.com with order ${posted.order}.`);
    case "failed":
      if (!superseded) await undo();
      throw new Error(outcome.reason);
    case "waiting":
      if (outcome.state === "unknown") {
        core.warning(`BrainChain has no record of order ${posted.order}. If ${account.address} shows a payment for it, write to hello@usebrainchain.com with the order id.`);
        return;
      }
      if (!superseded) await update(keep(`The review of ${short} is taking longer than this job waits for it. Re-running the job posts it once Jev accepts it, without paying again.`, paid));
      core.warning(
        `No graded review within ${minutes(waitMinutes)} of the job starting, so none is posted yet. The order keeps running, and re-running this job posts the review once Jev accepts it, without paying again: ${preset.desk}/x402/tasks/${posted.order}`,
      );
  }
}

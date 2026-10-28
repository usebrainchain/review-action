import { readFileSync } from "node:fs";

import * as core from "@actions/core";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { buildBrief } from "./brief.js";
import { check, post, type Outcome, type Posted } from "./desk.js";
import { comment, commenter, diff, ownComment, pullRequest, type IssueComment } from "./github.js";
import { amount, PERMIT2, preset as presetFor, units, type Preset } from "./presets.js";
import { MARKER, paidFor, reviewComment, reviewedCommit, statusComment } from "./review.js";

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

/** The error's first line, with its root cause (the host that failed, the refused connection) when that line hides it. */
export function failure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
  let cause = error instanceof Error ? error.cause : undefined;
  while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause;
  if (!(cause instanceof Error)) return message;
  const reason = cause.message || (cause instanceof AggregateError ? cause.errors.map(String).join("; ") : "");
  return reason && !message.includes(reason) ? `${message} (${reason})` : message;
}

/**
 * Refuses to pay from a wallet that cannot cover max-price. A read that fails
 * only warns: a payment the wallet cannot cover is refused before it settles.
 */
async function checkFunds(preset: Preset, owner: `0x${string}`, maxPrice: bigint): Promise<void> {
  const reader = createPublicClient({ transport: http(preset.rpc, { timeout: 15_000, retryCount: 2 }) });
  const read = (what: string, call: Promise<bigint>) =>
    call.catch((error: unknown) => {
      core.warning(`Could not read the paying wallet's ${what} on ${preset.chain}, so paying without that check: ${failure(error)}`);
      return undefined;
    });
  const balance = await read(`${preset.token} balance`, reader.readContract({ address: preset.asset, abi: erc20, functionName: "balanceOf", args: [owner] }));
  if (balance !== undefined && balance < maxPrice) {
    throw new Error(`The paying wallet ${owner} holds ${amount(balance)} ${preset.token} on ${preset.chain}; a review costs up to ${amount(maxPrice)}. Nothing was charged.`);
  }
  if (!preset.permit2) return;
  const allowance = await read("Permit2 allowance", reader.readContract({ address: preset.asset, abi: erc20, functionName: "allowance", args: [owner, PERMIT2] }));
  if (allowance !== undefined && allowance < maxPrice) {
    throw new Error(
      `The paying wallet ${owner} lets Permit2 spend ${amount(allowance)} ${preset.token}; a review costs up to ${amount(maxPrice)}. Approve it once from that wallet: call approve(${PERMIT2}, amount) on the ${preset.token} contract ${preset.asset} on ${preset.chain}, with an amount of at least max-price. Nothing was charged.`,
    );
  }
}

export async function run(): Promise<void> {
  const path = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!path || (eventName !== "pull_request" && eventName !== "pull_request_target")) throw new Error("Run this action in a GitHub workflow, on pull_request events.");
  const event = JSON.parse(readFileSync(path, "utf8")) as PullRequestEvent;
  const pr = event.pull_request;
  if (!pr) {
    core.setFailed("Run this action on pull_request events.");
    return;
  }
  if (pr.draft) {
    core.notice("Draft pull request: no review requested.");
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
    core.notice("payer-key is empty: no review was paid for.");
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
  const head = pr.head.sha;
  const short = head.slice(0, 7);

  // This action's newest comment on the pull request records what was paid for which commit.
  let mine: IssueComment | undefined = await ownComment(token, repo, pr.number, await commenter(token), MARKER);
  const update = (body: string) =>
    comment(token, repo, pr.number, body, mine).catch((error: unknown) => {
      core.warning(`Could not update the comment on the pull request: ${failure(error)}`);
    });
  if (mine?.body && reviewedCommit(mine.body) === short) {
    const order = paidFor(mine.body)?.order;
    if (order) core.setOutput("order", order);
    core.setOutput("accepted", "true");
    core.notice(`This commit (${short}) already has a BrainChain review: ${mine.html_url}`);
    return;
  }

  let posted: Posted;
  const recorded = mine?.body ? paidFor(mine.body) : undefined;
  if (recorded?.commit === head) {
    posted = { order: recorded.order, price: recorded.price, uncertain: false };
    core.setOutput("order", posted.order);
    core.info(`This commit was paid for already, as order ${posted.order}. Following it; nothing more is paid.`);
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
      core.notice(`The pull request has moved on from ${short} to ${live.head.sha.slice(0, 7)}: no review was paid for ${short}.`);
      return;
    }
    const brief = buildBrief({ number: pr.number, title: pr.title, body: pr.body, repo }, text);
    if (!brief.reviewable) {
      core.notice("The diff changes no lines outside lockfiles, build output and binary files: no review was paid for.");
      return;
    }
    if (brief.skipped.length) core.info(`Left out of the brief: ${brief.skipped.join(", ")}`);
    if (brief.truncated) core.warning("The diff is longer than a BrainChain brief allows, so the review covers its first part only.");

    await checkFunds(preset, account.address, maxPrice);

    // Written before any money moves: it proves the token can comment, and it is where the order is recorded.
    mine = await comment(token, repo, pr.number, statusComment(`BrainChain is reviewing ${short}.`), mine).catch((error: unknown) => {
      throw new Error(`Could not comment on the pull request, so no review was paid for. The github-token needs pull-requests: write. ${failure(error)}`);
    });
    try {
      posted = await post(preset, account, maxPrice, brief);
    } catch (error) {
      await update(statusComment(`BrainChain did not review ${short}: the payment was not made, so nothing was charged.`));
      throw error;
    }
    core.setOutput("order", posted.order);
    core.info(`Paid ${amount(posted.price)} ${preset.token} on ${preset.chain}. Order ${posted.order}${posted.uncertain ? " (confirmation was lost; following it)" : ""}.`);
    const reviewing = statusComment(
      `BrainChain is reviewing ${short} (order \`${posted.order}\`). The review replaces this comment if Jev accepts it; if not, the payment is refunded.`,
      { order: posted.order, commit: head, price: posted.price },
    );
    mine = await comment(token, repo, pr.number, reviewing, mine).catch((error: unknown) => {
      core.warning(`Could not record order ${posted.order} on the pull request, so a re-run of this job would pay again: ${failure(error)}`);
      return mine;
    });
  }

  const deadline = Date.now() + waitMinutes * 60_000;
  const progress: Record<string, string> = {
    paying: "The payment is settling.",
    paid: "Paid; posting the task on BrainChain.",
    posted: "The task is on BrainChain; Jev is hiring a model.",
    open: "Waiting for Jev to hire a model.",
    hired: "A model is reviewing the diff.",
    delivered: "The review is in; Jev is grading it.",
    submitted: "The review is in; Jev is grading it.",
    graded: "Graded; fetching the review.",
  };
  let outcome: Outcome = { kind: "waiting", state: "paying" };
  let last = "";
  while (outcome.kind === "waiting" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    outcome = await check(preset, posted.order).catch((error: unknown): Outcome => ({ kind: "waiting", state: `unreachable (${failure(error)})` }));
    if (outcome.kind === "waiting" && outcome.state !== last) {
      core.info(`${outcome.taskId ? `Task #${outcome.taskId}: ` : ""}${progress[outcome.state] ?? outcome.state}`);
      last = outcome.state;
    }
  }
  if ("taskId" in outcome && outcome.taskId) core.setOutput("task-id", outcome.taskId);

  const paid = { order: posted.order, commit: head, price: posted.price };
  switch (outcome.kind) {
    case "accepted": {
      const body = reviewComment(preset, posted, outcome, head);
      // The job summary keeps the paid review even if the comment cannot be posted.
      const summarized = await core.summary
        .addRaw(body)
        .write()
        .then(() => true)
        .catch((error: unknown) => {
          core.warning(`Could not write the job summary: ${String(error)}`);
          return false;
        });
      // accepted is set once the review is kept somewhere a reader can find it.
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
      await update(statusComment(`Jev did not accept BrainChain's review of ${short}, so it is not posted and the payment is refunded.`, paid));
      core.setOutput("accepted", "false");
      core.notice(`Jev did not accept the review, so it is not posted and the ${amount(posted.price)} ${preset.token} is refunded to ${account.address} on ${preset.chain}.`);
      return;
    case "refund-failed":
      await update(statusComment(`Jev did not accept BrainChain's review of ${short}. The refund could not be sent automatically, and BrainChain has been alerted.`, paid));
      core.setOutput("accepted", "false");
      throw new Error(`Jev did not accept the review, and the refund to ${account.address} could not be sent automatically. BrainChain has been alerted; write to hello@usebrainchain.com with order ${posted.order}.`);
    case "failed":
      // Nothing was charged, so the record goes and a re-run pays anew.
      await update(statusComment(`BrainChain did not review ${short}: the payment did not settle, so nothing was charged.`));
      throw new Error(outcome.reason);
    case "waiting":
      if (outcome.state === "unknown") {
        core.warning(`The payment desk has no record of order ${posted.order}. If ${account.address} shows a payment for it, write to hello@usebrainchain.com with the order id.`);
      } else {
        core.warning(`No graded review within ${waitMinutes} minutes, so none is posted. The order keeps running, and re-running this job follows it: ${preset.desk}/x402/tasks/${posted.order}`);
      }
  }
}

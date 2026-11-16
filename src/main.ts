import { readFileSync } from "node:fs";

import * as core from "@actions/core";
import { createPublicClient, http, parseAbi, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { buildBrief, printable } from "./brief.js";
import { check, overPrice, post, quote, type Outcome, type Posted } from "./desk.js";
import { comment, commenter, diff, fileAt, GitHubError, ownComment, pullRequest, remove, type IssueComment } from "./github.js";
import { amount, PERMIT2, preset as presetFor, units, type Preset } from "./presets.js";
import { MARKER, orderless, paidFor, recordedCommit, reviewComment, reviewedCommit, sameCommit, shownReview, statusComment, type Paid } from "./review.js";

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
/** Tries at writing the comment when GitHub fails or does not answer. */
const ATTEMPTS = 3;
const transient = (error: unknown) => !(error instanceof GitHubError) || error.status >= 500 || error.status === 429;

/** The error's first line, with its root cause (the host that failed, the refused connection) when that line hides it. */
export function failure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
  let cause = error instanceof Error ? error.cause : undefined;
  while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause;
  if (!(cause instanceof Error)) return message;
  const reason = cause.message || (cause instanceof AggregateError ? cause.errors.map(String).join("; ") : "");
  return reason && !message.includes(reason) ? `${message} (${reason})` : message;
}

/** core.getBooleanInput answers "yes" with a YAML schema error that does not say what to write instead. */
function flag(name: string): boolean {
  const value = core.getInput(name);
  if (/^true$/i.test(value)) return true;
  if (!value || /^false$/i.test(value)) return false;
  throw new Error(`${name} must be true or false, not "${value}".`);
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
    const budget = 20n * maxPrice;
    throw new Error(
      `The paying wallet ${owner} lets Permit2 spend ${amount(allowance)} ${preset.token} on ${preset.chain}, less than max-price ${amount(maxPrice)} ${preset.token}. Each review draws that allowance down, so approve what you plan to spend on reviews: from that wallet, call approve(${PERMIT2}, amount) on the ${preset.token} contract ${preset.asset}, with the amount in 6 decimals (${budget} is ${amount(budget)} ${preset.token}, 20 reviews at max-price). The approval is a transaction, so the wallet needs a little ETH on ${preset.chain} for gas. Nothing was charged.`,
    );
  }
}

export async function run(): Promise<void> {
  // wait-minutes counts from here, so paying and posting are inside it.
  const started = Date.now();
  const path = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName && eventName !== "pull_request" && eventName !== "pull_request_target") {
    throw new Error(`Started by ${eventName}; this action reviews pull requests (pull_request or pull_request_target).`);
  }
  const pr = path && eventName ? (JSON.parse(readFileSync(path, "utf8")) as PullRequestEvent).pull_request : undefined;
  if (!pr) throw new Error("Run this action in a GitHub workflow, on pull_request or pull_request_target events.");
  const reviewBots = flag("review-bots");
  if (pr.draft) {
    core.notice("Draft pull request: no review was paid for.");
    return;
  }
  if (pr.user?.type === "Bot" && !reviewBots) {
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
    // Pull requests opened by Dependabot read Dependabot secrets, so for a bot an empty key can be expected. For a person it means the secret is missing.
    if (pr.user?.type === "Bot") {
      core.warning("payer-key is empty: no review was paid for. Pull requests opened by Dependabot read Dependabot secrets, so add the key there too to review them.");
      return;
    }
    throw new Error("payer-key is empty, so no review was paid for. Check that the repository has the secret and that the workflow names it exactly.");
  }
  core.setSecret(raw);
  const key = `0x${raw.replace(/^0x/i, "")}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("payer-key must be a private key: 64 hex characters, with or without 0x.");
  core.setSecret(key);
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(key as `0x${string}`);
  } catch {
    // viem's error prints the key as a decimal number, which masking its hex form does not hide.
    throw new Error("payer-key is not a valid private key.");
  }

  const preset = presetFor(core.getInput("network") || "mainnet", core.getInput("pay-on") || "base");
  const maxPrice = units(core.getInput("max-price") || "1");
  const waitMinutes = Number(core.getInput("wait-minutes") || "20");
  if (!Number.isFinite(waitMinutes) || waitMinutes < 1 || waitMinutes > 300) throw new Error("wait-minutes must be between 1 and 300.");
  const token = core.getInput("github-token", { required: true });
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
  // The comment is where the order is kept, so a write GitHub fails or does not answer is tried again.
  const save = async (body: string): Promise<IssueComment> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await comment(token, repo, pr.number, body, mine);
      } catch (error) {
        if (!transient(error)) throw error;
        if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
        // GitHub may have saved a new comment without answering. Taking it up makes the retry edit it instead of
        // posting a second, and lets undo() remove it when the payment is not sent.
        if (!mine) mine = await ownComment(token, repo, pr.number, login, MARKER).catch(() => undefined);
        if (attempt === ATTEMPTS) throw error;
      }
    }
  };
  const update = (body: string) =>
    save(body).catch((error: unknown) => {
      core.warning(`Could not update the comment on the pull request: ${failure(error)}`);
    });
  const summarize = (text: string, overwrite = false) =>
    core.summary
      .addRaw(text, true)
      .write({ overwrite })
      .then(() => true)
      .catch((error: unknown) => {
        core.warning(`Could not write the job summary: ${failure(error)}`);
        return false;
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
    core.info(`This commit was paid for already, as order ${posted.order}. Waiting on that order; nothing more is paid.`);
  } else if (mine?.body && orderless(mine.body) === head) {
    // Runs before 1.4.4 named the commit before paying and the order only after, so this one may hide a payment.
    throw new Error(
      `The comment on the pull request names ${short} but no order: an earlier run wrote it before paying and did not record the order after, so this commit may be paid for already, and this run pays nothing. Find the order id on the "Paid" line of the earlier run's log and follow it at ${preset.desk}/x402/tasks/<order id>, or delete the comment and re-run the job to pay for a new review.`,
    );
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
    // core.info writes text as it is, and a line break in a path would start a line the runner reads as a workflow command.
    if (brief.skipped.length) core.info(`Left out of the brief: ${brief.skipped.map(printable).join(", ")}`);
    if (brief.truncated) core.warning("The diff is longer than a BrainChain brief allows, so the review covers its first part only.");

    // Refused before the status comment, so a wrong max-price does not notify the pull request's subscribers.
    const asked = await quote(preset);
    if (asked !== undefined && asked > maxPrice) throw new Error(`${overPrice(preset, asked, maxPrice)} Nothing was charged.`);
    await checkFunds(preset, account.address, maxPrice);

    // The signed payment is sent only once the comment records its order, so a re-run follows that order
    // whatever happens after. Writing it also proves the token can comment before any money moves.
    restore = mine?.body;
    let checkpoint: string | undefined;
    const record = async ({ order, price }: { order: `0x${string}`; price: bigint }) => {
      mine = await save(keep(`BrainChain is reviewing ${short}.`, { order, commit: head, price })).catch((error: unknown) => {
        throw new Error(
          error instanceof GitHubError && [401, 403, 404].includes(error.status)
            ? `Could not comment on the pull request, so no review was paid for.${error.status === 401 ? "" : " The github-token needs pull-requests: write."} ${failure(error)}`
            : `GitHub did not save the comment that records the order, so the payment was not sent and no review was paid for. Re-run the job once GitHub accepts comments. ${failure(error)}`,
        );
      });
      checkpoint = order;
    };
    try {
      posted = await post(preset, account, maxPrice, brief, record);
    } catch (error) {
      await undo();
      throw error;
    }
    const price = `${amount(posted.price)} ${preset.token} on ${preset.chain}`;
    // Paid only once the desk settles it, which it reports while the order is followed.
    const sent = `${posted.uncertain ? "Signed" : "Sent"} a payment of ${price}`;
    // The job summary keeps the order even if the comment cannot be written again.
    await summarize(
      posted.uncertain
        ? `${sent} for the review of ${short}, but BrainChain's confirmation was lost: order \`${posted.order}\`.`
        : `${sent} for the review of ${short}: order \`${posted.order}\`.`,
    );
    core.info(`${sent}. Order ${posted.order}${posted.uncertain ? " (the confirmation was lost; waiting on that order)" : ""}.`);
    const reviewing = keep(
      `BrainChain is reviewing ${short} (order \`${posted.order}\`). The review replaces this comment if Jev accepts it; if not, the payment will be refunded.`,
      { order: posted.order, commit: head, price: posted.price },
    );
    const order = posted.order;
    mine = await save(reviewing).catch((error: unknown) => {
      // The desk names the order the same way the comment does, so this is a safeguard: a re-run must find the order it would follow.
      if (checkpoint !== order) {
        core.setOutput("order", order);
        throw new Error(
          `${sent} as order ${order}, but the comment on the pull request could not record it: ${failure(error)}. The order keeps running at ${preset.desk}/x402/tasks/${order}; write to hello@usebrainchain.com with the order id if its review does not arrive.`,
        );
      }
      core.warning(`Could not update the comment on the pull request: ${failure(error)}. It records order ${order} already, so a re-run follows that order and pays nothing more.`);
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
  // A payment that did not settle leaves no order to follow.
  if (outcome.kind !== "failed") core.setOutput("order", posted.order);
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
      const summarized = await summarize(body);
      // accepted is set once the review is kept somewhere a reader can find it.
      if (superseded) {
        if (summarized) core.setOutput("accepted", "true");
        core.notice(`The pull request moved on to ${newer!.slice(0, 7)} while this review ran, so the review of ${short} is kept in this job's summary and the comment is left to the newer commit.`);
        return;
      }
      const url = await save(body).then(
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
      // A re-run follows the recorded order and only repeats this, so the comment says how to start over.
      if (!superseded) {
        await update(
          keep(
            `Jev did not accept the review of ${short}, so it is not posted and the payment is being refunded. For a new review, delete this comment and re-run the job, or push a new commit if the workflow reviews each push.`,
            paid,
            "is below",
          ),
        );
      }
      core.setOutput("accepted", "false");
      core.notice(`Jev did not accept the review, so it is not posted and the ${amount(posted.price)} ${preset.token} is being refunded to ${account.address} on ${preset.chain}.`);
      return;
    case "refund-failed":
      if (!superseded) await update(keep(`Jev did not accept the review of ${short}. The refund could not be sent automatically, and BrainChain has been alerted.`, paid, "is below"));
      core.setOutput("accepted", "false");
      throw new Error(`Jev did not accept the review, and the refund to ${account.address} could not be sent automatically. BrainChain has been alerted; write to hello@usebrainchain.com with order ${posted.order}.`);
    case "failed":
      await summarize(`The payment of ${amount(posted.price)} ${preset.token} on ${preset.chain} for the review of ${short} did not settle, so nothing was charged.`, true);
      if (!superseded) await undo();
      throw new Error(outcome.reason);
    case "waiting":
      if (outcome.state === "unknown") {
        const lost = posted.uncertain ? ", but its confirmation was lost," : "";
        const check = (where: string) =>
          `Look up ${account.address} in a ${preset.chain} block explorer. If its ${preset.token} transfers show the payment, write to hello@usebrainchain.com with the order id. If they show none ten minutes after the payment was signed, nothing was charged: delete ${where} and re-run the job.`;
        if (!superseded) await update(keep(`The payment for the review of ${short} was signed as order \`${posted.order}\`${lost} and BrainChain has no record of it. ${check("this comment")}`, paid));
        throw new Error(`The payment was signed as order ${posted.order}${lost} and BrainChain has no record of it. ${check("the comment on the pull request")}`);
      }
      if (!superseded) await update(keep(`The review of ${short} is taking longer than this job waits for it. Re-running the job posts it once Jev accepts it, without paying again.`, paid));
      core.warning(
        `No graded review within ${minutes(waitMinutes)} of the job starting, so none is posted yet. The order keeps running, and re-running this job posts the review once Jev accepts it, without paying again: ${preset.desk}/x402/tasks/${posted.order}`,
      );
  }
}

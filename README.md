# BrainChain review

[![CI](https://github.com/usebrainchain/review-action/actions/workflows/ci.yml/badge.svg)](https://github.com/usebrainchain/review-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/usebrainchain/review-action)](https://github.com/usebrainchain/review-action/releases)

Get a frontier model's review on your pull requests, and pay only for reviews that pass BrainChain's grade.

When a pull request opens or leaves draft, the action pays 1 USDC from a wallet you fund. BrainChain hires one of five models (Claude, GPT, Gemini, Grok or DeepSeek) to review the diff and grades the result. An accepted review is posted as a comment. If BrainChain does not accept it, the review is not posted and the 1 USDC goes back to your wallet after the dispute window closes (about six hours).

BrainChain's decision model is Jev, served by TypeSafe, and the job log calls it by name.

Everything sent for review is public: the repository name, the pull request's title and description, the diff and the review are published on BrainChain, and every hire and grade is listed at [usebrainchain.com/decisions](https://usebrainchain.com/decisions). Use the action only on code you can publish.

The action pays nothing for drafts, for pull requests opened by bots or from forks (so outside contributions go unreviewed), or for pull requests over 300 files or 20,000 lines. [Full list](#costs-and-refunds).

## Setup

1. Create a new wallet just for reviews, for example with `cast wallet new` from [Foundry](https://getfoundry.sh) or a new account in your wallet app, and copy its private key: 64 hex characters, with or without `0x`.
2. Send the wallet USDC on Base, only as much as you plan to spend on reviews. Each review costs 1 USDC, and the wallet must hold at least `max-price` (1 USDC unless you change it) for the action to pay. On Base it needs no ETH.
3. Add the private key as a repository secret named `BRAINCHAIN_PAYER_KEY`. It never leaves the runner: the action signs each payment there. If you set `review-bots: true`, add it as a Dependabot secret with the same name too, since pull requests opened by Dependabot read Dependabot secrets only.
4. Add `.github/workflows/review.yml`:

```yaml
name: Review
on:
  pull_request:
    types: [opened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: brainchain-review-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: usebrainchain/review-action@v1
        with:
          payer-key: ${{ secrets.BRAINCHAIN_PAYER_KEY }}
```

To try it without real money first, add `network: testnet` under `with` and fund the wallet with test USDC on Base Sepolia from [Circle's faucet](https://faucet.circle.com). Remove the line to pay on mainnet.

Add `synchronize` to `types` to review again after each push. A run whose commit is no longer the head pays nothing, and a run that has paid finishes even if you push again. If the pull request returns to a commit that was reviewed before a newer one, that commit is paid for again. The `concurrency` group runs one review job per pull request at a time. Keep it: it is what stops two runs for the same commit from both paying.

Reviews are public, so in a private repository the job fails without paying until you add `review-private: true` under `with`. Set it only for code you are willing to publish.

## On the pull request

The action keeps one comment on each pull request. While the review runs, the comment shows its status. It becomes the review if BrainChain accepts it, or says the payment is being refunded if BrainChain does not. When a newer commit is under review, the previous review stays below the status until the new one is accepted.

That comment is also the action's record of what it paid for. The payment is signed on the runner and sent only after the comment records its order, so re-running the job for the same commit follows that order and pays nothing. If GitHub does not save the comment, the payment is not sent. When the payment is never made or does not settle, the action removes the comment or puts the previous one back.

Re-running the job after a rejection only repeats the rejection. To get a new review, delete the comment and re-run the job, which reviews the same commit again, or push a new commit if the workflow runs on `synchronize`.

The job can stop waiting before BrainChain decides on the review. Re-run it once the review is accepted to post it, without paying again. That works as long as no newer commit has been reviewed in the meantime. If BrainChain still has no record of the order when the job stops waiting, the job fails and the comment says how to check the wallet's transfers.

The job summary gets the order once the payment is sent, and the accepted review too.

## What the reviewer sees

The model gets the diff and is asked for real defects only, each with the file, the line and a fix, or a one-line note that the change looks correct. Each line in the new file carries its line number, so findings point at exact lines. The title, cut at 200 characters, and the first 500 characters of the description go in as the author's account of the change, and the model is told to treat them as context only.

Lockfiles, minified files, snapshots and build output (`dist`, `build`, `vendor` and `node_modules`) are left out, as are raster images, web fonts, PDFs, zip archives and WebAssembly. Other binary files appear by name only.

A BrainChain brief holds 32,000 characters and 64,000 bytes, so less of a diff fits when it is written in a script such as Japanese, which takes more bytes per character. For a pull request that changes up to 20 files, each change is shown with up to 20 lines of the file around it; for a larger one, with the three lines the diff carries. The context narrows to make room, and past that the diff is cut. The reviewer is told how much of the diff it was shown, and the job log warns that the review covers only the first part.

The reviewer sees only the diff and the lines around each change, so a finding about other code can be wrong. It is asked to flag any finding that depends on code it was not shown.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `payer-key` | required | Private key of the paying wallet, from a secret: 64 hex characters, with or without `0x`. |
| `pay-on` | `base` | `base` pays in USDC on Base with a signature. `robinhood` pays in USDG on Robinhood Chain through Permit2: approve Permit2 for what you plan to spend, since each review draws the allowance down, and keep a little ETH on Robinhood Chain for the approval's gas. See [Paying from an agent](https://docs.usebrainchain.com/agents). |
| `network` | `mainnet` | `testnet` pays in test USDC on Base Sepolia, from [Circle's faucet](https://faucet.circle.com), or in test USDG on Robinhood Chain testnet. |
| `max-price` | `1` | The most one review may cost. The wallet must hold at least this much, and the action pays nothing above it. |
| `wait-minutes` | `20` | How long the job waits for the graded review, from 1 to 300. It counts from when the action starts, which includes paying but not posting the review. A review accepted after that is still paid for. |
| `review-bots` | `false` | `true` also reviews pull requests opened by bots, such as Dependabot. Dependabot's pull requests read Dependabot secrets only, so add the payer key there too, under the same name. |
| `review-private` | `false` | `true` reviews pull requests in a private repository. Everything sent for review is published on BrainChain, the diff included. |
| `github-token` | `github.token` | Reads the diff and posts the comment. Needs `pull-requests: write`, and `contents: read` for wider context. |

| Output | |
| --- | --- |
| `order` | The BrainChain order id. Set once the payment is sent, when a re-run waits on an order already paid for, when the commit already has a review, and when the job stops waiting. Empty when the payment does not settle. |
| `task-id` | The task's id on BrainChain. Set once the task is posted on BrainChain, including when the job stops waiting after that. |
| `accepted` | `true` once an accepted review is posted, or when the commit already has one. `false` when BrainChain did not accept it. Empty when the job stops waiting first, or skips the pull request for any other reason. |

## Costs and refunds

- 1 USDC per review on Base, or 1 USDG on Robinhood Chain with `pay-on: robinhood`, paid only to the BrainChain payment desk.
- If the review is accepted, 97% goes to the model and 3% is BrainChain's protocol fee.
- If it is not accepted, the price paid is refunded after the dispute window closes: about six hours on mainnet, about an hour on testnet. If no model delivers within 24 hours, it is refunded then. Refunds go to the paying wallet, in the same token on the same chain.
- The job fails before paying if the price is above `max-price`, if the wallet holds less than `max-price`, or, with `pay-on: robinhood`, if Permit2 is not approved for at least `max-price`. It also fails before paying in a private repository unless `review-private` is `true`, and when `payer-key` is empty on a pull request a person opened, which means the secret is missing or misnamed.
- If the review is not accepted and the automatic refund cannot be sent, the job fails and BrainChain is alerted. Write to hello@usebrainchain.com with the order id from the job log.

The action pays nothing, and says why in the job log, for:

- draft pull requests;
- pull requests opened by bots, unless `review-bots` is `true`;
- pull requests from forks, under `pull_request` or `pull_request_target`;
- an empty `payer-key` on a pull request opened by a bot, which reads Dependabot secrets rather than repository secrets;
- pull requests over 300 files or 20,000 lines, for which GitHub gives no diff;
- a diff that changes no lines outside lockfiles, generated and binary files, such as a rename;
- a pull request that has closed, or moved to a newer commit, since the run started.

## Versions

`@v1` always points at the latest 1.x release. To pin one release exactly, use its full commit SHA with the version as a comment, for example `usebrainchain/review-action@<commit SHA> # v1.4.4`. Dependabot's `github-actions` updates keep either form current. Each release is listed on the [releases page](https://github.com/usebrainchain/review-action/releases).

## Security

Report vulnerabilities privately, through **Report a vulnerability** on this repository's [Security tab](https://github.com/usebrainchain/review-action/security) or to security@usebrainchain.com, never in a public issue. [SECURITY.md](SECURITY.md) has the details.

## Links

- [How BrainChain works](https://usebrainchain.com/how-it-works)
- [Paying from an agent](https://docs.usebrainchain.com/agents), the API this action uses
- [Code review brief](https://docs.usebrainchain.com/task-templates#code-review), the task the action posts
- [brainchain-mcp](https://www.npmjs.com/package/brainchain-mcp), the same tasks from Claude Code or Cursor

## License

MIT. See [LICENSE](LICENSE).

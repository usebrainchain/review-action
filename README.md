# BrainChain review

Have a frontier model review your pull requests, and pay only for a review that passes Jev's grade.

When a pull request opens or leaves draft, the action pays 1 USDC from a wallet you fund. Jev, a decision model from TypeSafe, hires one of five models (Claude, GPT, Gemini, Grok or DeepSeek) to review the diff and grades the result. An accepted review is posted as a comment. If Jev does not accept it, the review is not posted and the 1 USDC goes back to your wallet after the dispute window closes (about six hours).

Everything sent for review is public: the repository name, the pull request's title and description, the diff and the review are published on BrainChain, and every hire and grade is listed at [usebrainchain.com/decisions](https://usebrainchain.com/decisions). Use the action only on code you can publish.

The action pays nothing for drafts, pull requests opened by bots, pull requests from forks (so outside contributions are not reviewed) or pull requests over 300 files or 20,000 lines. [Full list](#costs-and-refunds).

## Setup

1. Create a wallet for reviews and send it USDC on Base. Each review costs 1 USDC; the wallet needs no ETH.
2. Add its private key as a repository secret named `BRAINCHAIN_PAYER_KEY`.
3. Add `.github/workflows/review.yml`:

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

Add `synchronize` to `types` to review again after each push. A run whose commit is no longer the head pays nothing, and a run that has paid finishes even if you push again. If the pull request returns to a commit that was reviewed before a newer one, that commit is paid for again. The `concurrency` group runs one review job at a time for each pull request.

Use a wallet that holds only what you plan to spend on reviews. The key never leaves the runner: the action signs each payment locally.

## On the pull request

The action keeps one comment per pull request. It posts a status line before paying and records the order there, so re-running the job for the same commit pays nothing. The comment becomes the review if Jev accepts it, or says the payment is being refunded if not. If the job stops waiting first, re-run it once the review is accepted to post it; this works while no newer commit has been reviewed since. If the payment is never made, the comment is removed or the previous one is put back. While a newer commit is reviewed, the earlier review stays below the status until the new one is accepted. Accepted reviews are also written to the job summary.

## What the reviewer sees

The model gets the diff and is asked for real defects only, each with the file, the line and a fix, or a one-line note that the change looks correct. Each line in the new file carries its line number, so findings point at exact lines. The title, cut at 200 characters, and the first 500 characters of the description go in as the author's account of the change, and the model is told to treat them as context only.

Lockfiles, minified files, snapshots and build output (`dist`, `build`, `vendor` and `node_modules`) are left out, as are raster images, web fonts, PDFs, zip archives and WebAssembly. Other binary files appear by name only.

A BrainChain brief holds 32,000 characters. For a pull request that changes up to 20 files, each change is shown with up to 20 lines of the file around it; for a larger one, with the three lines the diff carries. The context narrows to make room, and past that the diff is cut. The reviewer is told how much of the diff it was shown, and the job log warns that the review covers only the first part.

The reviewer sees only the diff and the lines around each change, so a finding about other code can be wrong. It is asked to flag any finding that depends on code it was not shown.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `payer-key` | required | Private key of the paying wallet, from a secret. |
| `pay-on` | `base` | `base` pays in USDC on Base with a signature. `robinhood` pays in USDG on Robinhood Chain and needs a one-time Permit2 approval; see [Paying from an agent](https://docs.usebrainchain.com/agents). |
| `network` | `mainnet` | `testnet` pays in test USDC on Base Sepolia, from [Circle's faucet](https://faucet.circle.com), or in test USDG on Robinhood Chain testnet. |
| `max-price` | `1` | The most one review may cost. The wallet must hold at least this much, and the action pays nothing above it. |
| `wait-minutes` | `20` | How long the job waits for the graded review, from 1 to 300. The time counts from when the action starts, so it includes paying but not posting the review. A review Jev accepts later is still paid for. |
| `review-bots` | `false` | `true` also reviews pull requests opened by bots, such as Dependabot. |
| `github-token` | `github.token` | Reads the diff and posts the comment. Needs `pull-requests: write`, and `contents: read` for wider context. |

| Output | |
| --- | --- |
| `order` | The BrainChain order id. Set once the action pays, when a re-run waits on an order already paid for, and when the commit already has a review. Also set when the job stops waiting. |
| `task-id` | The task's id on BrainChain. Set once the task is posted on BrainChain, including when the job stops waiting after that. |
| `accepted` | `true` once an accepted review is posted, or when the commit already has one. `false` when Jev did not accept it. Empty when the job stops waiting first, or skips the pull request for any other reason. |

## Costs and refunds

- 1 USDC per review, paid only to the BrainChain payment desk.
- If Jev accepts the review, the model receives 0.97 USDC and 0.03 USDC is BrainChain's protocol fee.
- If Jev does not accept it, the price paid is refunded after the dispute window closes: about six hours on mainnet, about an hour on testnet. If no model delivers within 24 hours, it is refunded then. Refunds go to the paying wallet, in the same token on the same chain.
- The job fails before paying if the price is above `max-price`, if the wallet holds less than `max-price`, or, with `pay-on: robinhood`, if Permit2 is not approved for at least `max-price`. It also fails if Jev did not accept the review and the automatic refund could not be sent; BrainChain is alerted, and you can write to hello@usebrainchain.com with the order id from the job log.

The action pays nothing, and says why in the job log, for:

- draft pull requests;
- pull requests opened by bots, unless `review-bots` is `true`;
- pull requests from forks, under `pull_request` or `pull_request_target`;
- a missing `payer-key` secret, with a warning that names the likely cause;
- pull requests over 300 files or 20,000 lines, for which GitHub gives no diff;
- a diff that changes no lines outside lockfiles, generated and binary files, such as a rename;
- a pull request that has closed, or moved to a newer commit, since the run started.

## Links

- [How BrainChain works](https://usebrainchain.com/how-it-works)
- [Paying from an agent](https://docs.usebrainchain.com/agents), the API this action uses
- [brainchain-mcp](https://www.npmjs.com/package/brainchain-mcp), the same tasks from Claude Code or Cursor

MIT License.

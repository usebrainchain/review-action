# Changelog

## 1.5.1

Payments:

- A payment authorization is signed only when the desk's terms give its lifetime as a whole number of seconds up to 600. A lifetime sent as text no longer turns into one that never lapses.
- With the workflow token or an App's token, a re-run no longer pays a second time for a commit when another App has posted a newer comment that starts with this action's marker. The action follows its own record of the commit wherever it sits among the bots' comments.

## 1.5.0

Two changes can turn a run red that used to pass. A private repository is no longer reviewed unless `review-private: true` is set: a review is a public BrainChain task, so the pull request's title, description and diff would be published. And a person's pull request now fails when `payer-key` is empty, instead of passing with no review; a bot's still only warns.

Payments:

- A re-run with a personal `github-token` no longer pays a second time when GitHub's user lookup fails.
- A payment that was signed but never recorded by BrainChain fails the run and says how to check the payer's transfers.
- The log says the payment was signed or sent until BrainChain confirms it, and the job summary says when a payment did not settle.
- The request that carries the payment has its own timeout, so a stalled answer cannot hold the job open.

Briefs and comments:

- A long diff in Chinese, Japanese or Korean is fitted to the desk's 64,000-byte limit.
- Only the title, the brief and the quality levels are sent to the desk.
- A long review stays under GitHub's comment limit, and the final review is posted with retries.

Messages show GitHub's own error text, such as "Bad credentials", check every input with a plain message, and the Permit2 advice asks for an allowance that covers the reviews you plan, with a note that the approval needs gas.

## 1.4.4

The comment on the pull request records the order before the payment is sent, so a re-run for the same commit follows that order and pays nothing.

Versions up to 1.4.3 posted the status before paying and added the order after. If GitHub saved the first write but not the second, the comment names the commit but no order. A run for that commit now stops without paying, and its log says how to find the earlier order or start a new review.

# Security policy

Report vulnerabilities privately: use **Report a vulnerability** on this repository's [Security tab](https://github.com/usebrainchain/review-action/security), or email **security@usebrainchain.com**. Do not open a public issue, discussion or pull request.

Include the version you used (tag or commit SHA), the impact you see, and steps or a test that reproduce it. Leave out private keys and other secrets.

We acknowledge reports within 3 business days and send an assessment and a planned fix date within 10. Reporters are credited in the advisory unless they prefer otherwise. Please give us reasonable time to fix an issue before disclosing it, and do not test against wallets or funds you do not own.

## Supported versions

Fixes ship in the latest 1.x release, which `@v1` points at. Workflows pinned to an older tag or commit SHA need to update to receive them.

## Scope

Of particular interest in this action:

- the payer key leaving the runner, or reaching the job log, the comment or the brief;
- a payment to any address other than the BrainChain payment desk, or above `max-price`;
- paying twice for the same commit, or paying for a pull request the action says it skips;
- text from a pull request that changes what the action posts or pays.

The full policy, including what is out of scope and how awards are paid, is on the [security page](https://docs.usebrainchain.com/security).

# Contributing

Bug reports and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach. Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

## Development

You need Node.js 24.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The action runs from `dist/index.js`, which is committed. Run `npm run build` after any change to `src` or to a dependency and commit the result: CI rebuilds it and fails if `dist` differs from the source.

To try a change end to end, run the action from your branch in a repository of your own with `network: testnet`, which pays in test USDC on Base Sepolia or test USDG on Robinhood Chain testnet.

## Pull requests

- One change per pull request, with what it does and why.
- A test for every change in behaviour.
- The README and `action.yml` updated where inputs, outputs or behaviour change.

Pull requests are squash-merged once CI passes. By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

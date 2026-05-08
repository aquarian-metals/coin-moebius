# @aquarianmetals/coin-moebius-provider-template

Starter template for building a [Coin Moebius](https://github.com/aquarian-metals/coin-moebius) payment provider.

Copy this folder, rename the package to `@your-scope/coin-moebius-<gateway>`, and implement two things:

1. `src/index.ts` — a browser-side `initiate()` that triggers the gateway's flow.
2. `src/server.ts` — a Node-only verifier function exported under the `./server` subpath.

`@aquarianmetals/coin-moebius-core` is declared as a **peer dependency** — your consumers install it once and your provider plugs into it.

See [CONTRIBUTING.md](https://github.com/aquarian-metals/coin-moebius/blob/main/CONTRIBUTING.md) for the full contract.

## License

MIT — see [LICENSE](./LICENSE).

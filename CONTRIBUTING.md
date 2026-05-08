PRs for providers and docs are welcome. Start from `packages/providers/template`.

Your provider does not have to land in this monorepo. Publish `@your-scope/coin-moebius-whatever` yourself (same pattern as `@aquarianmetals/...`), with a browser entry plus `./server`, write down how callers should `npm install`, `registerVerifier`, and wire env vars. If you want it listed somewhere public, send a README PR linking the npm page.

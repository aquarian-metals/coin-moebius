# Security policy

## Reporting a vulnerability

If you've found a security issue in `@aquarian-metals/coin-moebius` or any of its sibling packages, please email **theaquarian@aquarianmetals.com** rather than opening a public issue.

What we'd love in the report:

- A short description of the vulnerability and its impact.
- Reproduction steps or a minimal proof of concept.
- The package(s) and version(s) affected.
- Your preferred attribution name (if any).

We aim to acknowledge reports within 72 hours, post a CVE within 7 days when a fix is ready, and ship a patch within 14 days of acknowledgement. Critical issues (signature-bypass, secret leakage, RCE) get faster turnaround.

We do not currently run a paid bug bounty program. Responsible disclosure is acknowledged in the release notes for the fix.

## Scope

In-scope:

- The `@aquarian-metals/coin-moebius-*` npm packages.
- The published `sdk.global.js` bundle and its CDN mirrors (jsDelivr, unpkg).

Out of scope (please do not test):

- Third-party services we integrate with (Stripe, NOWPayments, Cryptomus, Resend, Cloudflare). Report those upstream.
- Denial-of-service through high request volume. Rate limits exist; brute-forcing them is unwelcome.
- Social engineering of Coin Moebius staff or customers.

## Public disclosure timeline

Once a patch is released, the advisory is published at:

- GitHub Security Advisories on the `coin-moebius` repo.
- A `## Security` section in the patched version's `CHANGELOG.md`.

Reporter credit (with your permission) appears in the advisory.

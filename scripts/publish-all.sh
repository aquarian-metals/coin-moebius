#!/usr/bin/env bash
# Publish every PUBLIC package at its current package.json version, moving the
# `latest` tag to that version. (This release: v3.0.0.)
#
# Why this script instead of `changeset publish` / `npm publish --workspaces`:
#   - The fixed-group changesets resolve to 1.0.0, which already exists on npm.
#   - `npm publish --workspaces` chokes on the private demo's null version and
#     tries to pack the private element package.
# So we publish each public package from its own directory, explicitly.
#
# Idempotent: a package already at 0.9.0 on the registry is skipped, so it's
# safe to re-run if some succeed and others fail.
#
# Auth: needs a real publish token. Either run `npm login` in this terminal
# (a browser opens — your npm `auth-type` is `web`), or drop an Automation
# token into ~/.npmrc:  //registry.npmjs.org/:_authToken=npm_xxx
#
# Usage:  bash scripts/publish-0.9.0.sh [--otp <code>]

set -o pipefail  # not -u: macOS bash 3.2 trips on empty-array expansion
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OTP_ARG=()
[[ "${1:-}" == "--otp" && -n "${2:-}" ]] && OTP_ARG=(--otp "$2")

ok=0; skip=0; fail=0; failed=()
for f in "$ROOT"/packages/*/package.json "$ROOT"/packages/providers/*/package.json; do
  [[ "$(jq -r '.private // false' "$f")" == "true" ]] && continue
  dir="$(dirname "$f")"; name="$(jq -r '.name' "$f")"; ver="$(jq -r '.version' "$f")"

  published="$(curl -fsS "https://registry.npmjs.org/${name}" 2>/dev/null | jq -r --arg v "$ver" '.versions[$v].version // empty')"
  if [[ -n "$published" ]]; then
    printf '  - skip  %s@%s (already published)\n' "$name" "$ver"; skip=$((skip+1)); continue
  fi

  # --ignore-scripts: dist/ is already built (run `npm run build` first), so we
  # skip each package's prepublishOnly rebuild. That keeps the whole burst fast
  # enough to finish inside one OTP window.
  if ( cd "$dir" && npm publish --access public --tag latest --ignore-scripts "${OTP_ARG[@]}" ); then
    printf '  ✓ %s@%s\n' "$name" "$ver"; ok=$((ok+1))
  else
    printf '  ✗ %s@%s\n' "$name" "$ver"; fail=$((fail+1)); failed+=("$name")
  fi
done

printf '\n=== published %d, skipped %d, failed %d ===\n' "$ok" "$skip" "$fail"
if (( fail > 0 )); then printf 'FAILED: %s\n' "${failed[*]}"; exit 1; fi

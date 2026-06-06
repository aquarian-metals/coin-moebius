#!/usr/bin/env bash
set -euo pipefail

# Bump all workspace versions, commit, tag, and push.
# The GitHub Actions release workflow handles npm publish + GitHub Release.
#
# Usage:
#   ./scripts/release.sh          # auto-increment patch (0.7.0 -> 0.7.1)
#   ./scripts/release.sh minor    # auto-increment minor (0.7.1 -> 0.8.0)
#   ./scripts/release.sh 0.9.0    # explicit version
#
# Major versions (1.0.0, 2.0.0, ...) are blocked. Push those manually
# when you're ready for a real major release.

CURRENT=$(node -p "require('./packages/core/package.json').version")

if [[ $# -eq 0 ]] || [[ "$1" == "patch" ]]; then
  IFS='.' read -r major minor patch <<< "$CURRENT"
  NEXT="$major.$minor.$((patch + 1))"
elif [[ "$1" == "minor" ]]; then
  IFS='.' read -r major minor _patch <<< "$CURRENT"
  NEXT="$major.$((minor + 1)).0"
else
  NEXT="$1"
fi

IFS='.' read -r next_major _ _ <<< "$NEXT"
IFS='.' read -r curr_major _ _ <<< "$CURRENT"
if [[ "$next_major" -gt "$curr_major" ]]; then
  echo "ERROR: Major version bump ($CURRENT -> $NEXT) is blocked."
  echo "If you really mean it, bump versions and tag manually."
  exit 1
fi

echo "Releasing: $CURRENT -> $NEXT"

# Update every package.json (version field + peer dep references).
find . -name package.json -not -path '*/node_modules/*' -not -path '*/.git/*' \
  -exec grep -l "\"$CURRENT\"" {} \; | while read -r f; do
  sed -i '' \
    -e "s/\"version\": \"$CURRENT\"/\"version\": \"$NEXT\"/g" \
    -e "s/\"\\^$CURRENT\"/\"\\^$NEXT\"/g" \
    "$f"
done

npm install --package-lock-only --silent

git add -A
git commit -m "v$NEXT"
git tag "v$NEXT"
git push origin main "v$NEXT"

echo ""
echo "Done. The release workflow will publish v$NEXT to npm and create the GitHub Release."

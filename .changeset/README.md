# Changesets

This folder holds in-progress changeset files. Each changeset is a Markdown file describing one logical change to the SDK, along with which packages it affects and how the version should bump (patch / minor / major).

## How to add a changeset

When you make a change worth tracking in the CHANGELOG:

```bash
npm run changeset
```

The CLI asks you which packages changed and what type of bump (patch/minor/major), then prompts for a summary. It writes a randomly-named `*.md` file to this folder.

Commit that file alongside your code change.

## How releases work

All publishable packages move in **lockstep** (configured as `fixed` in `config.json`) — any package's bump rolls every package to the same version. This matches the pre-1.0 promise in `CHANGELOG.md`: "any release may break shape; pin a caret range like `^0.2.0` so a single bump rolls the whole family forward."

To cut a release:

```bash
npm run version-packages    # applies pending changesets, bumps versions, updates CHANGELOG
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z
git push --tags             # triggers the release GitHub Action
```

The release workflow runs `npm run release` which builds + publishes every public workspace via `npm publish --workspaces`.

## Format reference

Changeset files look like this:

```markdown
---
'@aquarian-metals/coin-moebius-core': minor
'@aquarian-metals/coin-moebius-stripe': minor
---

Brief description of the change. Renders into the CHANGELOG verbatim.

Longer prose is fine — bullet points, code samples, migration notes.
```

Only list the packages whose API actually changed. Because we use `fixed` mode, Changesets will still bump every package in the fixed group to the highest bump level you specify, but the CHANGELOG entries only show the packages you mentioned.

## Skipping a changeset

If a change really isn't worth a CHANGELOG entry (a typo fix, a docs-only tweak, a CI tweak), commit without running `changeset add`. The release tooling won't complain about commits with no changesets. But default to adding one — it's cheap, and CHANGELOG entries from after-the-fact recall are always worse than written-in-the-moment.

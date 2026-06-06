# Releasing

How to publish a new version of the SDK to npm.

## Prerequisites

- You must be on the `main` branch with a clean working tree.
- All CI checks must pass (the pre-push hook enforces this).

## Steps

### 1. Create changesets for your changes

Each meaningful change needs a changeset file. Run this and follow the prompts:

```bash
npx changeset
```

Pick the affected packages and the bump level (patch/minor/major). Commit the generated `.changeset/*.md` file with your feature branch.

### 2. Consume changesets and bump versions

```bash
npx changeset version
```

This deletes the `.changeset/*.md` files, updates every `package.json` version, and writes CHANGELOGs. All packages in the fixed group (see `.changeset/config.json`) stay in lockstep.

### 3. Commit the version bump

```bash
git add -A
git commit -m "v<VERSION>"
```

### 4. Tag and push

```bash
git tag v<VERSION>
git push origin main
git push origin v<VERSION>
```

Pushing the `v*` tag triggers the `release.yml` GitHub Actions workflow, which publishes all public workspaces to npm via OIDC Trusted Publishing. No tokens or secrets are involved.

## Adding a new package

When you add a new workspace package to the monorepo:

1. **Publish it manually first.** npm Trusted Publishing requires the package to already exist on the registry. From the package directory:

   ```bash
   npm login
   npm publish --access public
   ```

   This will prompt for browser-based 2FA.

2. **Configure Trusted Publishing on npmjs.com.** Go to `npmjs.com/package/<package-name>/access`, find the Trusted Publisher section, click GitHub Actions, and fill in:

   | Field             | Value             |
   | ----------------- | ----------------- |
   | Organization      | `aquarian-metals` |
   | Repository        | `coin-moebius`    |
   | Workflow filename | `release.yml`     |
   | Environment       | (leave blank)     |
   | Allowed actions   | `npm publish`     |

3. **Add it to the fixed group** in `.changeset/config.json` so its version stays in lockstep with the rest of the SDK.

## How publishing works

The `release.yml` workflow:

- Uses OIDC Trusted Publishing (no npm tokens or secrets).
- Requires `id-token: write` permission for GitHub to mint the OIDC token.
- Upgrades npm to >= 11.5.1 (Node 22 ships with npm 10.x, which lacks OIDC support).
- Does NOT use `registry-url` in `actions/setup-node` (it conflicts with OIDC auth).
- Publishes each public workspace individually (npm 11.x crashes with `--workspaces` when a private package is present).

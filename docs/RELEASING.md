# Release the SDK

The SDK releases its public npm packages together. Run the release from a clean, current main checkout using the publisher's existing npm and GitHub credentials.

1. Fetch the remote main and tags, integrate the reviewed changes, and check that the selected version is available across the public workspaces.
2. Run `npm whoami` to check the publisher and `npm run verify` to run the repository checks. Complete the applicable payment checks in [the payment security review](payment-security-review.md).
3. Run `npm run release -- X.Y.Z`. The script updates package versions and the lockfile, runs verification, publishes the public packages, then commits, tags and pushes the version.
4. Run `npm run check:sync` and verify the release version on GitHub and npm, including each affected provider. If an operation stops midway, inspect the working tree, remote tag and registry entries before resuming. Only publish missing artifacts from the same verified build.

The repository's GitHub Actions workflow runs CI. The release script performs publication locally. For a hosted service that imports the SDK, rebuild and deploy that service from the verified release and run a post-deployment check.

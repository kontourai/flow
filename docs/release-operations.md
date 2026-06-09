# Release Operations

Flow publishes the public npm package `@kontourai/flow` from the `Publish NPM`
GitHub Actions workflow.

## npm Trusted Publishing

The publish workflow is designed for npm trusted publishing, not a long-lived
repository token. The npm package settings must include this trusted publisher:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `kontourai` |
| Repository | `flow` |
| Workflow filename | `publish-npm.yml` |
| Allowed action | `npm publish` |

The workflow grants `id-token: write` on the publish job and uses Node 24, which
lets npm exchange the GitHub Actions OIDC token for publish authority. npm
generates provenance automatically for trusted publishing, so the workflow calls
`npm publish --access public` without a long-lived `NODE_AUTH_TOKEN`.

## Release Checklist

1. Merge the release preparation pull request to `main`.
2. Confirm `package.json` contains the intended version.
3. Push tag `v<package.json version>` at the `main` commit.
4. Wait for the `Publish NPM` workflow.
5. Confirm `npm view @kontourai/flow@<version> version` returns the new version.

If the publish job fails with npm `E404 Not Found - PUT` and npm says the
package could not be found or the publisher lacks permission, verify the trusted
publisher settings above on npmjs.com. The same error can occur when the package
exists but the GitHub Actions identity is not authorized to publish it.

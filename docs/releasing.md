<!-- markdownlint-disable MD013 -->

# Releasing

The package is published to npm and listed in the [Pi package gallery](https://pi.dev/packages/stepstone).
The `pi-package` npm keyword and the `pi.extensions` manifest field let the gallery discover releases automatically, without a separate submission process.

Publishing runs in CI, not from a maintainer's machine.
Pushing a `v*.*.*` tag is what publishes; a commit or merge to `main` never does.

## Choosing the version bump

The package is below 1.0, so a breaking change takes a minor bump and a compatible one takes a patch.

Breaking means a surface the published package exposed stops working: a `bin` the manifest no longer publishes, a documented integration that was retired, a field dropped from a `--json` result, a renamed command or flag.
Those are the releases that break a configuration someone already committed, and the version is the only signal a client resolving `@latest` reads before it upgrades.
The workflow's generated release notes name the pull requests merged since the previous tag, so what was removed is described there; the bump is what makes a consumer notice before reading them.

## Cutting a release

Start from a clean, current `main` branch:

```sh
git switch main
git pull --ff-only
```

Optionally run the release checks locally, the same `npm run verify` and `npm run no-pi-install:check` the release workflow runs, but with faster feedback than waiting on CI:

```sh
npm ci
npm run verify
npm run no-pi-install:check
```

Create the release commit and tag with the appropriate semantic version bump:

```sh
npm version patch
# `npm version minor` when the release removes or renames a published surface.
```

A `preversion` hook runs `npm run docs:check` first, so a checkout whose generated documents are stale fails before the version is bumped and before any tag exists.
Regenerate them with `npm run docs` in the commit that made them stale rather than folding them into the release commit.

Push the version commit and its tag, which is the step that publishes:

```sh
git push origin main --follow-tags
```

That tag push runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which re-runs `npm run verify` and `npm run no-pi-install:check` against the tagged commit, publishes to npm, and creates a GitHub Release with notes generated from the pull requests merged since the previous tag.
It refuses to publish when the tag disagrees with `package.json`, which is the mistake that would otherwise ship the wrong version under the right name.

Authentication is npm Trusted Publishing over OIDC, so the repository stores no `NPM_TOKEN` and a release needs no local `npm login`.
npm attaches build provenance to every tarball published this way, letting an installer verify the package was built from this repository at that commit.
The trust relationship is configured once on npm, under the package's Trusted Publishers settings, naming this repository and the `release.yml` workflow filename; a workflow renamed or moved needs that entry updated or every publish will be rejected.

Verify npm, Pi installation, and the gallery after the workflow finishes:

```sh
npm view stepstone version
pi update npm:stepstone
```

Each npm version is immutable, so bump the version before every subsequent publication.
A run that failed before `npm publish` published nothing, so delete the tag, fix the cause, and tag again.
A run that failed after it cannot be retried on the same version, because npm already has it; finish the remaining steps by hand or release the fix as a new version.
The Pi gallery may take a short time to refresh after npm accepts a release.

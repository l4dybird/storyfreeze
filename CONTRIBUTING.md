# Contribution

<!-- toc -->

- [Directory structure](#directory-structure)
- [Setup](#setup)
- [Lint and format](#lint-and-format)
- [Build](#build)
  - [Build all packages](#build-all-packages)
  - [Build a specific package](#build-a-specific-package)
- [Unit test](#unit-test)
  - [Test all packages](#test-all-packages)
  - [Test a specific package](#test-a-specific-package)
- [E2E test](#e2e-test)
  - [All fixtures](#all-fixtures)
  - [Single fixture](#single-fixture)
- [Package changes and releases](#package-changes-and-releases)
- [Update documents' ToC and CLI usage section](#update-documents-toc-and-cli-usage-section)

<!-- tocstop -->

## Directory structure

This repository is a pnpm workspace.

Each package has the following role:

- `packages/storyfreeze` : Contains StoryFreeze's main application source code and its browser runtime for capturing screenshots.

## Setup

Clone this repository and execute the following:

```sh
$ corepack enable
$ pnpm install --frozen-lockfile
```

The workspace only resolves direct and transitive dependency versions that
have been available from the npm registry for at least 24 hours. The pnpm
version in `packageManager` is also updated only after it has been published for
24 hours. If an update is initially rejected or CI fails because it is too new,
wait until 24 hours after publication and retry; do not bypass the restriction.
An emergency exception must be proposed in a separate pull request using a
complete `package@version` and requires review.

## Lint and format

```sh
$ pnpm lint     # runs oxlint
$ pnpm format   # runs oxfmt
```

## Build

### Build all packages

```sh
$ pnpm build
```

### Build a specific package

```sh
$ pnpm --filter <package-name> build
```

## Unit test

### Test all packages

```sh
$ pnpm test
```

### Test a specific package

```sh
$ pnpm --filter <package-name> test
```

## E2E test

### All fixtures

```sh
$ pnpm e2e
```

This runs the existing Storybook 10 fixture against the packed StoryFreeze
tarball. Run `pnpm build` first when invoking a packing command directly;
dependency installation and `npm pack` intentionally do not compile the package.

### Single fixture

Run the fixture script directly to test a single example:

```sh
$ pnpm --dir examples/react-vite test:storybook10-e2e
```

## Package changes and releases

Add a Changeset for every user-visible package change:

```sh
$ pnpm exec changeset
```

Changesets only creates the version pull request. Do not run `changeset
publish`: the dedicated release workflow publishes the inspected tarball after
the version pull request is merged.

| Package version | npm dist-tag | GitHub Release |
| --------------- | ------------ | -------------- |
| `x.y.z-alpha.n` | `next`       | Prerelease     |
| `x.y.z-rc.n`    | `next`       | Prerelease     |
| `x.y.z`         | `latest`     | Final release  |

Any other prerelease suffix is rejected before publishing. Moving from alpha
to RC, or from prerelease to stable, requires a dedicated pull request that
updates the Changesets prerelease state and reviews the generated version.

The publish workflow packs once, passes that tarball to the existing package
smoke, and publishes the same file through npm Trusted Publishing. It verifies
integrity, provenance, the channel's dist-tag for a new publication, the Git
tag, and the GitHub Release classification. Rerunning an already-published
version verifies the immutable package without moving a newer dist-tag
backwards.

## Update documents' ToC and CLI usage section

We insert ToC and CLI usage section to some Markdown files(e.g. README.md) using script. If you touch `*.md` files or add an option to CLI, please exec the following command when you stage the changes:

```sh
$ pnpm doc
```

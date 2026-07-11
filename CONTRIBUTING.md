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
  - [All compatibility fixtures](#all-compatibility-fixtures)
  - [Single fixture](#single-fixture)
- [Update documents' ToC and CLI usage section](#update-documents-toc-and-cli-usage-section)

<!-- tocstop -->

## Directory structure

This repository adopts mono-repo structure using Lerna.

Each package has the following role:

- `packages/storyfreeze` : Contains StoryFreeze's main application source code. This packages has a responsibility for capturing screenshots and depends on `storycrawler`.

## Setup

Clone this repository and execute the following:

```sh
$ yarn --frozen-lockfile
$ yarn bootstrap
```

## Lint and format

```sh
$ yarn lint     # runs eslint
$ yarn format   # runs prettier --write
```

## Build

### Build all packages

```sh
$ yarn build
```

### Build a specific package

```sh
$ cd packages/<package-name>
$ yarn build
# or
$ yarn run tsc -p tsconfig.build.json
```

## Unit test

### Test all packages

```sh
$ yarn test
```

### Test a specific package

```sh
$ cd packages/<package-name>
$ yarn test
# or
$ yarn run jest
```

## E2E test

### All compatibility fixtures

```sh
$ ./e2e.sh
```

During the Storybook 10 migration, the command succeeds only when each fixture
reaches its recorded compatibility failure. Once StoryFreeze can capture the
fixture, this check will be converted back to a screenshot-producing E2E test.

### Single fixture

And `e2e.sh` also accepts a specific storybook example's name. For example:

```sh
$ ./e2e.sh examples/react-vite
```

## Update documents' ToC and CLI usage section

We insert ToC and CLI usage section to some Markdown files(e.g. README.md) using script. If you touch `*.md` files or add an option to CLI, please exec the following command when you stage the changes:

```sh
$ yarn doc
```

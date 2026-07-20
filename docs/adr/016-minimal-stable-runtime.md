# ADR-016: Minimal stable runtime and release evidence

- Status: Accepted; representative performance gate pending
- Date: 2026-07-20
- Applies to: StoryFreeze 0.2 stable contract
- Supersedes: ADR-009 through ADR-015

## Context

Before the stable release, StoryFreeze accumulated multiple browser backends,
capture modes, browser topologies, planning formats, diagnostics, and benchmark
runners. Most of that code remained reachable and therefore had to be tested as
product behavior. It did not represent dead files that could be removed without
changing the contract.

The pre-cleanup repository contained 87 TypeScript files. Production runtime
was about 7,500 lines, while benchmark implementation and tests were about
9,000 lines. Pull-request CI consumed about 519 hosted runner seconds, with a
large share spent on mode comparisons, duplicate package smoke checks, and
documentation gates.

The stable product needs one optimized path rather than a matrix of diagnostic
or compatibility paths.

## Decision

StoryFreeze supports Storybook 10 static or hosted builds with the StoryFreeze
addon. It fetches `index.json`, filters and shards stories, groups known
viewport profiles, and assigns deterministic queues to no more than four
Playwright/Chromium workers by default.

Each worker owns one browser process, one context, and one persistent managed
Preview page. Stories are switched through the correlated Storybook Preview
protocol and variants are remounted in that page. Width and height changes use
live resizing. Mobile, touch, or device-pixel-ratio boundaries, a session fault,
a timeout, or 128 completed screenshots recreate the context.

The runtime preserves the public package exports and `ScreenshotOptions`,
including variants, viewport globals, interactions, waits, deprecated
`waitImages`, and the public reset callback. It also preserves output paths,
atomic writes, path containment and collision checks, the 64 MiB screenshot
buffer limit, retry and fail-stop behavior, sandboxed browser defaults, and
explicit launch options.

Worker boot receives the process abort signal. Abort starts idempotent cleanup
immediately and all boot/close operations are drained before Storybook is
disconnected. Playwright's 30-second launch timeout is the lifecycle safety
default; a missing, invalid, or explicitly disabled launch timeout cannot create
an unbounded startup. Positive explicit values below that limit are preserved;
larger values are capped at 30 seconds so abort cleanup remains bounded.

The CLI exposes only capture inputs and Playwright launch settings. Runtime
modes, browser topology, tracing, server lifecycle, diagnostics, watcher tuning,
and context lifetime are internal decisions and are not configurable.

The waiting sequence is fixed:

1. Storybook render and play completion
2. application `waitFor` and configured delay
3. focus, hover, and click interactions
4. pending network assets
5. fonts, images, and image decoding
6. two animation frames
7. screenshot and atomic write

Chromium resolution remains explicit path, explicit channel, Playwright-managed
Chromium, Canary, then stable Chrome. Browser installation remains explicit;
StoryFreeze does not download a browser from an install script.

## State isolation trade-off

A persistent Preview avoids booting the entire Storybook document for every
image. Storybook's teardown, render, play, and force-remount boundaries are the
component-state isolation contract. The public reset callback remains available
for application-owned state outside that lifecycle, and a rejected callback
fails the capture.

Arbitrary module globals or browser globals are not reset by recreating a
document for every story. The bounded 128-image context lifetime, hard protocol
correlation, render-error checks, capture deadline, retry recovery, terminal
drain, and decoded-RGBA release gate constrain this risk. A separate fresh-page
mode is intentionally not part of the stable product.

## Validation model

Pull-request CI is limited to checks that defend the shipped contract:

- Linux Node 22: format, lint, build, unit tests, one packed-package smoke, and
  release metadata
- Linux Node 24: build and unit tests
- Windows Node 22: build and unit tests
- Linux Node 22: the existing Storybook 10 managed static E2E

The package smoke checks metadata, engines and dependencies, root/preview/preset
exports, CLI help and unknown-option handling, one TypeScript consumer,
Storybook 10.0 and 10.4 preset loading, and that the consumer installed a packed
tarball rather than workspace source. It does not maintain an exact package-file
allowlist or test the absence of every historical dependency.

The following measurements use the same commands on RC.2 commit `63dbda8` and
the Phase 6M candidate. “Production lines” means physical lines in non-test
TypeScript files; it is reported for scale and is not a release gate.

| Measure                     |      RC.2 | Phase 6M | Change |
| --------------------------- | --------: | -------: | -----: |
| TypeScript files            |        87 |       59 | -32.2% |
| Production TypeScript files |        55 |       37 | -32.7% |
| Production physical lines   |    10,629 |    4,737 | -55.4% |
| Script files                |        26 |       13 | -50.0% |
| Workflow files              |         5 |        4 | -20.0% |
| Packed package files        |       223 |      151 | -32.3% |
| Tarball bytes               |   188,030 |  100,580 | -46.5% |
| Unpacked bytes              |   882,090 |  419,514 | -52.4% |
| Pull-request runner seconds | about 519 |      287 | -44.7% |

Performance is a release decision, not a pull-request benchmark. Raw measurements
are uploaded as Azure artifacts and are not committed to the repository. The
single runner is:

```sh
pnpm release:performance ./azure-performance.json ./artifacts/release-performance.json
```

The JSON config has `schemaVersion: 1`, `parallel: 4`,
`expectedCaptures: 452`, the served `storybookUrl`, `staticBuildDir`,
`repositoryDir`, one `chromiumPath`, Azure image identity, command timeout,
known invalid Preview PNG hashes, and `candidate`, `rc`, and `storycapture`
package specifications. The runner requires a clean repository, rebuilds and
packs the candidate directly from `repositoryDir` HEAD after a frozen pnpm
install, and rejects an external candidate archive or version. The recorded
scenario includes the SHA-256 of `pnpm-lock.yaml` and the pnpm and npm versions
that built the candidate. The active pnpm version must exactly match the root
`packageManager` declaration before the build starts. RC.2 and StoryCapture
9.0.0 remain explicit npm
tarballs, but their package names and SHA-512 integrity must match npm registry
metadata resolved from `https://registry.npmjs.org/` at the shared 24-hour
cutoff. It extracts every measured
package, verifies archived versions where specified, and creates each isolated
consumer's dependency lock using that cutoff. It then installs the exact lock
with scripts disabled and executes only the CLI declared by the package's `bin`
metadata. The cutoff, registry and measured integrity, lockfile hashes, copied
lockfiles, and package hashes are part of the artifact.
Every argument list explicitly uses `--parallel 4` and the `{storybookUrl}`,
`{chromiumPath}`, and `{outDir}` placeholders. Candidate and RC specifications
also carry full commit and tree SHAs; the candidate values must match the
repository HEAD, while the RC values are fixed to the tagged RC.2 source. Thus
the RC record cannot claim an unrelated commit for an otherwise valid registry
archive. An implementation with multiple bins selects one with `binName`. It may
also supply `captureTimePattern` with one numeric capture group when its CLI does
not emit StoryFreeze-compatible timing lines. A known invalid hash can be
generated with:

```sh
node scripts/release-performance.js --hash-png ./no-preview.png
```

A minimal config has this shape (paths and command arguments are specific to
the Azure job):

```json
{
  "schemaVersion": 1,
  "repositoryDir": "..",
  "parallel": 4,
  "expectedCaptures": 452,
  "azureImage": "ubuntu-24.04",
  "storybookUrl": "http://127.0.0.1:6006",
  "staticBuildDir": "../storybook-static",
  "chromiumPath": "../chromium/chrome",
  "commandTimeoutMs": 900000,
  "invalidPngHashes": ["<decoded No Preview visual hash>"],
  "starting": {
    "candidateRc": "candidate",
    "candidateStoryCapture": "storycapture"
  },
  "implementations": {
    "candidate": {
      "args": ["--parallel", "4", "--chromium-path", "{chromiumPath}", "--out-dir", "{outDir}", "{storybookUrl}"],
      "commit": "<40-character candidate commit>",
      "tree": "<40-character candidate tree>"
    },
    "rc": {
      "args": ["--parallel", "4", "--chromium-path", "{chromiumPath}", "--out-dir", "{outDir}", "{storybookUrl}"],
      "packagePath": "../storyfreeze-0.2.0-rc.2.tgz",
      "version": "0.2.0-rc.2",
      "commit": "63dbda81ee5bb8b4ea46a585b10c0a06fde19fff",
      "tree": "f615d6ce72b316ce23ed47c1c3c295777b3918be"
    },
    "storycapture": {
      "args": ["--parallel", "4", "--chromium-path", "{chromiumPath}", "--out-dir", "{outDir}", "{storybookUrl}"],
      "packagePath": "../storycapture.tgz",
      "version": "9.0.0"
    }
  }
}
```

The runner executes one warm-up per implementation and five measured pairs for
candidate versus `0.2.0-rc.2`, then candidate versus StoryCapture. Pair start
order alternates. It records raw wall and capture time, sampled process-tree CPU
and peak RSS, exit state, output paths/count/dimensions/decoded RGBA, and residual
processes. The RC.2 warm-up is the visual reference for the same static build.
The candidate version in the result is the version actually packed from HEAD;
the later Changesets release changes version metadata only. Each implementation
gets a self-contained directory under `.artifacts/dependencies` containing its
package manifest, lockfile, and measured tarball. The lock refers only to
`file:./measured-package.tgz`, so `npm ci` can replay the exact resolved graph
after the temporary measurement workspace has been removed.

The release gate requires:

- candidate / RC.2 wall p50 and p95 at most `1.05`
- candidate / StoryCapture wall p50 at most `0.90`
- candidate / StoryCapture wall p95 at most `1.00`
- zero failed or exhausted captures, timeouts, crashes, missing or duplicate
  PNGs, invalid Preview images, path/dimension/RGBA differences, and residual
  processes

CPU and RSS are recorded but are not hard gates for this cleanup.

## Latest measurements

The last public fixed-fixture measurement before this cleanup was PR #113 on
the existing 24-story workload with Node 22.18, Playwright Chromium 149, and
`parallel=4`. It recorded wall p50/p95 of 3,342/3,416 ms and capture p50/p95 of
199/739 ms. Relative to its fresh master baseline, wall p50 improved by 10.0%
and wall p95 by 8.5%. This small hosted-runner workload is directional evidence,
not the release gate.

The project owner's latest pre-cleanup Azure observation for the private
452-image workload was approximately 15% faster than StoryCapture. Its raw data
is not in the repository, so it is recorded only as context and cannot approve
the stable release.

The Phase 6M candidate measurement is pending. PR-632 remains Draft until the
Azure artifact contains five valid alternating pairs for both comparisons and
passes every gate above. The resulting exact p50/p95, CPU, and RSS values must be
added to this section before the PR becomes Ready.

## Consequences

The product has one runtime path and one release-performance path. Removed CLI
options fail immediately as unknown options, so operational mistakes are not
silently accepted. Pull requests become cheaper and less noisy while the
representative private workload remains the blocking performance and visual
parity evidence for release.

The cleanup deliberately gives up fresh-navigation and multi-topology
compatibility. If a future requirement needs either behavior, it must justify a
new public contract and representative measurements rather than reviving a
hidden mode.

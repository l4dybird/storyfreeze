# Browser performance records

Browser backend and isolation changes are measured with the existing React/Vite managed static fixture. The original Puppeteer process baseline remains as a historical pre-Playwright record.

The benchmark excludes dependency installation, package build, Storybook build, and the Vite preview server from the measured process tree. It measures the packed StoryFreeze CLI and all of its Chromium descendants with `parallel=4` after one warm-up run.

Each record contains three measured runs and reports:

- wall-clock time from CLI spawn to exit
- the simultaneous sum of `VmRSS` for the CLI and all descendants, sampled every 50 ms
- peak Chromium browser-root and total Chromium process counts
- discovered Chromium version, runner image, Node version, and fixture versions
- story and PNG counts

Summed RSS includes shared pages in more than one process and is not a PSS measurement. Comparisons must use the same workflow, runner image, Chromium executable, fixture, backend options, and parallelism. Before/after runs should be made close together because GitHub-hosted runner hardware can vary.

The differential benchmark installs the Chromium revision managed by `playwright-core` and passes that same executable path, launch arguments, fixture, static server, viewport data, and `parallel=4` to both backends. Each backend gets one warm-up and three measured runs. Runs alternate backend order to reduce ordering bias. The intentionally time-sensitive Retry story remains covered by the existing Storybook 10 E2E and is excluded from performance repetitions.

The schema 2 report records:

- capture success, retry, timeout, and browser crash rates
- exact PNG path and dimensions plus decoded RGBA pixel differences
- CLI wall time, capture-request p50/p95, sampled CPU time, summed peak RSS, and child/Chromium process counts
- one trace-control and one trace-enabled run per backend, restricted to one existing story, with trace overhead and per-file JSON/event/category validation
- Playwright-to-Puppeteer performance ratios, which are reported but are not CI thresholds while hosted-runner variance remains uncontrolled

The blocking differential gate requires the same observed Chromium executable, successful captures without retries/timeouts/crashes, zero PNG path/dimension/RGBA differences, and structurally valid Chromium traces. Existing Storybook 10 E2E continues to own filter, shard, retry, and full path/dimension coverage; the benchmark does not duplicate those cases or add a fixture.

The workflow runs the explicit-install differential when benchmark-related files change. A pinned official Playwright container comparison is available only through `workflow_dispatch` with `compare_container=true`. Its separate timing artifact uses GitHub job start/end timestamps so container initialization and image pull are included. Compare at least three dispatches and use medians on comparable runner hardware before changing the standard CI environment.

## Current browser differential

The [aggregated browser differential record](./browser-differential-record.json) uses three successful paired dispatches from commit `c7712ae`. All six environment jobs passed the executable, capture, PNG, and trace gates with Chromium 149.0.7827.55.

Across the nine explicit-install measured runs per backend:

| Metric                    |           Puppeteer |          Playwright | Playwright change |
| ------------------------- | ------------------: | ------------------: | ----------------: |
| wall p50                  |            8,339 ms |            8,839 ms |             +6.0% |
| wall p95                  |            8,438 ms |           14,485 ms |            +71.7% |
| capture-request p50       |            1,470 ms |            1,347 ms |             -8.4% |
| capture-request p95       |            3,795 ms |            4,420 ms |            +16.5% |
| peak process-tree RSS p50 | 4,955,402,240 bytes | 3,699,326,976 bytes |            -25.3% |
| sampled CPU time p50      |           11,480 ms |           10,670 ms |             -7.1% |
| max Chromium processes    |                  43 |                  32 |            -25.6% |

The p50 wall, memory, and CPU results are favorable enough to continue the Playwright evaluation, but the wall and capture-request tails do not yet support changing the default backend.

For the CI environment A/B, the explicit-install job median was 207 seconds and the pinned official-container job median was 205 seconds. The paired container/explicit ratio median was 1.020, container initialization took a median 27 seconds, and process-tree RSS was about 3–4% higher in the container runs. The difference is not a material improvement, so explicit installation remains the standard CI environment and the [official Playwright container](https://playwright.dev/docs/docker) remains a manual comparison only.

## Current baseline

The [Puppeteer process baseline](./puppeteer-process-baseline.json) was recorded on GitHub Actions with Node 22.18.0 and Google Chrome 150. Its three-run medians are 10,398 ms wall time and 4,282,707,968 bytes (3.99 GiB) summed peak RSS. The run observed four simultaneous browser roots, five browser launches in total (one enumeration process followed by four capture workers), and 38 simultaneous Chromium processes.

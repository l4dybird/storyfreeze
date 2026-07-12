# Browser performance records

Browser backend and isolation changes are measured with the existing React/Vite managed static fixture. The original Puppeteer process baseline remains as a historical pre-Playwright record.

The benchmark excludes dependency installation, package build, Storybook build, and the Vite preview server from the measured process tree. It measures the packed StoryFreeze CLI and all of its Chromium descendants. The blocking PR profile uses `parallel=4`, one warm-up pair, and three measured pairs. The manual record profile uses two warm-up pairs and ten measured pairs per dispatch.

Each dispatch record reports:

- wall-clock time from CLI spawn to exit
- the simultaneous sum of `VmRSS` for the CLI and all descendants, sampled every 50 ms
- peak Chromium browser-root and total Chromium process counts
- discovered Chromium version, runner image, Node version, and fixture versions
- story and PNG counts
- capture phase, idle/visual-commit, metrics, resource, output-path, and close diagnostics

Summed RSS includes shared pages in more than one process and is not a PSS measurement. Comparisons must use the same workflow, runner image, Chromium executable, fixture, backend options, and parallelism. Before/after runs should be made close together because GitHub-hosted runner hardware can vary.

The differential benchmark installs the Chromium revision managed by `playwright-core` and passes that same executable path, launch arguments, fixture, static server, viewport data, and parallelism to both backends. Warm-up and measured runs are paired, and backend order alternates inside a dispatch. Record dispatches also alternate which backend starts the first pair. The intentionally time-sensitive Retry story remains covered by the existing Storybook 10 E2E and is excluded from performance repetitions.

The schema 3 dispatch report records:

- capture success, retry, timeout, and browser crash rates
- exact PNG path and dimensions plus decoded RGBA pixel differences
- CLI wall time, capture-request p50/p95, sampled CPU time, summed peak RSS, and child/Chromium process counts
- when trace validation is enabled, one control and one trace run per backend, restricted to one existing story, with trace overhead and per-file JSON/event/category validation
- Playwright-to-Puppeteer performance ratios, which are reported but are not CI thresholds while hosted-runner variance remains uncontrolled

The tracked aggregate is generated from raw dispatch records. It verifies the source commit, browser, fixture, Node, runner image, options, parallelism, successful gates, and starting-order balance before recomputing percentiles. Dispatch medians are not pooled.

The blocking differential gate requires the same observed Chromium executable, successful captures without retries/timeouts/crashes, zero PNG path/dimension/RGBA differences, and structurally valid Chromium traces. Existing Storybook 10 E2E continues to own filter, shard, retry, and full path/dimension coverage; the benchmark does not duplicate those cases or add a fixture.

The workflow runs the PR profile with explicit browser installation when benchmark-related files change. Manual dispatch selects the `pr` or `record` profile, parallelism, first backend, and whether to run the independent trace control. A pinned official Playwright container comparison remains available only through `workflow_dispatch` with `compare_container=true`.

## Current browser differential

The [aggregated browser differential record](./browser-differential-record.json) compares the instrumented idle-wait baseline `2b64434` with visual-commit candidate `ca470b7`. Each snapshot contains four successful explicit-install dispatches, two per starting backend, for 40 measured runs per backend. All capture, retry, timeout, crash, PNG, and trace gates passed with Chromium 149.0.7827.55.

The raw 40-run summaries are:

| Metric                    |  Baseline Puppeteer | Baseline Playwright | Candidate Puppeteer | Candidate Playwright | Candidate PW/P ratio |
| ------------------------- | ------------------: | ------------------: | ------------------: | -------------------: | -------------------: |
| wall p50                  |            8,355 ms |            8,868 ms |            5,755 ms |             5,821 ms |                1.011 |
| wall p95                  |            8,754 ms |           17,351 ms |            6,089 ms |             6,031 ms |                0.990 |
| capture-request p50       |            1,410 ms |            1,313 ms |            1,070 ms |             1,311 ms |                    — |
| capture-request p95       |            3,783 ms |            4,437 ms |            1,988 ms |             1,734 ms |                    — |
| peak process-tree RSS p50 | 4,950,519,808 bytes | 3,697,979,392 bytes | 4,644,823,040 bytes |  3,704,963,072 bytes |                0.798 |
| sampled CPU time p50      |           10,340 ms |            9,580 ms |           10,710 ms |             9,240 ms |                0.863 |
| max Chromium processes    |                  45 |                  32 |                  41 |                   32 |                    — |

Playwright idle timeout events fell from 77 to 0, and its capture requests taking at least three seconds fell from 51 to 0. Candidate visual-commit timeout and animation-frame fallback counts were both 0. Playwright wall p50 improved by 34.4%, wall p95 by 65.2%, and capture-request p95 by 60.9% relative to the instrumented baseline.

The candidate met the recorded default-readiness targets: wall p50 ratio at most 1.05, wall p95 ratio at most 1.10, RSS ratio at most 0.80, CPU ratio at most 1.00, and zero correctness failures. This PR does not change the default backend; reset, watcher, and recovery hardening remain separate work.

The container comparison was not rerun for the wait change. The historical PR #33 result used three dispatches: explicit-install job median 207 seconds, pinned-container median 205 seconds, 27-second median container initialization, and roughly 3–4% higher process-tree RSS in the container. Explicit installation therefore remains standard CI, while the [official Playwright container](https://playwright.dev/docs/docker) remains a manual comparison only.

## Current baseline

The [Puppeteer process baseline](./puppeteer-process-baseline.json) was recorded on GitHub Actions with Node 22.18.0 and Google Chrome 150. Its three-run medians are 10,398 ms wall time and 4,282,707,968 bytes (3.99 GiB) summed peak RSS. The run observed four simultaneous browser roots, five browser launches in total (one enumeration process followed by four capture workers), and 38 simultaneous Chromium processes.

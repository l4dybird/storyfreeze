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

## Browser isolation differential

The isolation differential is independent of the schema 3 browser backend comparison above. It compares Playwright `process` and `context` isolation with the same packed React/Vite managed static fixture, explicit `playwright-core` Chromium executable, launch options, viewport data, and story selection. It does not add a fixture, smoke job, or pixel suite; the existing Storybook 10 E2E remains responsible for broad path, filter, shard, retry, and lifecycle coverage.

The pull-request profile is the blocking correctness check. It runs at `parallel=4` with one warm-up pair and three measured pairs, beginning with `process` in the first pair and alternating pair order. Manual dispatches select the `pr` or `record` profile, `parallel=1|2|4`, and the isolation mode that begins the first pair. The record profile uses two warm-up pairs and ten measured pairs. A default-readiness record comprises four successful `parallel=4` record dispatches, two per starting isolation, for 40 measured runs per isolation. Dispatch medians are not pooled; the aggregate recomputes percentiles from the raw runs after verifying balanced order and matching source tree, workflow, Chromium, fixture, runner, Node, options, and successful correctness gates.

Isolation dispatches use their own schema 1 with `kind: "browser-isolation-differential"`. The record identifies the source commit and tree, environment, provisioning, scenario and execution order; stores raw runs and summaries under `isolations.process` and `isolations.context`; stores pixel comparisons and context-to-process ratios under `isolationDifferential`; and records gate evidence separately. The independent tracked aggregate also uses schema 1 with `kind: "browser-isolation-aggregate"`; it records its source commit and tree, workflow runs and conditions, raw isolation summaries, context-to-process ratios, pixel comparisons, optional `parallel=1`/`parallel=2` diagnostics, and default acceptance result. It does not modify or replace the tracked backend differential record.

One optional `parallel=1` PR-profile dispatch and one optional `parallel=2` PR-profile dispatch, each with three measured pairs, diagnose scaling and fixed browser overhead. They remain separate from the 40-run `parallel=4` population, headline ratios, and default acceptance gate. Dependency installation, package build, Storybook static build, and the Vite preview server remain outside the sampled CLI/Chromium process tree for every profile.

Trace is always disabled for the isolation comparison. `--trace` forces context isolation back to process isolation, so including it would not measure the intended topology. Trace correctness and overhead remain covered by the independent backend differential workflow.

The pull-request gate requires successful paired captures without retries, timeouts, or crashes, matching story and PNG counts, stable PNG paths/dimensions/pixels, and the expected browser topology. Hosted-runner performance ratios are recorded but do not block a single PR dispatch. Changing the default to `context` requires the balanced 40-run aggregate to meet every acceptance threshold:

- context/process median peak-RSS ratio at most `0.80`
- context/process wall-time p50 and p95 ratios both at most `1.00`
- context/process capture-request p95 ratio at most `1.05`
- zero capture failures, retries, timeouts, crashes, or pixel mismatches
- zero capture requests taking at least three seconds
- lower browser-root and total Chromium process peaks, with one browser root in every context run

PR-531 only adds this evidence pipeline: `process` remains the default regardless of the result.

## Current browser isolation differential

The [aggregated browser isolation record](./browser-isolation-record.json) contains four successful `parallel=4` record dispatches from `d8ebef4`, two per starting isolation, for 40 measured runs and 360 capture-request samples per isolation. All four dispatches used Node.js 22.18.0, Storybook 10.5.0, Playwright 1.61.1, and Chromium 149.0.7827.55 on the same runner image and source tree. The optional `parallel=1` and `parallel=2` diagnostics were not repeated because they do not contribute to the default gate.

The raw `parallel=4` result is:

| Metric                    |             Process |             Context | Context/process | Gate |
| ------------------------- | ------------------: | ------------------: | --------------: | :--- |
| wall p50                  |            4,656 ms |            4,288 ms |           0.921 | pass |
| wall p95                  |            4,848 ms |            4,450 ms |           0.918 | pass |
| capture-request p50       |              792 ms |              876 ms |           1.106 | info |
| capture-request p95       |            1,243 ms |            1,334 ms |           1.073 | fail |
| peak process-tree RSS p50 | 3,652,808,704 bytes | 1,680,891,904 bytes |           0.460 | pass |
| sampled CPU time p50      |            9,060 ms |            7,840 ms |           0.865 | info |
| max Chromium processes    |                  32 |                  14 |           0.438 | pass |
| max browser roots         |                   4 |                   1 |           0.250 | pass |

Both modes completed with zero capture failures, retries, timeouts, browser crashes, PNG differences, and three-second capture tails. Every context warm-up and measured run used exactly one browser root. Context mode reduced wall p50 by 7.9%, wall p95 by 8.2%, median peak RSS by 54.0%, and sampled CPU time by 13.5%. Its capture-request p95 remained 7.3% slower, exceeding the 1.05 threshold by 2.3 percentage points. The aggregate acceptance result is therefore false, so `process` remains the default and `context` remains explicit opt-in.

## Current browser differential

The [aggregated browser differential record](./browser-differential-record.json) compares the visual-commit baseline `ca470b7` with `master` after reset, watcher, and Playwright recovery hardening (`804aae4`). Each snapshot contains four successful explicit-install dispatches, two per starting backend, for 40 measured runs per backend. All record gates passed, and the separate candidate trace gate passed, with Chromium 149.0.7827.55.

The raw 40-run summaries are:

| Metric                    |  Baseline Puppeteer | Baseline Playwright | Candidate Puppeteer | Candidate Playwright | Candidate PW/P ratio |
| ------------------------- | ------------------: | ------------------: | ------------------: | -------------------: | -------------------: |
| wall p50                  |            5,755 ms |            5,821 ms |            5,445 ms |             5,222 ms |                0.959 |
| wall p95                  |            6,089 ms |            6,031 ms |            5,736 ms |             5,813 ms |                1.013 |
| capture-request p50       |            1,070 ms |            1,311 ms |            1,101 ms |             1,083 ms |                    — |
| capture-request p95       |            1,988 ms |            1,734 ms |            1,770 ms |             1,540 ms |                    — |
| peak process-tree RSS p50 | 4,644,823,040 bytes | 3,704,963,072 bytes | 4,585,390,080 bytes |  3,653,197,824 bytes |                0.797 |
| sampled CPU time p50      |           10,710 ms |            9,240 ms |           10,710 ms |             9,380 ms |                0.876 |
| max Chromium processes    |                  41 |                  32 |                  39 |                   32 |                    — |

Comparing the candidate backends directly (negative means Playwright used less time or resources):

| Metric                    | Puppeteer candidate | Playwright candidate | Playwright vs Puppeteer |
| ------------------------- | ------------------: | -------------------: | ----------------------: |
| wall p50                  |            5,445 ms |             5,222 ms |                   -4.1% |
| wall p95                  |            5,736 ms |             5,813 ms |                   +1.3% |
| capture-request p50       |            1,101 ms |             1,083 ms |                   -1.6% |
| capture-request p95       |            1,770 ms |             1,540 ms |                  -13.0% |
| peak process-tree RSS p50 | 4,585,390,080 bytes |  3,653,197,824 bytes |                  -20.3% |
| sampled CPU time p50      |           10,710 ms |             9,380 ms |                  -12.4% |
| max Chromium processes    |                  39 |                   32 |                  -17.9% |

Playwright was 4.1% faster at wall p50 and 13.0% faster at capture-request p95 while using 20.3% less peak RSS and 12.4% less sampled CPU time. Its wall p95 was 77 ms (1.3%) slower than Puppeteer, which remains within the recorded 10% readiness allowance. Correctness and timeout results were identical: both backends completed without failures, retries, timeouts, crashes, PNG differences, or three-second capture tails.

Relative to the visual-commit baseline, Puppeteer wall p50/p95 improved by 5.4%/5.8% and capture-request p95 improved by 11.0%. Playwright wall p50/p95 improved by 10.3%/3.6%, capture-request p50/p95 improved by 17.4%/11.2%, and peak RSS improved by 1.4%. The candidate recorded no three-second capture tails, idle or visual-commit timeouts, or animation-frame fallbacks for either backend.

The candidate met the recorded default-readiness targets: wall p50 ratio at most 1.05, wall p95 ratio at most 1.10, RSS ratio at most 0.80, CPU ratio at most 1.00, and zero correctness failures. This record does not change the default backend; it captures the cumulative result after the separately merged reset, watcher, and recovery hardening.

The container comparison was not rerun for the wait change. The historical PR #33 result used three dispatches: explicit-install job median 207 seconds, pinned-container median 205 seconds, 27-second median container initialization, and roughly 3–4% higher process-tree RSS in the container. Explicit installation therefore remains standard CI, while the [official Playwright container](https://playwright.dev/docs/docker) remains a manual comparison only.

## Current baseline

The [Puppeteer process baseline](./puppeteer-process-baseline.json) was recorded on GitHub Actions with Node 22.18.0 and Google Chrome 150. Its three-run medians are 10,398 ms wall time and 4,282,707,968 bytes (3.99 GiB) summed peak RSS. The run observed four simultaneous browser roots, five browser launches in total (one enumeration process followed by four capture workers), and 38 simultaneous Chromium processes.

# ADR-013: Phase 5G throughput tuning

- Status: Accepted
- Date: 2026-07-16
- Decision owners: StoryFreeze maintainers
- Applies to: Phase 5G and later

## Context

The Playwright migration left two distinct performance questions. StoryFreeze needed lower cold-run latency without weakening its fresh-document capture contract, and CI needed to stop repeating package compilation and independent E2E captures. A tenfold improvement was used as an investigation target, not as permission to combine incompatible workloads or relax correctness.

The benchmark now separates startup, capture, queue, browser topology, CPU, and RSS. It compares process and context isolation with the existing two-story, nine-PNG Storybook 10 static fixture. It does not add a fixture or smoke suite. Correctness gates require zero capture failures, retries, timeouts, browser crashes, PNG mismatches, and three-second tails.

An early record exposed that Chromium can briefly present additional root PIDs during startup. `/proc` remains the source for sampled topology, CPU, and RSS, but backend launch diagnostics are the source for logical browser launch counts. This preserves detection of real browser replacement while avoiding transient-PID false positives.

## Decision

StoryFreeze keeps `--parallel 4`, process isolation, and fresh navigation as defaults.

The accepted runtime changes are:

- retain the isolated story-index Chromium process and open a fresh worker-0 context from it
- create sessions with the CLI base viewport already applied
- count the resource quiet window from the last observed request activity
- keep every capture worker on an independent process and context in process mode

The accepted CI changes are:

- dependency installation and package packing do not compile StoryFreeze
- explicit `pnpm build` performs a clean build before package consumption
- the existing filter, shard, and retry E2E captures run concurrently after the managed capture
- superseded pull-request workflow runs are cancelled

Story affinity is not adopted because it serializes variant-heavy stories onto one worker. Same-document variant batching is not adopted because it cannot restore window and module globals, timers, listeners, Storybook lifecycle state, and arbitrary `waitFor` behavior to the current fresh-document contract. Parallel 8 and 16 are not adopted because the measured fixture is already saturated and the extra browser startup creates contention.

Large suites should use the existing shard contract to distribute an immutable Storybook static build and tested StoryFreeze tarball across runners. Horizontal scaling is the credible path to order-of-magnitude full-suite improvement, but Phase 5G does not claim an unmeasured tenfold result for a 452-story consumer repository.

## Evidence

The final aggregate uses four successful record dispatches from `86ae115`, two starting with each isolation, on one source tree and runner image:

- [record 1](https://github.com/l4dybird/storyfreeze/actions/runs/29512942267)
- [record 2](https://github.com/l4dybird/storyfreeze/actions/runs/29513104185)
- [record 3](https://github.com/l4dybird/storyfreeze/actions/runs/29513331638)
- [record 4](https://github.com/l4dybird/storyfreeze/actions/runs/29513627165)

The hosted-runner hardware was not identical: records 1, 3, and 4 used an AMD EPYC 9V74 host, while record 2 used an AMD EPYC 7763 host. Every dispatch exposed four logical CPUs and about 16.77 GB of memory. The tracked aggregate preserves the per-dispatch hardware evidence and marks the CPU model mismatch. Process and context were paired on the same host within every dispatch and their starting order was balanced, so the isolation ratios remain useful; pooled absolute percentiles still contain hosted-runner variance.

The raw 40-run aggregate is:

| Metric                    |             Process |             Context | Context/process |
| ------------------------- | ------------------: | ------------------: | --------------: |
| wall p50                  |            4,352 ms |            4,013 ms |           0.922 |
| wall p95                  |            4,475 ms |            4,196 ms |           0.938 |
| capture-request p50       |              716 ms |              771 ms |           1.077 |
| capture-request p95       |            1,172 ms |            1,252 ms |           1.068 |
| peak process-tree RSS p50 | 3,654,516,736 bytes | 1,677,615,104 bytes |           0.459 |
| sampled CPU time p50      |            9,020 ms |            7,820 ms |           0.867 |
| max Chromium processes    |                  32 |                  14 |           0.438 |
| runtime browser launches  |                   4 |                   1 |           0.250 |

Context mode saves 54.1% peak RSS and 7.8% wall p50, but its capture-request p95 is 6.8% slower than process mode. It misses the 1.05 default gate by 1.8 percentage points, so the aggregate acceptance result is false and context remains explicit opt-in.

Relative to the previous balanced process record at `d8ebef4`, the Phase 5G record observed wall p50 6.5% lower, wall p95 7.7% lower, capture-request p50 9.6% lower, and capture-request p95 5.7% lower. Peak RSS was effectively unchanged and sampled CPU was 0.4% lower. The earlier record used runner image `20260705.232.1`, kernel `6.17.0-1018-azure`, and StoryFreeze `0.1.0`; the Phase 5G record used image `20260714.240.1`, kernel `6.17.0-1020-azure`, and StoryFreeze `0.2.0-alpha.1`. This is directional cross-image evidence, not a controlled attribution of the difference to code alone.

The scaling diagnostics were [p1](https://github.com/l4dybird/storyfreeze/actions/runs/29512334371), [p2](https://github.com/l4dybird/storyfreeze/actions/runs/29512379697), [p8](https://github.com/l4dybird/storyfreeze/actions/runs/29512607971), and [p16](https://github.com/l4dybird/storyfreeze/actions/runs/29512790143). Process-mode wall p50 was 7,606 / 4,652 / 4,352 / 5,531 / 7,483 ms for parallel 1 / 2 / 4 / 8 / 16. Parallel 8 raised median RSS to 6.96 GB; parallel 16 raised it to 13.17 GB and worker utilization fell to about 31%.

In the first GitHub Actions samples after the CI change, the Node 22 build job fell from 72 to 62 seconds, package smoke from 21 to 13 seconds, and the integrated E2E capture step from 77 to 57 seconds. These single hosted-runner samples document direction, not a stable performance guarantee.

## Consequences

The default remains the fastest configuration that preserves current isolation and passes the capture-tail gate. Context isolation remains useful when memory is more important than per-capture p95. More same-runner workers are not a general speed control; queue depth, fixture shape, and memory must be considered.

Future tenfold claims require a representative large-suite record with immutable artifacts and balanced shard assignment. A weaker navigation-isolation mode, if ever proposed, must be explicit opt-in and documented as a different correctness contract.

## References

- [ADR-012: Browser process and context isolation](012-browser-isolation.md)
- [Browser isolation aggregate](../../benchmarks/browser-isolation-record.json)
- [Browser performance record documentation](../../benchmarks/README.md)

# ADR-012: Browser process and context isolation

- Status: Accepted
- Date: 2026-07-13
- Decision owners: StoryFreeze maintainers
- Applies to: Phase 5E and later

## Context

StoryFreeze historically gives every capture worker its own Chromium process. This provides strong failure and state isolation, but parallel runs duplicate browser-process memory. Playwright BrowserContexts can isolate cookies, storage, cache, service workers, pages, and emulation state while allowing workers to share one Chromium process.

Context sharing changes resource usage and the failure boundary. A shared browser crash can affect several workers, and Chromium CPU tracing is browser-process scoped. Puppeteer's temporary compatibility backend does not implement the new context lifecycle.

## Decision

StoryFreeze exposes `--browser-isolation process|context`. The default is `process`.

Process mode retains one browser process per capture worker. Context mode is available only with the Playwright backend and uses an independently created BrowserContext for each worker lease. Context state is never shared between workers. A worker retains its current context only while the complete emulation profile remains compatible; profile changes and retries replace it with a clean context.

Selecting context isolation with the Puppeteer backend is an error. Selecting `--trace` with context isolation emits a warning and changes the effective isolation mode to process. This fallback does not change `--parallel`; a run configured with four workers continues to use four workers. Verbose output logs the effective isolation mode.

Process mode remains the default until repeatable process-parity benchmarks show all of the following:

- at least 20% lower peak memory
- no wall-time regression
- no greater than 5% regression in p95 capture-request time
- no regression in failure or retry rates
- fewer browser processes

PR-530 adds the opt-in mode without a migration guide because existing commands retain their process-isolated behavior.

## Recorded default decision

The balanced [browser isolation aggregate](../../benchmarks/browser-isolation-record.json) recorded four `parallel=4` dispatches at `360108e`, two per starting isolation, with 40 measured runs per mode. Every correctness gate passed: there were no capture failures, retries, timeouts, crashes, PNG differences, or three-second capture tails, and every context run used one browser root.

Context isolation reduced median peak process-tree RSS from 3,655,761,920 to 1,607,536,640 bytes (ratio 0.440) and the Chromium process peak from 32 to 14. It did not meet process parity: wall p50 was 5,232 versus 5,223 ms (ratio 1.002), wall p95 was 5,402 versus 5,351 ms (ratio 1.010), and capture-request p95 was 1,966 versus 1,503 ms (ratio 1.308).

The aggregate acceptance result is therefore false. `process` remains the default, `context` remains an explicit Playwright-only optimization, and no migration step is required. A future default proposal must produce a new balanced record that meets every existing threshold; the memory saving alone is insufficient to reverse this decision.

## Consequences

Users can evaluate context sharing explicitly without changing existing capture behavior. Puppeteer remains a process-only fallback. Trace output keeps its established Chromium CPU trace JSON format and parallelism, at the cost of forfeiting context-mode process consolidation for trace-enabled runs.

The existing managed Storybook E2E case exercises Playwright context isolation with four workers. Default Playwright process isolation and explicit Puppeteer process isolation remain covered without increasing the number of E2E cases.

## References

- [ADR-011: Chromium CPU trace and parallelism](011-cpu-trace-parallelism.md)
- [Browser isolation aggregate](../../benchmarks/browser-isolation-record.json)
- [Playwright BrowserContext documentation](https://playwright.dev/docs/api/class-browsercontext)

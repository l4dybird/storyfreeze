# ADR-011: Chromium CPU trace and parallelism

- Status: Accepted
- Date: 2026-07-12
- Decision owners: StoryFreeze maintainers
- Applies to: Phase 5B and later

## Context

StoryFreeze's `--trace` option writes a Chromium tracing JSON file for each capture. Chromium tracing is scoped to a browser process. Process isolation launches one browser process for each capture worker, while the optional context isolation mode introduced by PR-530 shares a browser process between workers.

Replacing the existing trace with Playwright's context trace ZIP would change the output format and recorded events. Reducing `--parallel` to one would also change established CLI behavior even though the current worker processes do not share a tracing session.

## Decision

StoryFreeze will preserve the existing Chromium CPU trace JSON format and trace categories for both backends. It will not substitute Playwright trace ZIP output.

Each `CapturePage` permits at most one active trace. Under process isolation, each `BrowserInstance` creates exactly one session and one page, so the page-local guard also prevents overlapping traces within a browser process:

- starting a second trace fails immediately
- stopping before a trace starts fails immediately
- a failed start releases the page-local guard
- a failed stop fails the capture run and requires disposal of that browser instance; reusing the same process is not supported because the underlying Chromium trace state may be unknown
- a started trace is stopped during capture cleanup, including retry, skip, and capture-error paths
- stream handles are closed when reading a Playwright CDP trace fails

Trace-enabled runs always use process isolation. If a user combines `--trace` with `--browser-isolation context`, StoryFreeze warns and changes the effective isolation mode to `process`. It preserves the configured parallelism, including the default of four, because traces in different workers then belong to different Chromium processes.

## Consequences

StoryFreeze does not add a global trace mutex, force `parallel=1`, or introduce a trace-specific fixture or smoke suite. The effective browser isolation mode is logged in verbose output so the automatic fallback is observable.

Context sharing therefore cannot combine concurrent Chromium CPU traces in one browser process. A future implementation may reconsider this only if it adds a browser-instance-wide trace guard and serialization without changing the trace output contract. The process/context default decision is recorded in ADR-012.

## References

- [Chrome DevTools Protocol: Tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/)
- [ADR-012: Browser process and context isolation](012-browser-isolation.md)

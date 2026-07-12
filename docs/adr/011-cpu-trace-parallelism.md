# ADR-011: Chromium CPU trace and parallelism

- Status: Accepted
- Date: 2026-07-12
- Decision owners: StoryFreeze maintainers
- Applies to: Phase 5B and later

## Context

StoryFreeze's `--trace` option writes a Chromium tracing JSON file for each capture. Chromium tracing is scoped to a browser process, while the Phase 5B execution model launches one browser process for enumeration and one browser process for each capture worker.

Replacing the existing trace with Playwright's context trace ZIP would change the output format and recorded events. Reducing `--parallel` to one would also change established CLI behavior even though the current worker processes do not share a tracing session.

## Decision

StoryFreeze will preserve the existing Chromium CPU trace JSON format and trace categories for both backends. It will not substitute Playwright trace ZIP output.

Each `CapturePage` permits at most one active trace. In the current topology, each `BrowserInstance` creates exactly one session and one page, so the page-local guard also prevents overlapping traces within a browser process:

- starting a second trace fails immediately
- stopping before a trace starts fails immediately
- a failed start releases the page-local guard
- a failed stop fails the capture run and requires disposal of that browser instance; reusing the same process is not supported because the underlying Chromium trace state may be unknown
- a started trace is stopped during capture cleanup, including retry, skip, and capture-error paths
- stream handles are closed when reading a Playwright CDP trace fails

The current `1 worker = 1 browser process` topology keeps the configured parallelism, including the default of four, because traces in different workers belong to different Chromium processes.

## Consequences

PR-511 does not add a global trace mutex, force `parallel=1`, or introduce a trace-specific fixture or smoke suite.

Before Phase 6 creates multiple sessions or contexts in one browser process, trace-enabled runs must either retain process isolation or introduce a browser-instance-wide trace guard and serialization. PR-520 will measure trace overhead and validate trace contents under fixed browser conditions; the context-sharing decision remains ADR-012.

## References

- [Chrome DevTools Protocol: Tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/)

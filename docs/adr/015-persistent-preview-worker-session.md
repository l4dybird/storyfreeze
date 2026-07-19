# ADR-015: Persistent Preview worker sessions

- Status: Accepted for RC; stable release gated on representative evidence
- Date: 2026-07-20
- Decision owners: StoryFreeze maintainers
- Applies to: Phase 6P

## Context

StoryFreeze's process-isolated workers previously navigated to `iframe.html` for every capture. That boundary is conservative, but it repeatedly boots the Storybook Preview runtime, reloads modules and assets, reconnects the addon channel, and waits for the same document-level readiness. A representative 452-capture Azure workload remained materially slower than StoryCapture even after queue, viewport, watcher, and screenshot-buffer tuning.

The public CLI, API, output paths, PNG semantics, four-process parallel model, and Storybook render/play behavior must remain stable. Internal state isolation is allowed to change before the stable release, but a performance win cannot replace correctness: missing or duplicate PNGs, invalid Preview pages, unapproved decoded-RGBA differences, retries, timeouts, crashes, or residual browser processes are release failures.

## Decision

Managed capture workers open one Storybook Preview document per session generation. After the first validated `iframe.html` navigation, Node sends a correlated request and Story ID through an internal worker-session protocol. The Preview uses Storybook core events to render or remount the requested Story, associates ready/play/error state with that request, and rejects stale, duplicate, mismatched, or aborted work.

The default capture protocol becomes `auto`. It uses the persistent protocol in managed mode and falls back to fresh navigation when the addon protocol is unavailable. `strict` remains an explicit fresh-navigation diagnostic mode. `story-session` requires the managed protocol and fails rather than falling back. Browser isolation remains `process`, with at most four workers by default and no automatic worker-count growth.

Page-scoped request, console, resource, and metrics observers are installed once and reset for each capture. Width and height changes resize the live page. Supported mobile, touch, orientation, and DPR emulation updates invalidate the Preview document before it can be reused. Same-story variants retain the existing apply/reset verification. A session fault closes the broken session before the current capture uses the existing retry budget; a terminal failure stops new queue assignments and drains in-flight work.

The default session lifetime is 128 captures. Recycling occurs only at a safe capture boundary. An unlimited lifetime is adopted only if an independent paired experiment is at least 5% faster, remains within `1.10` of RC.0 peak RSS, and has no visual, lifecycle, or capture failures.

## Evidence and release gate

Pull-request CI reuses the packed StoryFreeze package and existing Storybook 10 managed static build. It compares `process + strict` and `process + auto` after one warm-up with three alternating measured pairs at `parallel=4`. The artifact records commit/tree and installed-package hashes, Chromium and runner metadata, wall/capture/CPU/peak RSS, navigation and story-switch counts, browser generations, cleanup, and exact decoded-RGBA comparisons. Hosted-runner ratios are diagnostic; correctness is blocking.

Stable release additionally requires five alternating pairs on the same Azure 452-capture workload and static build for StoryCapture and packed StoryFreeze. The raw-record gate requires:

- StoryFreeze/StoryCapture wall p50 at most `0.90`
- StoryFreeze/StoryCapture wall p95 at most `1.00`
- StoryFreeze/RC.0 CPU p50 at most `0.90`
- StoryFreeze/RC.0 peak-RSS p50 at most `1.05`
- exactly 452 valid outputs and zero failure, retry, timeout, crash, missing, duplicate, invalid-Preview, pixel-mismatch, or residual-process events

A wall p50 ratio at most `0.50` is recorded as the stretch goal. Until the representative record passes, the performance PR remains Draft and stable publishing remains blocked.

## Consequences

Repeated Storybook document startup is removed from the common managed path while process isolation and output behavior remain unchanged. Long suites should perform roughly one initial navigation per worker generation rather than one per capture.

Cross-story reuse makes Storybook's teardown/render boundary part of the isolation contract. The correlated protocol, hard failure checks, bounded lifetime, recovery, and decoded-RGBA gate reduce that risk, but cannot prove the absence of arbitrary application-global side effects. Projects that require a fresh JavaScript realm for every capture can continue to select `strict`.

## References

- [ADR-014: Manifest scheduling, adaptive topology, and story sessions](014-performance-roadmap-phase-1-3.md)
- [Browser performance records](../../benchmarks/README.md)

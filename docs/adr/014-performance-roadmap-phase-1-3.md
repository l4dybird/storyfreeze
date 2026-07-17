# ADR-014: Manifest scheduling, adaptive topology, and story sessions

- Status: Accepted as opt-in
- Date: 2026-07-17
- Decision owners: StoryFreeze maintainers
- Applies to: Performance roadmap Phase 1-3

## Context

The Phase 5G record showed that navigation and Storybook readiness dominate PNG encoding. It also showed that one-process context isolation reduces wall time and memory but can worsen capture p95. The existing two-story, nine-PNG fixture cannot answer load-balancing, large-suite, high-DPR, full-page, network, or interaction questions.

StoryFreeze must keep Storybook render, decorators, loaders, and play behavior; stable captures must retain fresh navigation; and optimized output must preserve paths, dimensions, and decoded RGBA. Missing or duplicate captures, retry growth, and unsafe same-document state are correctness failures.

## Decision

StoryFreeze adopts three cumulative, separately diagnosable layers:

1. A schema-versioned manifest classifies captures as static, runtime-validation, or runtime-discovery. A deterministic planner applies profile-aware cost balancing, pre-navigation emulation, capture leases, affinity, and work stealing. Runtime disagreement follows the existing viewport/navigation path.
1. Browser process, context, and worker counts are independent. `process` and `context` remain compatibility presets; `hybrid` and `auto` are opt-in. Runtime-discovery plans reserve dormant capacity, but workers and their process generations boot only when queue depth requires them. Context recycling uses deterministic count or age limits, with an active same-document session deferring a reached limit to its closing boundary, and generation-based recovery requeues affected work.
1. `strict` remains the default capture protocol. `auto` batches only reset-safe variants from one Storybook story and emulation class. The preview and Node protocol validate session and variant generations. Reset covers pointer state, the exact post-render/play active-element baseline, custom state, deeply cloned supported args/globals, scroll positions, paint-triggered requests, response-driven visual commit, and a post-settle full-document fingerprint that includes portals, live form state, and open shadow roots. Class or host objects whose internal state cannot be cloned fail closed. Any open, apply, capture, reset, deadline, or health failure recreates the worker and requeues unfinished work through strict capture. Forced `story-session` mode reports missing prerequisites, unsafe variants, and reset failures as errors.

Story boundaries remain fresh-navigation boundaries in every mode. Mobile, touch, DPR, and orientation changes form separate sessions; width/height-only changes may share a session after validation. Runtime functions and click mutations without a custom reset remain strict.

## Defaults

`--browser-isolation process` and `--capture-protocol strict` remain defaults. The historical isolation record therefore remains applicable to default behavior. `hybrid`, topology `auto`, and story-session `auto` need representative matrix records before any default change.

## Evidence and acceptance

The benchmark suite now contains independent scenarios for one story/one PNG, many stories, variant-heavy stories, multiple viewports, mixed mobile/desktop, large full-page output, high DPR, network-heavy stories, and interaction-heavy stories. It rotates `process + strict`, `auto + strict`, and `auto + auto` execution order, records p50/p95 phases and topology diagnostics, and gates paths, dimensions, decoded RGBA, missing/duplicate outputs, retries, timeouts, and crashes. The middle lane is the direct Phase 2 baseline for Phase 3. The existing process/context differential can additionally run process/hybrid/context topology comparisons.

The final local Windows PR-profile record used the packaged build, Playwright 1.61.1, `parallel=4`, one warm-up, and three measured runs per lane across all nine scenarios. Geometric-mean wall p50 improved 2.7% from stable to Phase 2 and another 4.7% from Phase 2 to Phase 3, for a cumulative 7.3% improvement. Cumulative wall p95 improved 4.4%, capture-request p50 improved 38.8%, and capture-request p95 improved 9.3%. Navigation fell from 62 to 40 per complete matrix run. All expected paths, byte lengths, dimensions, and decoded RGBA values matched, with no missing or duplicate outputs, retries, timeouts, crashes, or pixel mismatches.

The record is representative local evidence, not a cross-runner acceptance population. Changing defaults still requires balanced records from the same build, browser, runner class, options, and workload to pass the correctness gates.

## Consequences

Static and partially static suites can avoid viewport-triggered re-navigation and receive balanced profile-aware queues. Small suites do not boot unused workers. Large queues can grow to configured parallelism without losing capture ownership. Variant-heavy opt-in suites can remove repeated Storybook navigation while retaining strict fallback.

The preview protocol and reset contract add implementation complexity. Arbitrary module/window globals, timers, listeners, closed shadow roots, and side effects that occur only after verification cannot be proven reset-safe. A custom reset must restore or cancel that state and settle within the capture timeout; stories that cannot meet that contract must use `strict`. `auto` falls back on observable mismatches but cannot guarantee detection of invisible or arbitrarily late effects. The manifest remains conservative when screenshot options are not known before runtime.

## References

- [ADR-012: Browser process and context isolation](012-browser-isolation.md)
- [ADR-013: Phase 5G throughput tuning](013-phase-5g-throughput.md)
- [Browser performance records and roadmap matrix](../../benchmarks/README.md)

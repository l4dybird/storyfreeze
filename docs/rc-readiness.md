# RC readiness record

- Record date: 2026-07-19
- Release line: `0.2.0`
- Current prerelease: `0.2.0-alpha.9`
- Intended next channel: `0.2.0-rc.0` on npm `next`

## Decision

The cleanup stack is ready to transition from alpha to RC after its pull requests are merged. No unresolved source, package, Storybook 10 compatibility, correctness, security, or performance blocker remains. The RC transition itself stays in a separate pull request created from the latest merged `master`.

This record does not change the compatibility defaults: browser isolation remains `process`, the capture protocol remains `strict`, Chromium remains sandboxed by default, and browser installation remains explicit.

## Release gate

| Area               | Evidence                                                                                                    | Result |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------ |
| Public package     | exact 215-file allow-list, ESM exports, TypeScript consumer, CLI and preset import                          | pass   |
| Node/OS            | Node 22.18 and 24.11 on Linux; Node 22.18 build/test/package smoke on Windows                               | pass   |
| Storybook E2E      | existing React/Vite static simple and managed protocol suite                                                | pass   |
| Storybook range    | packed preset load on 10.0.0 and 10.4.0; full current fixture on 10.5.2                                     | pass   |
| Browser lifecycle  | no retry, timeout, crash, close error, or residual Chromium process                                         | pass   |
| Output             | expected PNG paths, counts, dimensions, and pixels in the existing E2E/benchmark gates                      | pass   |
| Supply chain       | frozen install policy, exact Playwright runtime, release workflow policy, publish dry-run, production audit | pass   |
| Source review      | [RC source review](./rc-source-review.md), zero unresolved RC blockers                                      | pass   |
| Performance sanity | matching three-run PR profiles before and after the cleanup stack                                           | pass   |

## Storybook compatibility

The published peer dependency remains `storybook: ^10.0.0`. The packed package was installed into temporary consumers and `storyfreeze/preset` was loaded successfully with Storybook 10.0.0 and 10.4.0. Both versions produced the Storybook 10.5 matcher fallback:

```text
(stories|story)\.(m?js|ts)x?$
```

This verifies the namespace import and missing-export fallback without adding another fixture or smoke suite. Storybook 10.5.2 remains the single current React/Vite static E2E fixture and the package-smoke consumer.

## Performance sanity

The comparison reuses existing `parallel=4`, process-isolation, managed-static PR artifacts. Both sides used Node 22.18.0, Playwright 1.61.1, Chrome for Testing 149.0.7827.55, runner image `20260714.240.1`, Linux `6.17.0-1020-azure`, an AMD EPYC 7763 host, one warm-up, and three measured runs.

- Baseline: alpha.9 master commit `98acbb9`, tree `c2b769c`, [workflow run 29687595846](https://github.com/l4dybird/storyfreeze/actions/runs/29687595846)
- Candidate: cleanup review commit `ee8984d`, tree `7f9496e`, [workflow run 29689062804](https://github.com/l4dybird/storyfreeze/actions/runs/29689062804)

| Metric       |            Baseline |           Candidate | Ratio | Sanity limit | Result |
| ------------ | ------------------: | ------------------: | ----: | -----------: | ------ |
| wall p50     |            4,057 ms |            3,953 ms | 0.974 |         1.03 | pass   |
| wall p95     |            4,118 ms |            3,963 ms | 0.962 |         1.05 | pass   |
| capture p95  |            1,168 ms |            1,159 ms | 0.992 |         1.05 | pass   |
| peak RSS p50 | 3,660,537,856 bytes | 3,669,344,256 bytes | 1.002 |         1.03 | pass   |
| CPU p50      |            9,050 ms |            8,600 ms | 0.950 |         1.03 | pass   |

Both sides completed all three measured runs with zero capture failure, retry, timeout, browser crash, close error, and residual Chromium process. The candidate therefore showed no material regression: wall p50/p95 and capture p95 were lower, CPU was 5.0% lower, and RSS differed by 0.2%.

This is a small hosted-runner regression sanity check, not a replacement for the balanced long-run records under `benchmarks/`. Its purpose is to reject an obvious cleanup regression without adding an excessive benchmark or smoke suite.

## RC transition checklist

1. Merge the cleanup stack in order and wait for the final required checks.
2. Start a fresh branch from the latest `master`; do not rebase the stale draft [#88](https://github.com/l4dybird/storyfreeze/pull/88).
3. Change Changesets prerelease mode from `alpha` to `rc` and generate exactly `0.2.0-rc.0`.
4. Confirm the transition pull request contains version, changelog, and prerelease-state changes only.
5. Run frozen install, clean build, unit tests, package smoke, Storybook 10 static E2E, publish dry-run, and dependency audit.
6. Merge the transition pull request. The existing publish workflow must publish the inspected tarball with npm `next`, provenance, `v0.2.0-rc.0`, and a GitHub prerelease.
7. Close #88 as superseded only after the replacement transition pull request exists.

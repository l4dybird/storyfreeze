# RC source review

- Review date: 2026-07-19
- Source base: `9a81babb7e28ce8e8fb8234e594be20b513ed303`
- Source tree: `72aac1016d074664dec89475f26d670d88fc3091`
- Target: `storyfreeze@0.2.0-alpha.9` before the RC transition

## Conclusion

No unresolved RC-blocking source defects were found. The review found one high-severity workspace dependency advisory: the package workspace's automatically installed Storybook 10.5.0 resolved `ws@8.18.0`. Development and packed-package smoke now use Storybook 10.5.2, while the published peer range remains `^10.0.0`. A production dependency audit reports no known vulnerabilities after that change.

The remaining large modules are a maintainability concern, not evidence of an RC defect. Further class decomposition is deferred until after the RC because it would change heavily exercised lifecycle code without strengthening the public contract.

## Reviewed areas

- package-root runtime and TypeScript exports, ESM-only behavior, and TypeDoc entry points
- CLI validation, safe Chromium launch defaults, signal handling, and exit codes
- preview URL integrity, managed/simple mode validation, and Storybook render failures
- capture deadlines, retry and recovery decisions, first-failure queue shutdown, and runtime disposal
- browser process/session ownership and late-start cleanup
- screenshot buffer reservations, atomic writes, path containment, collision rejection, and trace cleanup
- story-session baseline, reset verification, and fallback to strict fresh navigation
- package contents, consumer compilation, release metadata, Trusted Publishing, provenance, and replay behavior

## Static review results

| Check                                     | Result                                                |
| ----------------------------------------- | ----------------------------------------------------- |
| Internal TypeScript dependency cycles     | 0 across 53 production modules                        |
| Explicit `any` in production TypeScript   | 0                                                     |
| Unsafe TypeScript suppression comments    | 0                                                     |
| Unresolved review markers                 | One existing nanomatch declaration TODO; non-blocking |
| High-severity production dependency audit | 0 after the Storybook development pin                 |
| Package-root runtime exports              | `isScreenshot`, `withScreenshot` only                 |
| Packed package inventory                  | 215 files, exact allow-list match                     |

## Validation results

The review amendments were validated on Windows with the repository's pinned toolchain:

- frozen pnpm install; the lockfile remained unchanged
- baseline verification, format check, and Oxlint
- TypeScript package build and TypeDoc build
- 30 test files: 332 passed, 1 skipped
- existing packed-package smoke: 215 files and consumer TypeScript compile
- publish dry-run and production dependency audit

The parent stack PR additionally passed GitHub Actions on Node 22.18 and 24.11, Windows, the existing Storybook 10 static E2E, and the existing browser-isolation differential job.

## Deferred follow-ups

- `capturing-browser.ts` and `screenshot-service.ts` remain large. Split them only behind behavior-preserving tests after the RC; do not rewrite their lifecycle state machines during the release transition.
- Pin the remaining tag-referenced actions (`actions/checkout` and `pnpm/action-setup`) to immutable commit SHAs as release supply-chain hardening. The Vite+ setup action and cache actions are already pinned.
- Replace the local nanomatch declaration if the upstream package publishes types; it is currently required for strict compilation.

These follow-ups do not change the public API, capture result, Storybook 10 contract, or current RC release gate.

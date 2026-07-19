# storyfreeze

## 0.2.0-alpha.9

### Patch Changes

- 6b8f9fb: Load the viewport indexer on Storybook 10.0-10.4 by falling back to Storybook 10.5's story-file matcher when the internal export is unavailable.

## 0.2.0-alpha.8

### Patch Changes

- 872b091: Apply runtime-discovered viewport orientation changes to the current page instead of navigating the Storybook preview a second time.

## 0.2.0-alpha.7

### Patch Changes

- 96630cd: Group statically resolvable Storybook viewport globals before capture so runtime-discovery stories avoid repeated viewport-triggered navigation.

## 0.2.0-alpha.6

### Patch Changes

- e17e183: Avoid repeating the preview's completed visual-commit wait when only resource activity occurred before capture.

## 0.2.0-alpha.5

### Patch Changes

- f68e8c6: Reduce screenshot-buffer contention by measuring reservation pressure and sizing full-page reservations from the resolved layout dimensions.

## 0.2.0-alpha.4

### Minor Changes

- 0cd5738: Add manifest-first profile-aware scheduling, lazy process/context/hybrid/auto browser topology orchestration, deterministic context recycling, and the opt-in story-scoped capture protocol with generation and reset verification. Keep process isolation and strict fresh-navigation capture as compatibility defaults, with automatic strict fallback for unsafe or failed story sessions.

## 0.2.0-alpha.3

### Patch Changes

- d0d186d: Avoid rebuilding StoryFreeze during dependency installation and package packing; repository and release workflows now build it explicitly once before consuming the tarball.
- b9d2c11: Export the documented public configuration types from the package root and validate the TypeScript contract from the packed package.

## 0.2.0-alpha.2

### Patch Changes

- 541c7b3: Resolve unspecified screenshot viewports from Storybook viewport globals without adding a filename suffix.

## 0.2.0-alpha.1

### Patch Changes

- 0765a04: Add explicit preview mode selection and reject Storybook No Preview, error, and never-ready pages before capturing in simple mode.
- fd76b9d: Reject Storybook preview redirects that discard or change the story and StoryFreeze request query parameters.

## 0.2.0-alpha.0

### Minor Changes

- 074570e: Add opt-in Playwright browser-context isolation for parallel capture workers while keeping process isolation as the default. Reuse each worker's isolated context across viewport and device-emulation changes, while replacing it for retries and unhealthy recovery. Default the legacy fixed viewport delay to zero now that resource, metrics, and visual-commit waits provide explicit render-stability checks; users can still request an additional delay with `--viewport-delay`.
- fc9f796: Migrate workspace and release management to pnpm and Changesets.
- 8cf60f3: Use Playwright as the default browser backend while retaining Puppeteer as an explicit fallback.

### Patch Changes

- 972182b: Keep an acquired PNG successful when post-capture pointer cleanup fails because the interacted element disappeared.
- 03f40c2: Apply `--capture-timeout` to the complete capture attempt and replace a timed-out browser session only after its in-flight operation has stopped.
- eab5a50: Keep trace output paths stable and harden Chromium and npm executable discovery.
- 68fe74e: Load only the selected browser adapter, isolate shared Chromium discovery, and remove unused runtime dependencies.
- 97fa9f1: Keep variant output paths inside the configured directory and reject ambiguous capture names instead of silently overwriting PNGs.
- 12c31c0: Keep the Chromium sandbox enabled by default. Restricted containers can still opt out explicitly with `--browser-launch-options`.
- 48ccc34: Stop assigning capture requests after the first worker failure and wait for in-flight captures to settle before browser shutdown.
- 6073f9c: Stream Chromium trace chunks to a temporary file instead of concatenating the complete Playwright trace in memory.
- 838d322: Reject fractional, non-finite, and out-of-range numeric CLI options and require the complete shard argument to contain positive integers.

# ADR-009: Playwright browser distribution

- Status: Proposed
- Date: 2026-07-12
- Decision owners: StoryFreeze maintainers
- Applies to: Phase 5B and later

## Context

StoryFreeze currently resolves an explicit Chromium path or an installed Chrome channel and launches it through Puppeteer. Phase 5B adds an opt-in Playwright backend while preserving that behavior and the current `1 worker = 1 browser process` topology.

Playwright separates its runtime API from browser distribution. A browser can be installed explicitly with the Playwright CLI, while `@playwright/browser-chromium` downloads Chromium from an install script. Playwright-managed browsers live in an OS-specific cache and each Playwright release expects a matching browser revision.

StoryFreeze must also work in offline, proxy, and enterprise environments. Installing StoryFreeze must not unexpectedly download a browser, and pnpm's install-script approval and 24-hour release-age policies must continue to apply without exceptions.

## Decision

### Runtime package

StoryFreeze will use an exact, direct dependency on `playwright-core`. PR-510 will initially use `playwright-core@1.61.1`, published on 2026-06-23, after the repository's 24-hour release-age window.

StoryFreeze will not depend on `playwright`, `@playwright/test`, or `@playwright/browser-chromium` for its production runtime. In particular, it will not add a browser-download package to `allowBuilds` and will not run a browser download from `postinstall` or `prepare`.

### Browser installation

Browser installation is an explicit operator action. CI that tests the managed Playwright browser will invoke the CLI shipped by the pinned `playwright-core` version to install Chromium. Users may instead provide an existing compatible Chrome or Chromium executable.

The implementation must honor Playwright's supported proxy, custom download host, and browser cache environment variables. StoryFreeze will not create a second cache or copy browser binaries into its npm package.

### Browser resolution

The Playwright backend will resolve a browser in this order:

1. the executable given by `--chromium-path`
2. the explicitly requested `--chromium-channel`
3. the Chromium revision managed by the installed `playwright-core` version, if it exists
4. the existing StoryFreeze system Chrome/Chromium discovery path

Resolution will never trigger a download. If no executable is available, StoryFreeze will fail before worker startup with an actionable error that lists the explicit install and path/channel alternatives.

The Puppeteer backend and its discovery order remain unchanged. Puppeteer remains the default backend during Phase 5B.

### Scope boundaries

PR-510 will add the Playwright adapter, opt-in backend selection, managed-browser detection, and its CI installation step. It will not add BrowserContext sharing, change the default backend, remove Puppeteer, or add another fixture or smoke suite.

`storyfreeze doctor`, legacy launch-option warnings, and broader compatibility diagnostics remain PR-511 work. Fixed-Chromium differential comparison remains PR-520 work, so PR-510 will not claim driver-level image parity from different browser revisions.

## Consequences

### Positive

- Installing StoryFreeze has no browser-download side effect.
- Offline, proxy, artifact-repository, and system-browser environments retain an explicit path.
- The Playwright API and its managed browser revision stay version-aligned.
- CI can opt into a reproducible managed browser without imposing it on package consumers.
- No new install script needs to be trusted by pnpm.

### Negative

- A user selecting Playwright may need a separate browser-install command.
- System Chrome can differ from Playwright's managed Chromium and is not sufficient for pixel-level driver comparison.
- Documentation and errors must distinguish an installed API package from an installed browser binary.

## Rejected alternatives

### Depend on `playwright`

This adds an unnecessary wrapper for StoryFreeze's adapter and does not remove the need to manage browser installation explicitly. StoryFreeze only needs the library API and CLI supplied by `playwright-core`.

### Depend on `@playwright/browser-chromium`

This package downloads a browser during package installation. That makes StoryFreeze installation dependent on CDN/proxy availability, requires install-script approval under pnpm, and imposes a large binary download even on users who keep the Puppeteer backend or provide Chrome themselves.

### Require only system Chrome

This avoids downloads but removes Playwright's version-matched managed-browser path and weakens CI reproducibility. System Chrome remains a fallback, not the only distribution strategy.

## References

- [Playwright Library: browser installation choices](https://playwright.dev/docs/library#browser-downloads)
- [Playwright: managing browser binaries](https://playwright.dev/docs/browsers#managing-browser-binaries)
- [Playwright: proxy and artifact repository settings](https://playwright.dev/docs/browsers#install-behind-a-firewall-or-a-proxy)
- [playwright-core 1.61.1 npm metadata](https://www.npmjs.com/package/playwright-core/v/1.61.1)

# ADR-010: `captureBeyondViewport` compatibility

- Status: Accepted
- Date: 2026-07-12
- Decision owners: StoryFreeze maintainers
- Applies to: Phase 5B and later

## Context

StoryFreeze exposes Puppeteer's screenshot options, including `fullPage`, `clip`, `omitBackground`, and `captureBeyondViewport`. The Puppeteer 9 baseline defaults `captureBeyondViewport` to `true`, rejects `fullPage` together with `clip`, normalizes clip coordinates, and temporarily expands then restores the emulated viewport when full-page capture is requested without capturing beyond it.

Playwright's page screenshot API manages device scale through immutable browser-context state. Reapplying that state during a screenshot would discard StoryFreeze's dynamic CDP viewport scale. The Playwright adapter therefore cannot delegate this compatibility contract to `page.screenshot()`.

## Decision

StoryFreeze will keep `captureBeyondViewport` as a supported browser-neutral option with a default of `true`.

The Playwright adapter will use Chromium CDP `Page.captureScreenshot` and reproduce the Puppeteer 9 contract:

- reject `fullPage` together with `clip`
- normalize fractional clip coordinates before capture
- use `Page.getLayoutMetrics().contentSize` for full-page dimensions
- pass the requested `captureBeyondViewport` value without changing `false` to `true`
- temporarily expand device metrics for full-page capture with `captureBeyondViewport: false`
- restore device metrics and a transparent background override even when capture fails
- return the PNG bytes as a `Buffer`

The Puppeteer adapter continues to delegate to Puppeteer, which remains the compatibility baseline.

## Consequences

Both backends retain the existing public screenshot options and defaults. Playwright remains tied to Chromium CDP for screenshot capture even though the rest of the adapter uses public Playwright APIs where possible.

Pixel-level equivalence is not asserted by this decision. PR-520 will compare both drivers with the same Chromium executable, OS image, fonts, viewport, scale, and PNG conditions.

## References

- [Puppeteer 9.1.1 screenshot implementation](https://github.com/puppeteer/puppeteer/blob/v9.1.1/src/common/Page.ts)
- [Chrome DevTools Protocol: Page.captureScreenshot](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot)

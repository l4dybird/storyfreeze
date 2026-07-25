import { EmulationProbe } from './BenchSurface';

// S4: renders the Chromium emulation state into the pixels so that any change
// in how StoryFreeze issues Emulation.setDeviceMetricsOverride /
// setTouchEmulationEnabled shows up as a PNG byte difference.
const meta = {
  title: 'Bench/Probe',
  component: EmulationProbe,
};

export default meta;

export const DesktopLandscape = {
  args: { label: 'desktop landscape' },
  parameters: { screenshot: { viewport: { width: 1200, height: 800 } } },
};

// Non-mobile portrait: Playwright would send landscapePrimary/0 while
// StoryFreeze's own override asks for portraitPrimary/0.
export const DesktopPortrait = {
  args: { label: 'desktop portrait' },
  parameters: { screenshot: { viewport: { width: 800, height: 1200 } } },
};

export const MobilePortrait = {
  args: { label: 'mobile portrait' },
  parameters: {
    screenshot: {
      viewport: { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
  },
};

export const MobileLandscape = {
  args: { label: 'mobile landscape' },
  parameters: {
    screenshot: {
      viewport: { width: 667, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
  },
};

// Explicit isLandscape contradicting the dimensions.
export const ContradictoryOrientation = {
  args: { label: 'portrait dims, isLandscape true' },
  parameters: {
    screenshot: {
      viewport: { width: 800, height: 1200, isLandscape: true },
    },
  },
};

// Touch without mobile emulation.
export const TouchWithoutMobile = {
  args: { label: 'touch without mobile' },
  parameters: {
    screenshot: {
      viewport: { width: 800, height: 600, hasTouch: true },
    },
  },
};

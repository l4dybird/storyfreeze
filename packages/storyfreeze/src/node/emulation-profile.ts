import type { BrowserDeviceDescriptor } from './browser-backend.js';
import type { StrictScreenshotOptions, Viewport } from '../shared/types.js';

/** Fully normalized Chromium emulation settings used by planning and scheduling. */
export interface EmulationProfile {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  isLandscape: boolean;
}

export function resolveViewport(
  viewport: StrictScreenshotOptions['viewport'],
  deviceDescriptors: readonly BrowserDeviceDescriptor[],
): Viewport | undefined {
  if (typeof viewport !== 'string') return viewport;
  if (/^\d+$/.test(viewport)) return { width: Number(viewport), height: 600 };
  if (/^\d+x\d+$/.test(viewport)) {
    const [width, height] = viewport.split('x').map(Number);
    return { width, height };
  }
  return deviceDescriptors.find(descriptor => descriptor.name === viewport)?.viewport;
}

export function normalizeEmulationProfile(viewport: Viewport): EmulationProfile {
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    isMobile: viewport.isMobile ?? false,
    hasTouch: viewport.hasTouch ?? false,
    isLandscape: viewport.isLandscape ?? viewport.width > viewport.height,
  };
}

export function toViewport(profile: EmulationProfile): Viewport {
  return { ...profile };
}

export function emulationProfileKey(profile: EmulationProfile): string {
  return [
    profile.width,
    profile.height,
    profile.deviceScaleFactor,
    profile.isMobile ? 1 : 0,
    profile.hasTouch ? 1 : 0,
    profile.isLandscape ? 1 : 0,
  ].join(':');
}

export function sameEmulationProfile(left: EmulationProfile, right: EmulationProfile): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.deviceScaleFactor === right.deviceScaleFactor &&
    left.isMobile === right.isMobile &&
    left.hasTouch === right.hasTouch &&
    left.isLandscape === right.isLandscape
  );
}

export function sameEmulationClass(left: EmulationProfile, right: EmulationProfile): boolean {
  return (
    left.deviceScaleFactor === right.deviceScaleFactor &&
    left.isMobile === right.isMobile &&
    left.hasTouch === right.hasTouch &&
    left.isLandscape === right.isLandscape
  );
}

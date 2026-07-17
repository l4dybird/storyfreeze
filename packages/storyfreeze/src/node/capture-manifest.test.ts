import { describe, expect, it } from 'vite-plus/test';
import { createBaseScreenshotOptions } from '../shared/screenshot-options-helper.js';
import {
  createCaptureId,
  generateCaptureManifest,
  parseCaptureManifest,
  serializeCaptureManifest,
  validateCaptureManifest,
} from './capture-manifest.js';

const devices = [
  {
    name: 'Phone',
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  },
];

function base(viewports = ['800x600']) {
  return createBaseScreenshotOptions({ delay: 0, disableWaitAssets: false, viewports });
}

describe(generateCaptureManifest, () => {
  it('serializes deterministically and expands known viewport variants before execution', () => {
    const input = {
      stories: [
        { id: 'z--story', title: 'Z', name: 'Story' },
        { id: 'a--story', title: 'A', name: 'Story', tags: ['test'] },
      ],
      baseOptions: base(['800x600', 'Phone']),
      deviceDescriptors: devices,
      generatedAt: '2026-07-17T00:00:00.000Z',
      mode: 'managed' as const,
    };

    const first = generateCaptureManifest(input);
    const second = generateCaptureManifest(input);

    expect(serializeCaptureManifest(first)).toBe(serializeCaptureManifest(second));
    expect(parseCaptureManifest(serializeCaptureManifest(first))).toEqual(first);
    expect(first.stories.map(story => story.storyId)).toEqual(['a--story', 'z--story']);
    expect(first.captures).toHaveLength(4);
    expect(first.captures.find(capture => capture.captureId === createCaptureId('a--story', ['Phone']))).toMatchObject({
      planning: { eligibility: 'runtime-validation' },
      profile: {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        isLandscape: false,
      },
    });
    expect(first.captures.find(capture => capture.captureId === createCaptureId('a--story', []))).toMatchObject({
      planning: { eligibility: 'runtime-discovery' },
    });
  });

  it('expands supplied static variants and conservatively classifies runtime functions', () => {
    const manifest = generateCaptureManifest({
      stories: [
        {
          id: 'button--primary',
          title: 'Button',
          name: 'Primary',
          screenshotOptions: {
            viewport: 'Phone',
            variants: {
              hovered: { hover: '#button' },
              dynamic: { waitFor: async () => {} },
            },
          },
          eligibility: 'static',
        },
      ],
      baseOptions: base(),
      deviceDescriptors: devices,
      generatedAt: '2026-07-17T00:00:00.000Z',
      mode: 'managed',
    });

    expect(manifest.captures.map(capture => capture.variantKey)).toEqual([[], ['dynamic'], ['hovered']]);
    expect(manifest.captures.every(capture => capture.planning.eligibility === 'runtime-discovery')).toBe(true);
    expect(manifest.captures[0].profile).toMatchObject({ width: 390, height: 844, isMobile: true });
  });

  it('marks simple-mode captures static because only CLI options are used', () => {
    const manifest = generateCaptureManifest({
      stories: [{ id: 'a--story', title: 'A', name: 'Story' }],
      baseOptions: base(['800x600', '1024x768']),
      deviceDescriptors: devices,
      generatedAt: '2026-07-17T00:00:00.000Z',
      mode: 'simple',
    });
    expect(manifest.captures.every(capture => capture.planning.eligibility === 'static')).toBe(true);
  });
});

describe(validateCaptureManifest, () => {
  it('rejects duplicate capture ids and mismatched profiles', () => {
    const manifest = generateCaptureManifest({
      stories: [{ id: 'a--story', title: 'A', name: 'Story' }],
      baseOptions: base(),
      deviceDescriptors: devices,
      generatedAt: '2026-07-17T00:00:00.000Z',
      mode: 'managed',
    });
    manifest.captures.push({ ...manifest.captures[0] });
    expect(() => validateCaptureManifest(manifest)).toThrow('Duplicate manifest capture id');

    manifest.captures.pop();
    manifest.captures[0].options.viewport.width += 1;
    expect(() => validateCaptureManifest(manifest)).toThrow('profile and options.viewport must match');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { STORYFREEZE_ADDON_VERSION, createPreviewStateBase } from './preview-protocol.js';

describe('preview protocol', () => {
  it('embeds the package version for CLI/preview mismatch detection', () => {
    const metadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(STORYFREEZE_ADDON_VERSION).toBe(metadata.version);
  });

  it('creates the versioned owned state envelope', () => {
    expect(createPreviewStateBase('button--primary', '0-1')).toEqual({
      protocolVersion: 1,
      addonVersion: STORYFREEZE_ADDON_VERSION,
      storyId: 'button--primary',
      requestId: '0-1',
    });
  });
});

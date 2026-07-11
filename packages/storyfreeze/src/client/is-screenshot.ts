import { STORYFREEZE_REQUEST_ID_PARAM } from '../shared/preview-protocol.js';

/**
 *
 * @returns Whether current process runs in StoryFreeze browser.
 *
 **/
export function isScreenshot() {
  return new URL(window.location.href).searchParams.has(STORYFREEZE_REQUEST_ID_PARAM);
}

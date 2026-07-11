/**
 *
 * @returns Whether current process runs in StoryFreeze browser.
 *
 **/
export function isScreenshot() {
  return !!(window as any).emitCapture;
}

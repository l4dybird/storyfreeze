export const STORYFREEZE_VIEWPORT_PROFILE_TAG_PREFIX = 'storyfreeze-viewport-';

export function createViewportProfileTag(profileKey: string): string {
  return `${STORYFREEZE_VIEWPORT_PROFILE_TAG_PREFIX}${encodeURIComponent(profileKey)}`;
}

export function parseViewportProfileTag(tag: string): string | undefined {
  if (!tag.startsWith(STORYFREEZE_VIEWPORT_PROFILE_TAG_PREFIX)) return undefined;
  const encoded = tag.slice(STORYFREEZE_VIEWPORT_PROFILE_TAG_PREFIX.length);
  if (!encoded) return undefined;
  try {
    const profileKey = decodeURIComponent(encoded);
    return profileKey || undefined;
  } catch {
    return undefined;
  }
}

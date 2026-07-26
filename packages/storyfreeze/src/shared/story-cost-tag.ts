export const STORYFREEZE_COST_MODEL_VERSION = 1 as const;
export const STORYFREEZE_DEFAULT_STORY_COST_MS = 500;
export const STORYFREEZE_STORY_COST_TAG_PREFIX = `storyfreeze-cost-v${STORYFREEZE_COST_MODEL_VERSION}-`;

function normalizeCost(costMs: number): number {
  if (!Number.isFinite(costMs)) return STORYFREEZE_DEFAULT_STORY_COST_MS;
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.round(costMs)));
}

export function createStoryCostTag(costMs: number): string {
  return `${STORYFREEZE_STORY_COST_TAG_PREFIX}${normalizeCost(costMs)}`;
}

export function parseStoryCostTag(tag: string): number | undefined {
  if (!tag.startsWith(STORYFREEZE_STORY_COST_TAG_PREFIX)) return undefined;
  const encoded = tag.slice(STORYFREEZE_STORY_COST_TAG_PREFIX.length);
  if (!/^[1-9]\d*$/.test(encoded)) return undefined;
  const costMs = Number(encoded);
  return Number.isSafeInteger(costMs) ? costMs : undefined;
}

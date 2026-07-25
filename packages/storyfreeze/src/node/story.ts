import { STORYFREEZE_DEFAULT_STORY_COST_MS } from '../shared/story-cost-tag.js';

// Story shape retained from storycrawler while its MIT-licensed runtime is internalized.
// Source: https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
export type Story = {
  id: string;
  kind: string;
  story: string;
  version: 'v5';
  viewportProfileHint?: string;
  /** Static estimate, in milliseconds, used only to balance work. */
  estimatedCostMs?: number;
};

/** Static per-story estimate, falling back to the shared default. */
export function storyCostMs(story: Story): number {
  const estimate = story.estimatedCostMs;
  return typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0
    ? estimate
    : STORYFREEZE_DEFAULT_STORY_COST_MS;
}

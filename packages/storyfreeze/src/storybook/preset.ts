import type { Indexer } from 'storybook/internal/types';
import { storyfreezeViewportIndexer } from './viewport-indexer.js';

export function experimental_indexers(existingIndexers: Indexer[] = []): Indexer[] {
  return [storyfreezeViewportIndexer, ...existingIndexers];
}

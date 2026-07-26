import { storyCostMs, type Story } from './story.js';
import type { ShardOptions, ShardStrategy } from './types.js';

export const parseShardOptions = (arg: string): ShardOptions => {
  const match = arg.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!match) {
    throw new Error(`The shard argument must be in the format <shardNumber>/<totalShards>.`);
  }
  const shardNumber = Number(match[1]);
  const totalShards = Number(match[2]);

  if (!Number.isSafeInteger(shardNumber) || !Number.isSafeInteger(totalShards)) {
    throw new Error(`The shard arguments must be safe integers.`);
  }

  if (shardNumber === 0 || totalShards === 0) {
    throw new Error(`The shard arguments cannot be 0.`);
  }

  if (shardNumber < 0 || totalShards < 0) {
    throw new Error(`The shard arguments cannot be negative.`);
  }

  if (shardNumber > totalShards) {
    throw new Error(`The shard number cannot be greater than the total number of shards.`);
  }

  return {
    shardNumber,
    totalShards,
    strategy: 'cost',
  };
};

/**
 *
 * Sort the stories by their ID.
 *
 **/
export const sortStories = (stories: Story[]): Story[] => {
  return stories.sort((a, b) => {
    if (a.id < b.id) {
      return -1;
    }
    if (a.id > b.id) {
      return 1;
    }
    return 0;
  });
};

const byId = (left: Story, right: Story) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 *
 * Select this machine's share of the stories.
 *
 * `round-robin` keeps the 0.2 behaviour: every Nth story by sorted index.
 *
 * `cost` balances estimated work instead of story count. Shards run on separate
 * machines with no work stealing between them, so an uneven split is paid in
 * full by the slowest shard: one shard holding all the multi-viewport stories
 * decides the wall time of the whole run. Every machine derives the same
 * assignment from the same index, so no coordination is required.
 *
 **/
export const shardStories = (
  stories: Story[],
  shardNumber: number,
  totalShards: number,
  strategy: ShardStrategy,
): Story[] => {
  const shardIndex = shardNumber - 1;
  if (strategy === 'round-robin') return stories.filter((_, index) => index % totalShards === shardIndex);

  // Longest-processing-time-first: place the most expensive stories while the
  // shards are still empty, which bounds how far the final split can drift.
  const ordered = [...stories].sort((left, right) => storyCostMs(right) - storyCostMs(left) || byId(left, right));
  const loads = new Array<number>(totalShards).fill(0);
  const selected: Story[] = [];
  for (const story of ordered) {
    let target = 0;
    for (let candidate = 1; candidate < totalShards; candidate += 1) {
      if (loads[candidate] < loads[target]) target = candidate;
    }
    loads[target] += storyCostMs(story);
    if (target === shardIndex) selected.push(story);
  }
  // Restore index order so downstream grouping, logging and output stay
  // independent of how the shard was selected.
  return selected.sort(byId);
};

import type { Story } from './story.js';
import type { ShardOptions } from './types.js';

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

/**
 *
 * Shard stories in a round robin fashion based on their index in the sorted list.
 *
 **/
export const shardStories = (stories: Story[], shardNumber: number, totalShards: number): Story[] => {
  const shardIndex = shardNumber - 1;

  return stories.filter((_, index) => index % totalShards === shardIndex);
};

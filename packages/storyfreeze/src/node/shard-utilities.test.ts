import { describe, expect, it } from 'vite-plus/test';
import { storyCostMs, type Story } from './story.js';
import { parseShardOptions, sortStories, shardStories } from './shard-utilities.js';

describe(parseShardOptions, () => {
  it('should accept correct arguments', () => {
    expect(parseShardOptions('1/1')).toMatchObject({ shardNumber: 1, totalShards: 1 });
    expect(parseShardOptions('1/2')).toMatchObject({ shardNumber: 1, totalShards: 2 });
    expect(parseShardOptions('2/2')).toMatchObject({ shardNumber: 2, totalShards: 2 });
    expect(parseShardOptions('1/3')).toMatchObject({ shardNumber: 1, totalShards: 3 });
    expect(parseShardOptions('2/3')).toMatchObject({ shardNumber: 2, totalShards: 3 });
    expect(parseShardOptions('3/3')).toMatchObject({ shardNumber: 3, totalShards: 3 });
  });
  it('should be resiliant to whitespace', () => {
    expect(parseShardOptions(' 1/2')).toMatchObject({ shardNumber: 1, totalShards: 2 });
    expect(parseShardOptions('1/2 ')).toMatchObject({ shardNumber: 1, totalShards: 2 });
    expect(parseShardOptions(' 1/2 ')).toMatchObject({ shardNumber: 1, totalShards: 2 });
    expect(parseShardOptions('1 /2')).toMatchObject({ shardNumber: 1, totalShards: 2 });
    expect(parseShardOptions('1/ 2')).toMatchObject({ shardNumber: 1, totalShards: 2 });
    expect(parseShardOptions('1 / 2')).toMatchObject({ shardNumber: 1, totalShards: 2 });
    expect(parseShardOptions(' 1 /2')).toMatchObject({ shardNumber: 1, totalShards: 2 });
    expect(parseShardOptions('1/ 2 ')).toMatchObject({ shardNumber: 1, totalShards: 2 });
    expect(parseShardOptions(' 1 / 2 ')).toMatchObject({ shardNumber: 1, totalShards: 2 });
  });
  it('errors for incorrect arguments', () => {
    expect(() => parseShardOptions('0')).toThrowError();
    expect(() => parseShardOptions('1')).toThrowError();
    expect(() => parseShardOptions('text')).toThrowError();
    expect(() => parseShardOptions('0/1')).toThrowError();
    expect(() => parseShardOptions('-1/1')).toThrowError();
    expect(() => parseShardOptions('2/1')).toThrowError();
    expect(() => parseShardOptions('0/3')).toThrowError();
    expect(() => parseShardOptions('/3')).toThrowError();
    expect(() => parseShardOptions('4/')).toThrowError();
    expect(() => parseShardOptions('4/3')).toThrowError();
    expect(() => parseShardOptions('ab/c')).toThrowError();
    expect(() => parseShardOptions('1foo/2bar')).toThrowError();
    expect(() => parseShardOptions('1.9/2')).toThrowError();
    expect(() => parseShardOptions('1e2/200')).toThrowError();
    expect(() => parseShardOptions('9007199254740992/9007199254740992')).toThrowError();
  });
});

describe(sortStories, () => {
  it('should sort stories alphabetically based on their ID', () => {
    const stories: Story[] = [
      {
        id: 'simple-tooltip--with-component-content',
        kind: 'simple/Tooltip',
        story: 'with component content',
        version: 'v5',
      },
      {
        id: 'complex-scene--for-table-of-contents',
        kind: 'complex/Scene',
        story: 'for table-of-contents',
        version: 'v5',
      },
      {
        id: 'complex-scene--basic-usage',
        kind: 'complex/Scene',
        story: 'basic-usage',
        version: 'v5',
      },
      {
        id: 'complex-scene--verticalannotation',
        kind: 'complex/Scene',
        story: 'verticalannotation',
        version: 'v5',
      },
    ];

    const sortedStories = sortStories(stories);

    let prev: Story | null = null;

    for (const next of sortedStories) {
      if (!prev) {
        prev = next;
        continue;
      }
      expect(next.id > prev.id).toBeTruthy();

      prev = next;
    }
  });
});

describe(shardStories, () => {
  it('a single shard gets all the stories', () => {
    const stories: Story[] = [
      {
        id: 'simple-tooltip--with-component-content',
        kind: 'simple/Tooltip',
        story: 'with component content',
        version: 'v5',
      },
      {
        id: 'complex-scene--for-table-of-contents',
        kind: 'complex/Scene',
        story: 'for table-of-contents',
        version: 'v5',
      },
      {
        id: 'complex-scene--basic-usage',
        kind: 'complex/Scene',
        story: 'basic-usage',
        version: 'v5',
      },
      {
        id: 'complex-scene--verticalannotation',
        kind: 'complex/Scene',
        story: 'verticalannotation',
        version: 'v5',
      },
    ];

    const sortedStories = sortStories(stories);
    const shardedStories = shardStories(sortedStories, 1, 1, 'round-robin');

    expect(shardedStories).toMatchObject(sortedStories);
  });
  it('two shards get equal amounts of stories when the number of them is even', () => {
    const stories: Story[] = [
      {
        id: 'simple-tooltip--with-component-content',
        kind: 'simple/Tooltip',
        story: 'with component content',
        version: 'v5',
      },
      {
        id: 'complex-scene--for-table-of-contents',
        kind: 'complex/Scene',
        story: 'for table-of-contents',
        version: 'v5',
      },
      {
        id: 'complex-scene--basic-usage',
        kind: 'complex/Scene',
        story: 'basic-usage',
        version: 'v5',
      },
      {
        id: 'complex-scene--verticalannotation',
        kind: 'complex/Scene',
        story: 'verticalannotation',
        version: 'v5',
      },
    ];

    const sortedStories = sortStories(stories);
    const shardedStoriesA = shardStories(sortedStories, 1, 2, 'round-robin');
    const shardedStoriesB = shardStories(sortedStories, 2, 2, 'round-robin');

    expect(shardedStoriesA.length).toBe(shardedStoriesB.length);
  });

  it('two shards get roughly equal amounts of stories when the number of them is odd', () => {
    const stories: Story[] = [
      {
        id: 'simple-tooltip--with-component-content',
        kind: 'simple/Tooltip',
        story: 'with component content',
        version: 'v5',
      },
      {
        id: 'complex-scene--for-table-of-contents',
        kind: 'complex/Scene',
        story: 'for table-of-contents',
        version: 'v5',
      },
      {
        id: 'complex-scene--verticalannotation',
        kind: 'complex/Scene',
        story: 'verticalannotation',
        version: 'v5',
      },
    ];

    const sortedStories = sortStories(stories);
    const shardedStoriesA = shardStories(sortedStories, 1, 2, 'round-robin');
    const shardedStoriesB = shardStories(sortedStories, 2, 2, 'round-robin');

    expect(Math.abs(shardedStoriesA.length - shardedStoriesB.length)).toBeLessThanOrEqual(1);
  });

  it("stories aren't duplicated when there are more shards than stories", () => {
    const stories: Story[] = [
      {
        id: 'simple-tooltip--with-component-content',
        kind: 'simple/Tooltip',
        story: 'with component content',
        version: 'v5',
      },
      {
        id: 'complex-scene--for-table-of-contents',
        kind: 'complex/Scene',
        story: 'for table-of-contents',
        version: 'v5',
      },
    ];

    const sortedStories = sortStories(stories);
    const shardedStoriesA = shardStories(sortedStories, 1, 4, 'round-robin');
    const shardedStoriesB = shardStories(sortedStories, 2, 4, 'round-robin');
    const shardedStoriesC = shardStories(sortedStories, 3, 4, 'round-robin');
    const shardedStoriesD = shardStories(sortedStories, 4, 4, 'round-robin');

    expect(shardedStoriesA.length + shardedStoriesB.length + shardedStoriesC.length + shardedStoriesD.length).toBe(
      sortedStories.length,
    );
  });

  it('complex and simple stories are distributed evenly across shards', () => {
    function makeDummyStory(index: number, complex: boolean): Story {
      return {
        id: `${complex ? 'complex' : 'simple'}-component--${index}`,
        kind: `${complex ? 'complex' : 'simple'}/Component`,
        story: `${index}`,
        version: 'v5',
      } as const;
    }

    const stories: Story[] = [
      makeDummyStory(0, true),
      makeDummyStory(1, true),
      makeDummyStory(2, true),
      makeDummyStory(3, true),
      makeDummyStory(4, false),
      makeDummyStory(5, false),
      makeDummyStory(6, false),
      makeDummyStory(7, false),
      makeDummyStory(8, false),
      makeDummyStory(9, false),
      makeDummyStory(10, false),
      makeDummyStory(11, false),
    ];

    const sortedStories = sortStories(stories);
    const shardedStoriesA = shardStories(sortedStories, 1, 2, 'round-robin');
    const shardedStoriesB = shardStories(sortedStories, 2, 2, 'round-robin');

    const numComplexOnA = shardedStoriesA.filter(story => story.id.startsWith('complex')).length;
    const numComplexOnB = shardedStoriesB.filter(story => story.id.startsWith('complex')).length;

    expect(shardedStoriesA.length).toBe(shardedStoriesB.length);
    expect(numComplexOnA).toBe(numComplexOnB);
  });

  describe('cost strategy', () => {
    const costed = (id: string, estimatedCostMs?: number): Story => ({
      id,
      kind: 'Example',
      story: id,
      version: 'v5',
      ...(estimatedCostMs === undefined ? {} : { estimatedCostMs }),
    });

    it('balances estimated work instead of story count', () => {
      // Round-robin on sorted index would give one shard both expensive stories.
      const stories = [costed('a-expensive', 2000), costed('b-cheap'), costed('c-expensive', 2000), costed('d-cheap')];
      const first = shardStories(stories, 1, 2, 'cost');
      const second = shardStories(stories, 2, 2, 'cost');
      const cost = (shard: Story[]) => shard.reduce((total, story) => total + storyCostMs(story), 0);

      expect(cost(first)).toBe(2500);
      expect(cost(second)).toBe(2500);
      expect(cost(shardStories(stories, 1, 2, 'round-robin'))).toBe(4000);
    });

    it('covers every story exactly once across shards', () => {
      const stories = Array.from({ length: 37 }, (_, index) =>
        costed(`story-${String(index).padStart(2, '0')}`, index % 5 === 0 ? 1500 : undefined),
      );
      const totalShards = 4;
      const selected = Array.from({ length: totalShards }, (_, index) =>
        shardStories(stories, index + 1, totalShards, 'cost'),
      );
      const ids = selected.flat().map(story => story.id);

      expect(ids).toHaveLength(stories.length);
      expect(new Set(ids).size).toBe(stories.length);
    });

    it('returns each shard in sorted index order so output stays deterministic', () => {
      const stories = [costed('c'), costed('a'), costed('b'), costed('d')];
      for (let shard = 1; shard <= 2; shard += 1) {
        const ids = shardStories(stories, shard, 2, 'cost').map(story => story.id);
        expect(ids).toEqual([...ids].sort());
      }
    });

    it('is stable across machines computing their own shard', () => {
      const stories = Array.from({ length: 20 }, (_, index) => costed(`s-${index}`, index % 3 === 0 ? 900 : 400));
      // Two independent invocations for the same shard must agree, otherwise
      // machines would duplicate or drop stories.
      expect(shardStories(stories, 2, 3, 'cost').map(story => story.id)).toEqual(
        shardStories(stories, 2, 3, 'cost').map(story => story.id),
      );
    });
  });
});

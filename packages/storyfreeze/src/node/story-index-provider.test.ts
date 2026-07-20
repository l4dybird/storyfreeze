import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { StorybookStoryIndexProvider } from './story-index-provider.js';

describe(StorybookStoryIndexProvider, () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads story entries from index.json, excludes docs, and sorts by id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          entries: {
            'button--secondary': {
              type: 'story',
              id: 'button--secondary',
              title: 'Button',
              name: 'Secondary',
              tags: ['autodocs', 'storyfreeze-viewport-mobile%20portrait'],
              importPath: './Button.stories.ts',
            },
            'button--docs': {
              type: 'docs',
              id: 'button--docs',
              title: 'Button',
              name: 'Docs',
            },
            'button--primary': {
              type: 'story',
              id: 'button--primary',
              title: 'Button',
              name: 'Primary',
            },
          },
        }),
      ),
    );
    const signal = new AbortController().signal;

    await expect(
      new StorybookStoryIndexProvider().load(new URL('https://example.test/storybook?ignored=1'), signal),
    ).resolves.toEqual([
      { id: 'button--primary', title: 'Button', name: 'Primary' },
      {
        id: 'button--secondary',
        title: 'Button',
        name: 'Secondary',
        tags: ['autodocs', 'storyfreeze-viewport-mobile%20portrait'],
        importPath: './Button.stories.ts',
        viewportProfileHint: 'mobile portrait',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toEqual(new URL('https://example.test/storybook/index.json'));
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });

  it('rejects unsuccessful HTTP responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    await expect(new StorybookStoryIndexProvider().load(new URL('https://example.test'))).rejects.toThrow('HTTP 404');
  });

  it('rejects invalid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{'));

    await expect(new StorybookStoryIndexProvider().load(new URL('https://example.test'))).rejects.toThrow(
      'Invalid JSON',
    );
  });

  it('aborts the index request when its operation timeout expires', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          requestSignal = options?.signal ?? undefined;
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
        }),
    );

    await expect(new StorybookStoryIndexProvider().load(new URL('https://example.test'), undefined, 5)).rejects.toThrow(
      'Story index load did not settle within 5 msec',
    );
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([
    ['a document without entries', {}],
    ['a non-object entry', { entries: { invalid: null } }],
    ['an entry without a type', { entries: { invalid: {} } }],
    ['an invalid story', { entries: { invalid: { type: 'story', id: 'story--invalid', title: 'Story', name: 1 } } }],
    [
      'invalid tags',
      {
        entries: {
          invalid: { type: 'story', id: 'story--invalid', title: 'Story', name: 'Invalid', tags: [1] },
        },
      },
    ],
    [
      'an invalid import path',
      {
        entries: {
          invalid: { type: 'story', id: 'story--invalid', title: 'Story', name: 'Invalid', importPath: 1 },
        },
      },
    ],
  ])('rejects %s', async (_label, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body)));

    await expect(new StorybookStoryIndexProvider().load(new URL('https://example.test'))).rejects.toThrow(
      'Invalid Storybook index',
    );
  });

  it('rejects duplicate story IDs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          entries: {
            first: { type: 'story', id: 'duplicate', title: 'Story', name: 'First' },
            second: { type: 'story', id: 'duplicate', title: 'Story', name: 'Second' },
          },
        }),
      ),
    );

    await expect(new StorybookStoryIndexProvider().load(new URL('https://example.test'))).rejects.toThrow(
      'duplicate story id',
    );
  });
});

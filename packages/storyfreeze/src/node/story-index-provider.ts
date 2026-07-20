import { parseViewportProfileTag } from '../shared/viewport-profile-tag.js';

export interface StoryDescriptor {
  id: string;
  title: string;
  name: string;
  tags?: readonly string[];
  importPath?: string;
  viewportProfileHint?: string;
}

export interface StoryIndexProvider {
  load(baseUrl: URL, signal?: AbortSignal, timeoutMs?: number): Promise<readonly StoryDescriptor[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(entry: Record<string, unknown>, field: 'id' | 'title' | 'name', key: string): string {
  const value = entry[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid Storybook index: entries[${JSON.stringify(key)}].${field} must be a non-empty string.`);
  }
  return value;
}

function indexUrlFor(baseUrl: URL): URL {
  const indexUrl = new URL(baseUrl);
  indexUrl.pathname = `${indexUrl.pathname.replace(/\/$/, '')}/index.json`;
  indexUrl.search = '';
  indexUrl.hash = '';
  return indexUrl;
}

export class StorybookStoryIndexProvider implements StoryIndexProvider {
  async load(
    baseUrl: URL,
    signal?: AbortSignal,
    timeoutMs = Number.POSITIVE_INFINITY,
  ): Promise<readonly StoryDescriptor[]> {
    const indexUrl = indexUrlFor(baseUrl);
    const timeoutController = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    const timeoutError = new Error(`Story index load did not settle within ${timeoutMs} msec.`);
    const timeout = Number.isFinite(timeoutMs)
      ? setTimeout(() => timeoutController.abort(timeoutError), Math.min(2_147_483_647, Math.max(0, timeoutMs)))
      : undefined;
    try {
      const response = await fetch(indexUrl, { signal: requestSignal });

      if (!response.ok) {
        throw new Error(`Failed to load Storybook index from ${indexUrl.href}: HTTP ${response.status}.`);
      }

      let document: unknown;
      try {
        document = await response.json();
      } catch {
        if (timeoutController.signal.aborted && !signal?.aborted) throw timeoutError;
        throw new Error(`Invalid JSON in Storybook index from ${indexUrl.href}.`);
      }

      if (!isRecord(document) || !isRecord(document.entries)) {
        throw new Error('Invalid Storybook index: entries must be an object.');
      }

      const stories: StoryDescriptor[] = [];
      const ids = new Set<string>();

      for (const [key, value] of Object.entries(document.entries)) {
        if (!isRecord(value)) {
          throw new Error(`Invalid Storybook index: entries[${JSON.stringify(key)}] must be an object.`);
        }
        if (typeof value.type !== 'string') {
          throw new Error(`Invalid Storybook index: entries[${JSON.stringify(key)}].type must be a string.`);
        }
        if (value.type !== 'story') continue;

        const id = requireString(value, 'id', key);
        if (ids.has(id)) {
          throw new Error(`Invalid Storybook index: duplicate story id ${JSON.stringify(id)}.`);
        }
        ids.add(id);

        const story: StoryDescriptor = {
          id,
          title: requireString(value, 'title', key),
          name: requireString(value, 'name', key),
        };

        if (value.tags !== undefined) {
          if (!Array.isArray(value.tags) || !value.tags.every(tag => typeof tag === 'string')) {
            throw new Error(
              `Invalid Storybook index: entries[${JSON.stringify(key)}].tags must be an array of strings.`,
            );
          }
          story.tags = value.tags;
          const profileHints = value.tags.flatMap(tag => {
            const profile = parseViewportProfileTag(tag);
            return profile === undefined ? [] : [profile];
          });
          if (profileHints.length > 0) story.viewportProfileHint = profileHints[profileHints.length - 1];
        }
        if (value.importPath !== undefined) {
          if (typeof value.importPath !== 'string') {
            throw new Error(`Invalid Storybook index: entries[${JSON.stringify(key)}].importPath must be a string.`);
          }
          story.importPath = value.importPath;
        }

        stories.push(story);
      }

      return stories.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } catch (error) {
      if (timeoutController.signal.aborted && !signal?.aborted) throw timeoutError;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

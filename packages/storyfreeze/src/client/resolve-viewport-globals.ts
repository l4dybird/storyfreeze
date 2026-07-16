import type { ScreenshotOptions, Viewport } from '../shared/types.js';

type ViewportGlobals = {
  value?: string;
  isRotated?: boolean;
};

type ViewportStyles = {
  width?: string | number;
  height?: string | number;
};

/**
 * The subset of Storybook's story context used to resolve viewport globals.
 * Storybook's `storyGlobals`, `defaultViewport`, and legacy `viewports` map are
 * not all part of its currently published types.
 */
export type StoryContextLike = {
  storyGlobals?: { viewport?: ViewportGlobals | string };
  globals?: { viewport?: ViewportGlobals | string };
  parameters?: {
    viewport?: {
      options?: Record<string, { styles?: ViewportStyles | null }>;
      viewports?: Record<string, { styles?: ViewportStyles | null }>;
      defaultViewport?: string;
    };
  };
};

function normalizeViewportGlobals(value: ViewportGlobals | string | undefined): ViewportGlobals | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? { value } : value;
}

function parseDimension(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolves a `Viewport` from Storybook's viewport globals (`globals.viewport`
 * / `storyGlobals.viewport`) and the corresponding `parameters.viewport`
 * definitions registered by Storybook's viewport feature.
 *
 * @param context - Storybook story context which may carry viewport globals
 * @returns The resolved viewport, or `undefined` if it cannot be resolved
 */
export function resolveViewportFromGlobals(context: StoryContextLike): Viewport | undefined {
  const selected = normalizeViewportGlobals(context.storyGlobals?.viewport ?? context.globals?.viewport);
  const viewportParameters = context.parameters?.viewport;
  const name = selected?.value ?? viewportParameters?.defaultViewport;
  if (!name) return undefined;

  const definitions = viewportParameters?.options ?? viewportParameters?.viewports;
  const styles = definitions?.[name]?.styles;
  const width = parseDimension(styles?.width);
  const height = parseDimension(styles?.height);
  if (width === null || height === null) return undefined;

  return selected?.isRotated ? { width: height, height: width } : { width, height };
}

/**
 * Adds a viewport resolved from Storybook globals only when StoryFreeze viewport
 * options are not explicitly configured.
 */
export function applyViewportFromGlobals(
  screenshotOptions: ScreenshotOptions,
  context: StoryContextLike,
): ScreenshotOptions {
  if (screenshotOptions.viewport !== undefined || screenshotOptions.viewports !== undefined) {
    return screenshotOptions;
  }

  const viewport = resolveViewportFromGlobals(context);
  return viewport ? { ...screenshotOptions, viewport } : screenshotOptions;
}

import { createHash } from 'node:crypto';
import type { BrowserDeviceDescriptor } from './browser-backend.js';
import type { RunMode } from './types.js';
import type { StoryDescriptor } from './story-index-provider.js';
import {
  emulationProfileKey,
  normalizeEmulationProfile,
  resolveViewport,
  type EmulationProfile,
} from './emulation-profile.js';
import {
  expandViewportsOption,
  extractVariantKeys,
  mergeScreenshotOptions,
  pickupWithVariantKey,
} from '../shared/screenshot-options-helper.js';
import type { ScreenshotOptions, StrictScreenshotOptions, VariantKey } from '../shared/types.js';

export const STORYFREEZE_MANIFEST_SCHEMA_VERSION = 2 as const;

export type ManifestEligibility = 'static' | 'runtime-validation' | 'runtime-discovery';

/** Serializable, capture-specific options. Variant definitions are expanded into separate captures. */
export interface NormalizedCaptureOptions {
  captureBeyondViewport: boolean;
  click: string;
  clip: { x: number; y: number; width: number; height: number } | null;
  delay: number;
  focus: string;
  fullPage: boolean;
  hover: string;
  omitBackground: boolean;
  skip: boolean;
  viewport: EmulationProfile;
  waitAssets: boolean;
  waitFor?: string;
  waitImages: boolean;
}

export interface ManifestStory {
  storyId: string;
  title: string;
  name: string;
  importPath?: string;
  tags?: string[];
}

export interface ManifestCapture {
  captureId: string;
  storyId: string;
  variantKey: string[];
  profile: EmulationProfile;
  options: NormalizedCaptureOptions;
  planning: {
    estimatedCostMs?: number;
    eligibility: ManifestEligibility;
  };
  isolation: {
    freshDocument: true;
    freshContext: boolean;
  };
}

export interface StoryFreezeManifest {
  schemaVersion: typeof STORYFREEZE_MANIFEST_SCHEMA_VERSION;
  generatedAt: string;
  storybookBuildHash: string;
  warnings: string[];
  stories: ManifestStory[];
  captures: ManifestCapture[];
}

export interface ManifestStoryInput extends StoryDescriptor {
  /** Optional statically supplied Story screenshot parameters. */
  screenshotOptions?: ScreenshotOptions;
  /** Classification to use when screenshotOptions are supplied. */
  eligibility?: Exclude<ManifestEligibility, 'runtime-discovery'>;
}

export interface ManifestGeneratorOptions {
  stories: readonly ManifestStoryInput[];
  baseOptions: StrictScreenshotOptions;
  deviceDescriptors: readonly BrowserDeviceDescriptor[];
  mode: RunMode;
  generatedAt?: string;
  storybookBuildHash?: string;
  freshContext?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function compareDeterministicStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareDeterministicStrings(left, right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function deterministicSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hash(value: unknown): string {
  return createHash('sha256').update(deterministicSerialize(value)).digest('hex');
}

export function createStorybookBuildHash(stories: readonly StoryDescriptor[]): string {
  return hash(
    [...stories]
      .sort((left, right) => compareDeterministicStrings(left.id, right.id))
      .map(({ id, title, name, importPath, tags }) => ({
        id,
        title,
        name,
        ...(importPath === undefined ? {} : { importPath }),
        ...(tags === undefined ? {} : { tags: [...tags].sort(compareDeterministicStrings) }),
      })),
  );
}

export function createCaptureId(storyId: string, variantKey: readonly string[]): string {
  const variant =
    variantKey.length === 0 ? 'root:' : `variant:${variantKey.map(key => encodeURIComponent(key)).join('/')}`;
  return `${encodeURIComponent(storyId)}::${variant}`;
}

function containsRuntimeValue(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return true;
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.values(value).some(child => containsRuntimeValue(child, seen));
}

export function normalizeCaptureOptions(
  options: ScreenshotOptions,
  deviceDescriptors: readonly BrowserDeviceDescriptor[],
): NormalizedCaptureOptions | undefined {
  const viewport = resolveViewport(options.viewport as StrictScreenshotOptions['viewport'], deviceDescriptors);
  if (!viewport) return undefined;
  const waitFor = typeof options.waitFor === 'string' && options.waitFor ? options.waitFor : undefined;
  return {
    captureBeyondViewport: options.captureBeyondViewport ?? true,
    click: options.click ?? '',
    clip: options.clip ?? null,
    delay: options.delay ?? 0,
    focus: options.focus ?? '',
    fullPage: options.fullPage ?? true,
    hover: options.hover ?? '',
    omitBackground: options.omitBackground ?? false,
    skip: options.skip ?? false,
    viewport: normalizeEmulationProfile(viewport),
    waitAssets: options.waitAssets ?? options.waitImages ?? true,
    ...(waitFor === undefined ? {} : { waitFor }),
    waitImages: options.waitImages ?? false,
  };
}

export function estimateCaptureCostMs(options: NormalizedCaptureOptions): number {
  const pixels = options.viewport.width * options.viewport.height * options.viewport.deviceScaleFactor ** 2;
  const pixelCost = Math.min(500, Math.round(pixels / 25_000));
  const interactionCost = options.hover || options.focus || options.click ? 75 : 0;
  const fullPageCost = options.fullPage ? 100 : 0;
  return 400 + Math.max(0, options.delay) + pixelCost + interactionCost + fullPageCost;
}

function variantInputs(options: ScreenshotOptions) {
  const [invalid, variants] = extractVariantKeys(options);
  return {
    invalid,
    variants: invalid ? [{ isDefault: true, keys: [] }] : [{ isDefault: true, keys: [] }, ...variants],
  };
}

function classifyCapture(
  story: ManifestStoryInput,
  variantKey: VariantKey,
  mode: RunMode,
  hasRuntimeValue: boolean,
): ManifestEligibility {
  if (mode === 'simple') return 'static';
  if (!story.screenshotOptions) return variantKey.isDefault ? 'runtime-discovery' : 'runtime-validation';
  if (hasRuntimeValue) return 'runtime-discovery';
  return story.eligibility ?? 'runtime-validation';
}

export function generateCaptureManifest(options: ManifestGeneratorOptions): StoryFreezeManifest {
  const base = options.baseOptions;
  const sortedStoryInputs = [...options.stories].sort((left, right) => compareDeterministicStrings(left.id, right.id));
  const stories = sortedStoryInputs.map(({ id, title, name, importPath, tags }) => ({
    storyId: id,
    title,
    name,
    ...(importPath === undefined ? {} : { importPath }),
    ...(tags === undefined ? {} : { tags: [...tags].sort(compareDeterministicStrings) }),
  }));
  const captures: ManifestCapture[] = [];
  const warnings: string[] = [];

  for (const story of sortedStoryInputs) {
    const storyOptions = story.screenshotOptions ? expandViewportsOption(story.screenshotOptions) : {};
    const merged = mergeScreenshotOptions(base, storyOptions);
    const hasRuntimeValue = containsRuntimeValue(story.screenshotOptions);

    const variantInput = variantInputs(merged);
    if (variantInput.invalid) {
      warnings.push(`Story ${story.id} has an invalid variant graph: ${deterministicSerialize(variantInput.invalid)}.`);
    }
    for (const variantKey of variantInput.variants) {
      const selected = pickupWithVariantKey(merged, variantKey);
      const resolved = normalizeCaptureOptions(selected, options.deviceDescriptors);
      // Preserve the legacy runtime warning/skip path for an unknown device name.
      const normalized =
        resolved ??
        normalizeCaptureOptions({ ...selected, viewport: { width: 800, height: 600 } }, options.deviceDescriptors)!;
      captures.push({
        captureId: createCaptureId(story.id, variantKey.keys),
        storyId: story.id,
        variantKey: [...variantKey.keys],
        profile: { ...normalized.viewport },
        options: normalized,
        planning: {
          eligibility: resolved
            ? classifyCapture(story, variantKey, options.mode, hasRuntimeValue)
            : 'runtime-discovery',
          estimatedCostMs: estimateCaptureCostMs(normalized),
        },
        isolation: { freshDocument: true, freshContext: options.freshContext ?? false },
      });
    }
  }

  const manifest: StoryFreezeManifest = {
    schemaVersion: STORYFREEZE_MANIFEST_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    storybookBuildHash: options.storybookBuildHash ?? createStorybookBuildHash(options.stories),
    warnings,
    stories,
    captures: captures.sort((left, right) => compareDeterministicStrings(left.captureId, right.captureId)),
  };
  return manifest;
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string.`);
}

function validateProfile(value: unknown, path: string): asserts value is EmulationProfile {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  for (const field of ['width', 'height', 'deviceScaleFactor'] as const) {
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] <= 0) {
      throw new Error(`${path}.${field} must be a positive finite number.`);
    }
  }
  for (const field of ['isMobile', 'hasTouch', 'isLandscape'] as const) {
    if (typeof value[field] !== 'boolean') throw new Error(`${path}.${field} must be a boolean.`);
  }
}

export function validateCaptureManifest(value: unknown): asserts value is StoryFreezeManifest {
  if (!isRecord(value)) throw new Error('Manifest must be an object.');
  if (value.schemaVersion !== STORYFREEZE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported StoryFreeze manifest schema version: ${String(value.schemaVersion)}.`);
  }
  assertString(value.generatedAt, 'manifest.generatedAt');
  if (Number.isNaN(Date.parse(value.generatedAt))) throw new Error('manifest.generatedAt must be an ISO date string.');
  assertString(value.storybookBuildHash, 'manifest.storybookBuildHash');
  if (!Array.isArray(value.stories)) throw new Error('manifest.stories must be an array.');
  if (!Array.isArray(value.captures)) throw new Error('manifest.captures must be an array.');
  if (!Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')) {
    throw new Error('manifest.warnings must be an array of strings.');
  }

  const storyIds = new Set<string>();
  value.stories.forEach((raw, index) => {
    if (!isRecord(raw)) throw new Error(`manifest.stories[${index}] must be an object.`);
    assertString(raw.storyId, `manifest.stories[${index}].storyId`);
    assertString(raw.title, `manifest.stories[${index}].title`);
    assertString(raw.name, `manifest.stories[${index}].name`);
    if (storyIds.has(raw.storyId)) throw new Error(`Duplicate manifest story id: ${raw.storyId}.`);
    storyIds.add(raw.storyId);
  });

  const captureIds = new Set<string>();
  value.captures.forEach((raw, index) => {
    if (!isRecord(raw)) throw new Error(`manifest.captures[${index}] must be an object.`);
    assertString(raw.captureId, `manifest.captures[${index}].captureId`);
    assertString(raw.storyId, `manifest.captures[${index}].storyId`);
    if (!storyIds.has(raw.storyId)) throw new Error(`Capture ${raw.captureId} refers to an unknown story.`);
    if (captureIds.has(raw.captureId)) throw new Error(`Duplicate manifest capture id: ${raw.captureId}.`);
    captureIds.add(raw.captureId);
    if (!Array.isArray(raw.variantKey) || !raw.variantKey.every(key => typeof key === 'string')) {
      throw new Error(`manifest.captures[${index}].variantKey must be an array of strings.`);
    }
    validateProfile(raw.profile, `manifest.captures[${index}].profile`);
    if (
      !isRecord(raw.planning) ||
      !['static', 'runtime-validation', 'runtime-discovery'].includes(String(raw.planning.eligibility))
    ) {
      throw new Error(`manifest.captures[${index}].planning.eligibility is invalid.`);
    }
    if (!isRecord(raw.isolation) || raw.isolation.freshDocument !== true) {
      throw new Error(`manifest.captures[${index}].isolation.freshDocument must be true.`);
    }
    if (typeof raw.isolation.freshContext !== 'boolean') {
      throw new Error(`manifest.captures[${index}].isolation.freshContext must be a boolean.`);
    }
    if (!isRecord(raw.options)) throw new Error(`manifest.captures[${index}].options must be an object.`);
    validateProfile(raw.options.viewport, `manifest.captures[${index}].options.viewport`);
    if (emulationProfileKey(raw.profile) !== emulationProfileKey(raw.options.viewport as EmulationProfile)) {
      throw new Error(`manifest.captures[${index}] profile and options.viewport must match.`);
    }
  });
}

export function serializeCaptureManifest(manifest: StoryFreezeManifest): string {
  validateCaptureManifest(manifest);
  return `${deterministicSerialize(manifest)}\n`;
}

export function parseCaptureManifest(source: string): StoryFreezeManifest {
  const value: unknown = JSON.parse(source);
  validateCaptureManifest(value);
  return value;
}

export type { EmulationProfile } from './emulation-profile.js';

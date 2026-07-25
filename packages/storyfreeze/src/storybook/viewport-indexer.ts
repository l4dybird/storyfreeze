import { readFile } from 'node:fs/promises';
import * as storybookCommon from 'storybook/internal/common';
import { loadCsf } from 'storybook/internal/csf-tools';
import { types } from 'storybook/internal/babel';
import type { IndexInput, Indexer, IndexerOptions } from 'storybook/internal/types';
import { createViewportProfileTag } from '../shared/viewport-profile-tag.js';
import { createStoryCostTag, STORYFREEZE_DEFAULT_STORY_COST_MS } from '../shared/story-cost-tag.js';

type StaticResolution = { kind: 'found'; node: types.Node } | { kind: 'absent' } | { kind: 'unknown' };
type ProfileResolution = { kind: 'found'; profileKey: string } | { kind: 'absent' } | { kind: 'unknown' };

const absent = { kind: 'absent' } as const;
const unknown = { kind: 'unknown' } as const;

// Storybook 10.0-10.4 do not export STORY_FILE_TEST_REGEXP. Keep this as a
// namespace import so those versions can load the preset, and mirror the
// matcher introduced by Storybook 10.5.0 when the export is unavailable.
const STORYBOOK_10_5_STORY_FILE_TEST_REGEXP = /(stories|story)\.(m?js|ts)x?$/;

export function resolveStoryFileTestRegexp(
  common: { readonly STORY_FILE_TEST_REGEXP?: RegExp } = storybookCommon,
): RegExp {
  return common.STORY_FILE_TEST_REGEXP ?? STORYBOOK_10_5_STORY_FILE_TEST_REGEXP;
}

function unwrap(node: types.Node | null | undefined): types.Node | undefined {
  let current = node ?? undefined;
  while (
    current &&
    (types.isTSAsExpression(current) ||
      types.isTSSatisfiesExpression(current) ||
      types.isTSNonNullExpression(current) ||
      types.isTypeCastExpression(current) ||
      types.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(property: types.ObjectProperty | types.ObjectMethod): string | undefined {
  if (!property.computed && types.isIdentifier(property.key)) return property.key.name;
  if (types.isStringLiteral(property.key)) return property.key.value;
  return undefined;
}

function resolveProperty(
  node: types.Node | null | undefined,
  key: string,
  bindings: Map<string, types.Node | null | undefined>,
  seen: Set<types.Node>,
): StaticResolution {
  const unwrapped = unwrap(node);
  if (!unwrapped || seen.has(unwrapped)) return unknown;
  seen.add(unwrapped);

  if (types.isIdentifier(unwrapped)) {
    if (!bindings.has(unwrapped.name)) return unknown;
    return resolveProperty(bindings.get(unwrapped.name), key, bindings, seen);
  }

  if (types.isCallExpression(unwrapped)) {
    const firstArgument = unwrapped.arguments[0];
    if (
      types.isMemberExpression(unwrapped.callee) &&
      !unwrapped.callee.computed &&
      types.isIdentifier(unwrapped.callee.property) &&
      (unwrapped.callee.property.name === 'story' || unwrapped.callee.property.name === 'extend') &&
      firstArgument &&
      !types.isSpreadElement(firstArgument) &&
      !types.isArgumentPlaceholder(firstArgument) &&
      !types.isJSXNamespacedName(firstArgument)
    ) {
      return resolveProperty(firstArgument, key, bindings, seen);
    }
    return unknown;
  }

  if (!types.isObjectExpression(unwrapped)) return unknown;
  for (let index = unwrapped.properties.length - 1; index >= 0; index -= 1) {
    const property = unwrapped.properties[index];
    if (types.isSpreadElement(property)) {
      const spread = resolveProperty(property.argument, key, bindings, new Set(seen));
      if (spread.kind !== 'absent') return spread;
      continue;
    }
    if (!types.isObjectProperty(property) && !types.isObjectMethod(property)) continue;
    if (propertyName(property) !== key) continue;
    return types.isObjectProperty(property) ? { kind: 'found', node: property.value } : unknown;
  }
  return absent;
}

function collectBindings(program: types.Program): Map<string, types.Node | null | undefined> {
  const bindings = new Map<string, types.Node | null | undefined>();
  const collectDeclaration = (declaration: types.Declaration | null | undefined) => {
    if (!declaration || !types.isVariableDeclaration(declaration)) return;
    for (const declarator of declaration.declarations) {
      if (types.isIdentifier(declarator.id)) bindings.set(declarator.id.name, declarator.init);
    }
  };
  for (const statement of program.body) {
    if (types.isVariableDeclaration(statement)) collectDeclaration(statement);
    if (types.isExportNamedDeclaration(statement)) collectDeclaration(statement.declaration);
    if (
      types.isExportDefaultDeclaration(statement) &&
      types.isIdentifier(statement.declaration) &&
      !bindings.has('default')
    ) {
      bindings.set('default', bindings.get(statement.declaration.name));
    }
  }
  return bindings;
}

function literalString(resolution: StaticResolution): string | undefined {
  if (resolution.kind !== 'found') return undefined;
  const node = unwrap(resolution.node);
  if (types.isStringLiteral(node)) return node.value || undefined;
  if (types.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked || undefined;
  }
  return undefined;
}

function literalNumber(resolution: StaticResolution): number | undefined {
  if (resolution.kind !== 'found') return undefined;
  const node = unwrap(resolution.node);
  if (types.isNumericLiteral(node)) return node.value;
  // `-1` and friends arrive as a unary expression rather than a literal.
  if (types.isUnaryExpression(node) && node.operator === '-' && types.isNumericLiteral(unwrap(node.argument))) {
    return -(unwrap(node.argument) as types.NumericLiteral).value;
  }
  return undefined;
}

function literalBoolean(resolution: StaticResolution): boolean | undefined {
  if (resolution.kind !== 'found') return undefined;
  const node = unwrap(resolution.node);
  return types.isBooleanLiteral(node) ? node.value : undefined;
}

/**
 * Ordered, statically known keys of an object or entries of an array. Returns
 * undefined when the shape cannot be read statically (a spread, a computed key,
 * an identifier that is not a local literal), so callers can fall back rather
 * than emit a hint built from a partial answer.
 */
function literalKeys(
  resolution: StaticResolution,
  bindings: Map<string, types.Node | null | undefined>,
): string[] | undefined {
  if (resolution.kind !== 'found') return undefined;
  let node = unwrap(resolution.node);
  if (node && types.isIdentifier(node) && bindings.has(node.name)) node = unwrap(bindings.get(node.name));
  if (node && types.isArrayExpression(node)) {
    const names: string[] = [];
    for (const element of node.elements) {
      const value = unwrap(element ?? undefined);
      if (!value || !types.isStringLiteral(value)) return undefined;
      names.push(value.value);
    }
    return names;
  }
  if (!node || !types.isObjectExpression(node)) return undefined;
  const names: string[] = [];
  for (const property of node.properties) {
    if (types.isSpreadElement(property)) return undefined;
    if (!types.isObjectProperty(property) && !types.isObjectMethod(property)) return undefined;
    const name = propertyName(property);
    if (name === undefined) return undefined;
    names.push(name);
  }
  return names;
}

type MergedResolution = { kind: 'found'; nodes: types.Node[] } | { kind: 'absent' } | { kind: 'unknown' };

function resolveLocalValue(
  node: types.Node | null | undefined,
  bindings: Map<string, types.Node | null | undefined>,
  seen = new Set<types.Node>(),
): types.Node | undefined {
  const unwrapped = unwrap(node);
  if (!unwrapped || seen.has(unwrapped)) return undefined;
  seen.add(unwrapped);
  if (types.isIdentifier(unwrapped)) {
    return bindings.has(unwrapped.name) ? resolveLocalValue(bindings.get(unwrapped.name), bindings, seen) : undefined;
  }
  if (types.isCallExpression(unwrapped)) {
    const firstArgument = unwrapped.arguments[0];
    if (
      types.isMemberExpression(unwrapped.callee) &&
      !unwrapped.callee.computed &&
      types.isIdentifier(unwrapped.callee.property) &&
      (unwrapped.callee.property.name === 'story' || unwrapped.callee.property.name === 'extend') &&
      firstArgument &&
      !types.isSpreadElement(firstArgument) &&
      !types.isArgumentPlaceholder(firstArgument) &&
      !types.isJSXNamespacedName(firstArgument)
    ) {
      return resolveLocalValue(firstArgument, bindings, seen);
    }
    return undefined;
  }
  return unwrapped;
}

function toMergedResolution(
  resolution: StaticResolution,
  bindings: Map<string, types.Node | null | undefined>,
): MergedResolution {
  if (resolution.kind !== 'found') return resolution;
  const node = resolveLocalValue(resolution.node, bindings);
  return node ? { kind: 'found', nodes: [node] } : unknown;
}

function mergedValueKind(value: Extract<MergedResolution, { kind: 'found' }>) {
  if (value.nodes.every(node => types.isObjectExpression(node))) return 'object';
  if (value.nodes.length === 1 && types.isArrayExpression(value.nodes[0])) return 'array';
  return value.nodes.length === 1 ? 'other' : 'unknown';
}

/**
 * Mirrors Storybook's combineParameters rule for one value: plain objects are
 * recursively merged, while arrays and scalar values from the story replace
 * the meta value.
 */
function mergeStaticValues(base: MergedResolution, override: MergedResolution): MergedResolution {
  if (override.kind === 'absent') return base;
  if (override.kind === 'unknown') return unknown;
  const overrideKind = mergedValueKind(override);
  if (overrideKind === 'array' || overrideKind === 'other') return override;
  if (overrideKind !== 'object') return unknown;
  if (base.kind === 'absent') return override;
  if (base.kind === 'unknown') return unknown;
  return mergedValueKind(base) === 'object' ? { kind: 'found', nodes: [...base.nodes, ...override.nodes] } : override;
}

function mergedProperty(
  object: MergedResolution,
  key: string,
  bindings: Map<string, types.Node | null | undefined>,
): MergedResolution {
  if (object.kind !== 'found') return object;
  if (mergedValueKind(object) !== 'object') return unknown;
  let result: MergedResolution = absent;
  for (const node of object.nodes) {
    result = mergeStaticValues(result, toMergedResolution(resolveProperty(node, key, bindings, new Set()), bindings));
  }
  return result;
}

function singleStaticResolution(value: MergedResolution): StaticResolution {
  if (value.kind !== 'found') return value;
  return value.nodes.length === 1 ? { kind: 'found', node: value.nodes[0] } : unknown;
}

function mergedLiteralString(value: MergedResolution) {
  return literalString(singleStaticResolution(value));
}

function mergedLiteralNumber(value: MergedResolution) {
  return literalNumber(singleStaticResolution(value));
}

function mergedLiteralBoolean(value: MergedResolution) {
  return literalBoolean(singleStaticResolution(value));
}

function mergedLiteralKeys(
  value: MergedResolution,
  bindings: Map<string, types.Node | null | undefined>,
): string[] | undefined {
  if (value.kind !== 'found') return undefined;
  if (mergedValueKind(value) === 'array') {
    return literalKeys({ kind: 'found', node: value.nodes[0] }, bindings);
  }
  if (mergedValueKind(value) !== 'object') return undefined;
  const names = new Set<string>();
  for (const node of value.nodes) {
    const layer = literalKeys({ kind: 'found', node }, bindings);
    if (!layer) return undefined;
    for (const name of layer) names.add(name);
  }
  return [...names];
}

/**
 * Stable profile key for an inline viewport object.
 *
 * The field order is fixed so two stories that describe the same emulation
 * produce the same key. deviceScaleFactor, isMobile and hasTouch matter most:
 * `sameEmulationClass` treats a change in any of them as a browser-context
 * boundary, so grouping by them is what avoids context recreation.
 */
function viewportObjectKey(
  viewport: MergedResolution,
  bindings: Map<string, types.Node | null | undefined>,
): string | undefined {
  const read = (key: string) => mergedProperty(viewport, key, bindings);
  const width = mergedLiteralNumber(read('width'));
  const height = mergedLiteralNumber(read('height'));
  if (width === undefined || height === undefined) return undefined;
  const scaleResolution = read('deviceScaleFactor');
  const mobileResolution = read('isMobile');
  const touchResolution = read('hasTouch');
  const landscapeResolution = read('isLandscape');
  const scale = scaleResolution.kind === 'absent' ? 1 : mergedLiteralNumber(scaleResolution);
  const mobile = mobileResolution.kind === 'absent' ? false : mergedLiteralBoolean(mobileResolution);
  const touch = touchResolution.kind === 'absent' ? false : mergedLiteralBoolean(touchResolution);
  const landscape = landscapeResolution.kind === 'absent' ? undefined : mergedLiteralBoolean(landscapeResolution);
  // Defaults are safe only when a property is absent. A present but dynamic
  // value determines the runtime emulation class, so guessing here would group
  // unrelated browser contexts under the same hint.
  if (
    scale === undefined ||
    mobile === undefined ||
    touch === undefined ||
    (landscapeResolution.kind !== 'absent' && landscape === undefined)
  ) {
    return undefined;
  }
  // `auto` records that the orientation is derived from the dimensions at run
  // time. It can differ from an explicit value that resolves the same way, which
  // only costs grouping precision.
  const orientation = landscape === undefined ? 'auto' : landscape ? 'landscape' : 'portrait';
  return `obj:${width}x${height}@${scale}:m${mobile ? 1 : 0}:t${touch ? 1 : 0}:o${orientation}`;
}

function viewportProfileFromObject(
  object: types.Node | null | undefined,
  bindings: Map<string, types.Node | null | undefined>,
): ProfileResolution {
  const globals = resolveProperty(object, 'globals', bindings, new Set());
  if (globals.kind !== 'found') return globals;
  const viewport = resolveProperty(globals.node, 'viewport', bindings, new Set());
  const direct = literalString(viewport);
  if (direct) return { kind: 'found', profileKey: direct };
  if (viewport.kind !== 'found') return viewport;
  const value = literalString(resolveProperty(viewport.node, 'value', bindings, new Set()));
  return value ? { kind: 'found', profileKey: value } : unknown;
}

function screenshotOptions(
  object: types.Node | null | undefined,
  bindings: Map<string, types.Node | null | undefined>,
): StaticResolution {
  const parameters = resolveProperty(object, 'parameters', bindings, new Set());
  if (parameters.kind !== 'found') return parameters;
  return resolveProperty(parameters.node, 'screenshot', bindings, new Set());
}

function mergedScreenshotOptions(
  meta: types.Node | null | undefined,
  story: types.Node | null | undefined,
  bindings: Map<string, types.Node | null | undefined>,
) {
  return mergeStaticValues(
    toMergedResolution(screenshotOptions(meta, bindings), bindings),
    toMergedResolution(screenshotOptions(story, bindings), bindings),
  );
}

/**
 * Viewport hint from StoryFreeze's own options.
 *
 * This is the configuration StoryFreeze users actually write, and it previously
 * produced no hint at all, so multi-viewport stories were never grouped. The
 * runtime treats the first entry of `viewports` as the root viewport
 * (`expandViewportsOption`), and that is the entry mirrored here.
 */
function viewportProfileFromScreenshot(
  screenshot: MergedResolution,
  bindings: Map<string, types.Node | null | undefined>,
): ProfileResolution {
  const viewports = mergedProperty(screenshot, 'viewports', bindings);
  if (viewports.kind === 'found') {
    const names = mergedLiteralKeys(viewports, bindings);
    if (!names || names.length === 0) return unknown;
    const first = names[0];
    // An array of names refers to registered viewports by name; an object maps
    // each name to its own definition.
    if (mergedValueKind(viewports) === 'array') return { kind: 'found', profileKey: first };
    const entry = mergedProperty(viewports, first, bindings);
    const named = mergedLiteralString(entry);
    if (named) return { kind: 'found', profileKey: named };
    const key = viewportObjectKey(entry, bindings);
    return key ? { kind: 'found', profileKey: key } : unknown;
  }
  if (viewports.kind === 'unknown') return unknown;

  const viewport = mergedProperty(screenshot, 'viewport', bindings);
  if (viewport.kind !== 'found') return viewport;
  const named = mergedLiteralString(viewport);
  if (named) return { kind: 'found', profileKey: named };
  const key = viewportObjectKey(viewport, bindings);
  return key ? { kind: 'found', profileKey: key } : unknown;
}

function resolveViewportProfile(
  meta: types.Node | null | undefined,
  story: types.Node | null | undefined,
  screenshot: MergedResolution,
  bindings: Map<string, types.Node | null | undefined>,
): ProfileResolution {
  // StoryFreeze options win: applyViewportFromGlobals only consults Storybook
  // globals when neither viewport nor viewports is set.
  const fromScreenshot = viewportProfileFromScreenshot(screenshot, bindings);
  if (fromScreenshot.kind !== 'absent') return fromScreenshot;
  const fromStoryGlobals = viewportProfileFromObject(story, bindings);
  return fromStoryGlobals.kind === 'absent' ? viewportProfileFromObject(meta, bindings) : fromStoryGlobals;
}

type CostFacts = {
  delayMs?: number;
  variantNames?: string[];
  viewportNames?: string[];
};

function costFacts(screenshot: MergedResolution, bindings: Map<string, types.Node | null | undefined>): CostFacts {
  if (screenshot.kind !== 'found') return {};
  const delay = mergedLiteralNumber(mergedProperty(screenshot, 'delay', bindings));
  const variants = mergedLiteralKeys(mergedProperty(screenshot, 'variants', bindings), bindings);
  const viewports = mergedLiteralKeys(mergedProperty(screenshot, 'viewports', bindings), bindings);
  return {
    ...(delay !== undefined && delay >= 0 ? { delayMs: delay } : {}),
    ...(variants ? { variantNames: variants } : {}),
    ...(viewports ? { viewportNames: viewports } : {}),
  };
}

/**
 * Estimated wall cost of every capture a story expands into.
 *
 * A story becomes one capture per variant plus one for the root, and each of
 * those pays the configured delay again, hence the multiplier. `viewports` is
 * folded into `variants` at run time by `expandViewportsOption`, so same-named
 * entries are counted once.
 *
 * This is an estimate, not a measurement: variant-specific delay overrides are
 * ignored, and play-function time cannot be known statically.
 */
function estimateStoryCostMs(facts: CostFacts): number {
  const extraKeys = new Set<string>([...(facts.variantNames ?? []), ...(facts.viewportNames ?? []).slice(1)]);
  return (1 + extraKeys.size) * (STORYFREEZE_DEFAULT_STORY_COST_MS + (facts.delayMs ?? 0));
}

export function addViewportProfileTags(code: string, fileName: string, options: IndexerOptions): IndexInput[] {
  const csf = loadCsf(code, { ...options, fileName }).parse();
  const bindings = collectBindings(csf._ast.program);

  return csf.indexInputs.map(input => {
    if (input.type !== 'story' || input.subtype === 'test') return input;
    const storyDeclaration = csf._storyExports[input.exportName];
    const storyObject = types.isVariableDeclarator(storyDeclaration) ? storyDeclaration.init : storyDeclaration;
    const screenshot = mergedScreenshotOptions(csf._metaNode, storyObject, bindings);
    const profile = resolveViewportProfile(csf._metaNode, storyObject, screenshot, bindings);
    const cost = estimateStoryCostMs(costFacts(screenshot, bindings));
    const tags = [
      ...(input.tags ?? []),
      ...(profile.kind === 'found' ? [createViewportProfileTag(profile.profileKey)] : []),
      createStoryCostTag(cost),
    ];
    return { ...input, tags };
  });
}

export const storyfreezeViewportIndexer: Indexer = {
  test: resolveStoryFileTestRegexp(),
  async createIndex(fileName, options) {
    const code = await readFile(fileName, 'utf8');
    if (!code.trim()) return [];
    return addViewportProfileTags(code, fileName, options);
  },
};

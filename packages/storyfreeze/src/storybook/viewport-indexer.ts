import { readFile } from 'node:fs/promises';
import { STORY_FILE_TEST_REGEXP } from 'storybook/internal/common';
import { loadCsf } from 'storybook/internal/csf-tools';
import { types } from 'storybook/internal/babel';
import type { IndexInput, Indexer, IndexerOptions } from 'storybook/internal/types';
import { createViewportProfileTag } from '../shared/viewport-profile-tag.js';

type StaticResolution = { kind: 'found'; node: types.Node } | { kind: 'absent' } | { kind: 'unknown' };
type ProfileResolution = { kind: 'found'; profileKey: string } | { kind: 'absent' } | { kind: 'unknown' };

const absent = { kind: 'absent' } as const;
const unknown = { kind: 'unknown' } as const;

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

export function addViewportProfileTags(code: string, fileName: string, options: IndexerOptions): IndexInput[] {
  const csf = loadCsf(code, { ...options, fileName }).parse();
  const bindings = collectBindings(csf._ast.program);
  const metaProfile = viewportProfileFromObject(csf._metaNode, bindings);

  return csf.indexInputs.map(input => {
    if (input.type !== 'story' || input.subtype === 'test') return input;
    const storyDeclaration = csf._storyExports[input.exportName];
    const storyObject = types.isVariableDeclarator(storyDeclaration) ? storyDeclaration.init : storyDeclaration;
    const storyProfile = viewportProfileFromObject(storyObject, bindings);
    const profile = storyProfile.kind === 'absent' ? metaProfile : storyProfile;
    if (profile.kind !== 'found') return input;
    return { ...input, tags: [...(input.tags ?? []), createViewportProfileTag(profile.profileKey)] };
  });
}

export const storyfreezeViewportIndexer: Indexer = {
  test: STORY_FILE_TEST_REGEXP,
  async createIndex(fileName, options) {
    const code = await readFile(fileName, 'utf8');
    if (!code.trim()) return [];
    return addViewportProfileTags(code, fileName, options);
  },
};

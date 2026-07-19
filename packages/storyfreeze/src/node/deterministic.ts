export function compareDeterministicStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

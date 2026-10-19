/** Data that can cross `postMessage`: functions and other uncloneable values are left out. */
export function plain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === 'function') continue;
    out[key] = plain(inner);
  }
  return out;
}

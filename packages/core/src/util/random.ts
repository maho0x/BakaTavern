/** Deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export function pickOne<T>(items: readonly T[], rng: Rng = Math.random): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}

/**
 * Evaluates a dice formula such as `1d20`, `3d6+4`, `2d10-1` or a plain number (treated as `1dN`).
 * Returns `null` for invalid formulas.
 */
export function rollDice(formula: string, rng: Rng = Math.random): number | null {
  const text = formula.replace(/\s+/g, '').toLowerCase();
  if (/^\d+$/.test(text)) return rollDice(`1d${text}`, rng);
  const m = /^(\d*)d(\d+)([+-]\d+)?$/.exec(text);
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  const modifier = m[3] ? Number(m[3]) : 0;
  if (count < 1 || count > 1000 || sides < 1) return null;
  let total = modifier;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(rng() * sides);
  return total;
}

import type { VariableScope } from './env.ts';
import { isFalseBoolean } from '../util/text.ts';

/** Stringifies a variable value the way macros print it. */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isFalsyValue(value: unknown): boolean {
  return !value || isFalseBoolean(stringifyValue(value));
}

/**
 * SillyTavern `addvar` semantics: appends to JSON arrays, adds numbers, otherwise concatenates
 * strings. Returns the new value.
 */
export function addVariable(scope: VariableScope, name: string, value: unknown): unknown {
  const current = scope.get(name) || 0;
  if (typeof current === 'string') {
    try {
      const parsed: unknown = JSON.parse(current);
      if (Array.isArray(parsed)) {
        parsed.push(value);
        scope.set(name, JSON.stringify(parsed));
        return parsed;
      }
    } catch {
      // not an array
    }
  } else if (Array.isArray(current)) {
    const next = [...current, value];
    scope.set(name, next);
    return next;
  }
  const increment = Number(value);
  if (Number.isNaN(increment) || Number.isNaN(Number(current))) {
    const text = stringifyValue(current || '') + stringifyValue(value);
    scope.set(name, text);
    return text;
  }
  const next = Number(current) + increment;
  if (Number.isNaN(next)) return '';
  scope.set(name, next);
  return next;
}

/** Reads `name`, or `name.key`/`name[0]` paths into JSON values (Macros 2.0 element access). */
export function readVariablePath(scope: VariableScope, path: string): unknown {
  const m = /^([^.[]+)(.*)$/.exec(path);
  if (!m) return undefined;
  let value: unknown = scope.get(m[1]!);
  const rest = m[2]!;
  if (!rest) return value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  for (const part of rest.matchAll(/\.([^.[\]]+)|\[(\d+|"[^"]*"|'[^']*')]/g)) {
    const key = part[1] ?? part[2]!.replace(/^["']|["']$/g, '');
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

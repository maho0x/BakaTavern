/**
 * Chat and global variables as STscript commands use them (SillyTavern `variables.js`): numeric
 * text reads as a number, `index=` reaches into JSON lists and objects.
 */

import type { VariableScope } from '../macros/env.ts';
import { isFalseBoolean, isTrueBoolean } from '../util/text.ts';
import { Closure, convertValueType, readValue, type Scope } from './closure.ts';

export interface IndexArgs {
  key?: unknown;
  index?: unknown;
  as?: unknown;
}

export function existsVariable(store: VariableScope, name: string): boolean {
  return store.has(name) && store.get(name) !== undefined;
}

export function getVariable(store: VariableScope, name: string, args: IndexArgs = {}): unknown {
  let value: unknown = store.get(String(args.key ?? name));
  if (args.index !== undefined) {
    try {
      const parsed: unknown = JSON.parse(value as string);
      const numIndex = Number(args.index);
      value = (parsed as Record<string, unknown>)[Number.isNaN(numIndex) ? String(args.index) : numIndex];
      if (typeof value === 'object' && value !== null) value = JSON.stringify(value);
    } catch {
      // not JSON: the whole value
    }
  }
  return readValue(value);
}

export function setVariable(
  store: VariableScope,
  name: string,
  value: unknown,
  args: IndexArgs = {},
): unknown {
  if (!name) throw new Error('Variable name cannot be empty or undefined.');
  if (args.index !== undefined) {
    try {
      let current = JSON.parse((store.get(name) as string | undefined) ?? 'null') as Record<
        string | number,
        unknown
      > | null;
      const numIndex = Number(args.index);
      if (Number.isNaN(numIndex)) {
        current ??= {};
        current[String(args.index)] = convertValueType(value, args.as);
      } else {
        current ??= [] as unknown as Record<number, unknown>;
        current[numIndex] = convertValueType(value, args.as);
      }
      store.set(name, JSON.stringify(current));
    } catch {
      // not JSON: left as it was
    }
  } else {
    store.set(name, value);
  }
  return value;
}

/** Appends to a JSON list, adds to a number, or appends text (SillyTavern `addLocalVariable`). */
export function addToVariable(store: VariableScope, name: string, value: unknown): unknown {
  const current = getVariable(store, name) || 0;
  try {
    const parsed: unknown = JSON.parse(current as string);
    if (Array.isArray(parsed)) {
      parsed.push(value);
      setVariable(store, name, JSON.stringify(parsed));
      return parsed;
    }
  } catch {
    // not a list
  }
  const increment = Number(value);
  if (Number.isNaN(increment) || Number.isNaN(Number(current))) {
    const text = String(current || '') + String(value);
    setVariable(store, name, text);
    return text;
  }
  const next = Number(current) + increment;
  if (Number.isNaN(next)) return '';
  setVariable(store, name, next);
  return next;
}

export function deleteVariable(store: VariableScope, name: string): string {
  if (existsVariable(store, name)) store.delete(name);
  return '';
}

/** The stores a script reads: its own scope, then the chat's, then the global ones. */
export interface VariableStores {
  local: VariableScope;
  global: VariableScope;
}

/** A variable's value, or the name itself when no such variable exists (`resolveVariable`). */
export function resolveVariable(name: string, scope: Scope | null, stores: VariableStores): unknown {
  if (scope?.existsVariable(name)) return scope.getVariable(name);
  if (existsVariable(stores.local, name)) return getVariable(stores.local, name);
  if (existsVariable(stores.global, name)) return getVariable(stores.global, name);
  return name;
}

/** Left and right operands of `/if` and `/while` (`parseBooleanOperands`). */
export function booleanOperands(
  args: Record<string, unknown> & { _scope: Scope },
  stores: VariableStores,
): { a: unknown; b: unknown; rule: string | undefined } {
  const operand = (value: unknown): unknown => {
    if (value === undefined) return undefined;
    if (value === '') return '';
    const number = typeof value === 'string' && value.trim().length ? Number(value) : Number.NaN;
    if (!Number.isNaN(number)) return number;
    const name = value as string;
    if (args._scope.existsVariable(name)) return args._scope.getVariable(name) ?? '';
    if (existsVariable(stores.local, name)) return getVariable(stores.local, name) ?? '';
    if (existsVariable(stores.global, name)) return getVariable(stores.global, name) ?? '';
    return String(value) || '';
  };
  return {
    a: operand(args.a ?? args.left ?? args.first ?? args.x),
    b: operand(args.b ?? args.right ?? args.second ?? args.y),
    rule: args.rule as string | undefined,
  };
}

/** SillyTavern `evalBoolean`: comparisons for `/if` and `/while`. */
export function evalBoolean(rule: string | undefined, a: unknown, b: unknown): boolean {
  if (a === undefined) throw new Error('Left operand is not provided');
  if (b === undefined) {
    if (rule === undefined || rule === 'not') {
      const onTruthy = rule !== 'not';
      if (isTrueBoolean(String(a))) return onTruthy;
      if (isFalseBoolean(String(a))) return !onTruthy;
      return a ? onTruthy : !onTruthy;
    }
    throw new Error(
      `Unknown boolean comparison rule for truthy check. If right operand is not provided, the rule must not provided or be 'not'. Provided: ${rule}`,
    );
  }
  rule ??= 'eq';
  if (typeof a === 'number' && typeof b === 'number') {
    switch (rule) {
      case 'gt':
        return a > b;
      case 'gte':
        return a >= b;
      case 'lt':
        return a < b;
      case 'lte':
        return a <= b;
      case 'eq':
        return a === b;
      case 'neq':
        return a !== b;
      case 'in':
      case 'nin':
        break;
      default:
        throw new Error(
          `Unknown boolean comparison rule for type number. Accepted: gt, gte, lt, lte, eq, neq. Provided: ${rule}`,
        );
    }
  }
  const aText = typeof a === 'string' ? a.toLowerCase() : JSON.stringify(a).toLowerCase();
  const bText = typeof b === 'string' ? b.toLowerCase() : JSON.stringify(b).toLowerCase();
  switch (rule) {
    case 'in':
      return aText.includes(bText);
    case 'nin':
      return !aText.includes(bText);
    case 'eq':
      return aText === bText;
    case 'neq':
      return aText !== bText;
    default:
      throw new Error(
        `Unknown boolean comparison rule for type string. Accepted: in, nin, eq, neq. Provided: ${rule}`,
      );
  }
}

/** Numbers from a space-separated list, a JSON list or variable names (`parseNumericSeries`). */
export function numericSeries(value: unknown, scope: Scope | null, stores: VariableStores): number[] {
  if (typeof value === 'number') return [value];
  let values: unknown[] = Array.isArray(value) ? value : String(value).split(' ');
  if (values.length === 1 && typeof values[0] === 'string') {
    values = values[0].startsWith('[')
      ? (convertValueType(values[0], 'array') as unknown[])
      : values[0].split(' ');
  }
  return values
    .map((v) => (typeof v === 'string' ? v.trim() : v))
    .filter((v) => v !== '')
    .map((v) => (Number.isNaN(Number(v)) ? Number(resolveVariable(String(v), scope, stores)) : Number(v)))
    .filter((v) => !Number.isNaN(v));
}

/** `/add`, `/mul`, ...: the result as text, 0 when it is not a number (`performOperation`). */
export function mathOperation(
  value: unknown,
  operation: (values: number[]) => number,
  single: boolean,
  scope: Scope | null,
  stores: VariableStores,
): string {
  if (!value || (Array.isArray(value) && value.length === 0)) return '0';
  const values = numericSeries(value, scope, stores);
  if (!values.length) return '0';
  const result = single ? operation([values[0]!]) : operation(values);
  return String(Number.isNaN(result) ? 0 : result);
}

export function isClosure(value: unknown): value is Closure {
  return value instanceof Closure;
}

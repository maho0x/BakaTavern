import { registerBuiltinMacros } from './builtins.ts';
import { MacroEngine } from './engine.ts';
import { MacroRegistry } from './registry.ts';

export * from './env.ts';
export * from './engine.ts';
export * from './registry.ts';
export { parseMacros } from './parser.ts';
export { formatDate, humanizeDuration } from './datetime.ts';
export { addVariable, readVariablePath, stringifyValue } from './variables.ts';
export { registerBuiltinMacros };

/** A macro engine with every built-in macro registered. */
export function createMacroEngine(): MacroEngine {
  return new MacroEngine(registerBuiltinMacros(new MacroRegistry()));
}

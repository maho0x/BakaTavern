import type { NamedArguments, UnnamedValue } from './closure.ts';

/** Argument types (SillyTavern `ARGUMENT_TYPE`), for help and autocomplete. */
export const ArgType = {
  STRING: 'string',
  NUMBER: 'number',
  RANGE: 'range',
  BOOLEAN: 'bool',
  VARIABLE_NAME: 'varname',
  CLOSURE: 'closure',
  SUBCOMMAND: 'subcommand',
  LIST: 'list',
  DICTIONARY: 'dictionary',
} as const;

export type ArgTypeName = (typeof ArgType)[keyof typeof ArgType];

export interface EnumValue {
  value: string;
  description?: string;
}

export interface ArgumentDefinition {
  description: string;
  typeList?: ArgTypeName[];
  isRequired?: boolean;
  acceptsMultiple?: boolean;
  defaultValue?: string | null;
  enumList?: (string | EnumValue)[];
  /** Only enum values are accepted. */
  forceEnum?: boolean;
}

export interface NamedArgumentDefinition extends ArgumentDefinition {
  name: string;
  aliasList?: string[];
}

/** What a command returns into the pipe: text, a closure, or anything (stored as JSON). */
export type CommandResult = unknown;

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  callback?: (args: NamedArguments, value: UnnamedValue) => CommandResult | Promise<CommandResult>;
  helpString?: string;
  /** Description of the return value. */
  returns?: string;
  namedArgumentList?: NamedArgumentDefinition[];
  unnamedArgumentList?: ArgumentDefinition[];
  /** The unnamed argument is split at whitespace (respecting quotes) into a list. */
  splitUnnamedArgument?: boolean;
  /** At most this many parts; the rest is one value. */
  splitUnnamedArgumentCount?: number;
  /** Quotes around the unnamed argument are kept. */
  rawQuotes?: boolean;
}

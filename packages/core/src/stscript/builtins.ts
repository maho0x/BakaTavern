/**
 * STscript commands that need nothing but the script itself: flow control, variables, math,
 * text, lists and closures (SillyTavern `variables.js` and part of `slash-commands.js`).
 */

import Fuse from 'fuse.js';

import { trimToEndSentence } from '../generation/cleanup.ts';
import { regexFromString } from '../regex/engine.ts';
import { isFalseBoolean } from '../util/text.ts';
import {
  BreakController,
  Closure,
  type NamedArguments,
  type ScriptValue,
  type UnnamedValue,
} from './closure.ts';
import type { Stscript } from './runtime.ts';
import { ArgType, type ArgumentDefinition, type NamedArgumentDefinition } from './types.ts';
import {
  addToVariable,
  booleanOperands,
  deleteVariable,
  evalBoolean,
  getVariable,
  mathOperation,
  type IndexArgs,
  resolveVariable,
  setVariable,
} from './variables.ts';

/** Loops stop after this many rounds unless `guard=off`. */
export const MAX_LOOPS = 100;

const any = Object.values(ArgType);
const named = (name: string, description: string, extra: Partial<NamedArgumentDefinition> = {}) => ({
  name,
  description,
  ...extra,
});
const unnamed = (description: string, extra: Partial<ArgumentDefinition> = {}) => ({ description, ...extra });

/** SillyTavern `trimToStartSentence`. */
export function trimToStartSentence(input: string): string {
  if (!input) return '';
  const p1 = input.indexOf('.');
  const p2 = input.indexOf('!');
  const p3 = input.indexOf('?');
  const p4 = input.indexOf('\n');
  let first = p1;
  let skip1 = false;
  if (p2 > 0 && p2 < first) first = p2;
  if (p3 > 0 && p3 < first) first = p3;
  if (p4 > 0 && p4 < first) {
    first = p4;
    skip1 = true;
  }
  if (first > 0) return skip1 ? input.substring(first + 1) : input.substring(first + 2);
  return input;
}

/** `typeof`-then-value ordering of SillyTavern's `/sort`. */
function sortComparator(a: unknown, b: unknown): number {
  if (typeof a !== typeof b) {
    a = typeof a;
    b = typeof b;
  }
  return (a as number) > (b as number) ? 1 : (a as number) < (b as number) ? -1 : 0;
}

function lengthOf(value: unknown): number {
  let parsed: unknown = value;
  try {
    parsed = JSON.parse(value as string);
  } catch {
    // not JSON
  }
  if (Array.isArray(parsed)) return parsed.length;
  switch (typeof parsed) {
    case 'string':
      return parsed.length;
    case 'object':
      return parsed ? Object.keys(parsed).length : 0;
    case 'number':
      return String(parsed).length;
    default:
      return 0;
  }
}

/** The command an `/if`, `/while` or `/times` runs: a closure, or text to run as a script. */
function subCommand(parts: ScriptValue[] | undefined): ScriptValue | undefined {
  if (!parts?.length) return undefined;
  return parts[0] instanceof Closure ? parts[0] : parts.join(' ');
}

export function registerBuiltinCommands(st: Stscript) {
  const stores = () => st.variables;
  const sub = (command: string, args: NamedArguments) =>
    st.executeSubCommands(command, args._scope, args._parserFlags, args._abortController);
  const asList = (value: UnnamedValue): ScriptValue[] => (Array.isArray(value) ? value : [value]);

  // Syntax the parser handles itself; registered so that the names are known.
  st.commands
    .add({ name: '/', aliases: ['#'], helpString: 'Write a comment.' }, true)
    .add({ name: 'parser-flag', helpString: 'Set a parser flag.' }, true)
    .add({ name: 'breakpoint', helpString: 'Set a breakpoint for debugging.' }, true)
    .add(
      {
        name: 'break',
        helpString: 'Break out of a loop or closure executed through /run or /:',
        unnamedArgumentList: [
          unnamed('value to pass down the pipe instead of the current pipe value', { typeList: any }),
        ],
      },
      true,
    );

  st.commands
    .add({
      name: 'pass',
      aliases: ['return'],
      helpString: 'Passes the text to the next command through the pipe.',
      unnamedArgumentList: [unnamed('text', { typeList: any, isRequired: true })],
      callback: (_, value) => {
        if (Array.isArray(value) && value.some((x) => x instanceof Closure))
          throw new Error('Command /pass does not support multiple closures');
        return Array.isArray(value) ? JSON.stringify(value) : value;
      },
    })
    .add({
      name: 'run',
      aliases: ['call', 'exec'],
      helpString: 'Runs a closure from a scoped variable, or a Quick Reply with the specified name.',
      unnamedArgumentList: [
        unnamed('scoped variable or qr label', {
          typeList: [ArgType.VARIABLE_NAME, ArgType.STRING, ArgType.CLOSURE],
          isRequired: true,
        }),
      ],
      callback: async (args, value) => {
        if (!value) throw new Error('No name provided for /run command');
        if (value instanceof Closure) {
          value.breakController = new BreakController();
          return (await value.execute()).pipe;
        }
        const name = String(value);
        const scope = args._scope;
        if (scope.existsVariable(name)) {
          const closure = scope.getVariable(name);
          if (!(closure instanceof Closure)) throw new Error(`"${name}" is not callable.`);
          closure.scope.parent = scope;
          closure.breakController = new BreakController();
          closure.providedArgumentList = closure.argumentList
            .filter((arg) => Object.hasOwn(args, arg.name))
            .map((arg) => ({ name: arg.name, value: args[arg.name] as ScriptValue, start: 0, end: 0 }));
          return (await closure.execute()).pipe;
        }
        if (!st.options.runQuickReply) throw new Error('Quick Reply extension is not loaded');
        try {
          return await st.options.runQuickReply(name.trim(), args, {
            abortController: args._abortController,
          });
        } catch (error) {
          throw new Error(`Error running Quick Reply "${name.trim()}": ${(error as Error).message}`, {
            cause: error,
          });
        }
      },
    })
    .add({
      name: 'abort',
      helpString: 'Aborts the slash command batch execution.',
      namedArgumentList: [
        named('quiet', 'Whether to suppress the toast message notifying about the /abort call.', {
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'true',
        }),
      ],
      unnamedArgumentList: [unnamed('The reason for aborting command execution. Shown when quiet=false')],
      callback: (args, reason) => {
        if (args.quiet instanceof Closure)
          throw new Error("argument 'quiet' cannot be a closure for command /abort");
        const text = String(reason ?? '');
        args._abortController?.abort(
          text.length === 0 ? '/abort command executed' : text,
          !isFalseBoolean(String(args.quiet ?? 'true')),
        );
        return '';
      },
    })
    .add({
      name: 'delay',
      aliases: ['wait', 'sleep'],
      helpString: 'Delays the next command in the pipe by the specified number of milliseconds.',
      unnamedArgumentList: [unnamed('milliseconds', { typeList: [ArgType.NUMBER], isRequired: true })],
      callback: async (_, amount) => {
        if (!amount) return '';
        const ms = Number(amount);
        await new Promise((resolve) => setTimeout(resolve, Number.isNaN(ms) ? 0 : ms));
        return '';
      },
    })
    .add({
      name: 'fuzzy',
      helpString: 'Performs a fuzzy match of each item in the list against the text to search.',
      namedArgumentList: [
        named('list', 'list of items to match against', {
          isRequired: true,
          typeList: [ArgType.LIST, ArgType.VARIABLE_NAME],
        }),
        named('threshold', 'fuzzy match threshold (0.0 to 1.0)', {
          typeList: [ArgType.NUMBER],
          defaultValue: '0.4',
        }),
        named('mode', 'fuzzy match mode', { defaultValue: 'first', enumList: ['first', 'best'] }),
      ],
      unnamedArgumentList: [unnamed('text to search', { isRequired: true })],
      callback: (args, value) => {
        if (!value || !args.list) return '';
        try {
          const list: unknown = JSON.parse(String(resolveVariable(String(args.list), null, stores())));
          if (!Array.isArray(list)) return '';
          const params = { includeScore: true, findAllMatches: true, ignoreLocation: true, threshold: 0.4 };
          if ('threshold' in args) {
            const threshold = parseFloat(String(args.threshold));
            if (Number.isNaN(threshold)) return '';
            params.threshold = Math.min(1, Math.max(0, threshold));
          }
          const text = String(value);
          if (String(args.mode).trim().toLowerCase() === 'best') {
            const result = new Fuse(list, params).search(text);
            return result.length > 0 ? result[0]!.item : '';
          }
          const fuse = new Fuse([text], params);
          for (const item of list) if (fuse.search(item).length > 0) return item;
          return '';
        } catch {
          return '';
        }
      },
    })
    .add({
      name: 'upper',
      aliases: ['uppercase', 'to-upper'],
      helpString: 'Converts the provided string to uppercase.',
      unnamedArgumentList: [unnamed('string to convert', { isRequired: true })],
      callback: (_, text) => (typeof text === 'string' ? text.toUpperCase() : ''),
    })
    .add({
      name: 'lower',
      aliases: ['lowercase', 'to-lower'],
      helpString: 'Converts the provided string to lowercase.',
      unnamedArgumentList: [unnamed('string to convert', { isRequired: true })],
      callback: (_, text) => (typeof text === 'string' ? text.toLowerCase() : ''),
    })
    .add({
      name: 'substr',
      aliases: ['substring'],
      helpString: 'Extracts text from the provided string (start inclusive, end exclusive).',
      namedArgumentList: [
        named('start', 'start index', { typeList: [ArgType.NUMBER] }),
        named('end', 'end index', { typeList: [ArgType.NUMBER] }),
      ],
      unnamedArgumentList: [unnamed('string to extract from')],
      callback: (args, text) =>
        typeof text === 'string'
          ? text.slice(Number(args.start), args.end ? Number(args.end) : (args.end as undefined))
          : '',
    })
    .add({
      name: 'replace',
      aliases: ['re'],
      helpString: 'Replaces text within the provided string based on the pattern.',
      namedArgumentList: [
        named('mode', 'Replaces occurrence(s) of a pattern', {
          defaultValue: 'literal',
          enumList: ['literal', 'regex'],
        }),
        named('pattern', 'pattern to search with', { isRequired: true }),
        named('replacer', 'replacement text for matches', { defaultValue: '' }),
      ],
      unnamedArgumentList: [unnamed('input text', { isRequired: true })],
      callback: (args, value) => {
        const { mode = 'literal', pattern, replacer = '' } = args as Record<string, unknown>;
        if (!pattern) throw new Error("Argument of 'pattern=' cannot be empty");
        const text = String(value);
        switch (mode) {
          case 'literal':
            return text.replaceAll(String(pattern), String(replacer));
          case 'regex':
            return text.replace(regexFromString(String(pattern)) as RegExp, String(replacer));
          default:
            throw new Error("Invalid '/replace mode=' argument specified!");
        }
      },
    })
    .add({
      name: 'test',
      helpString: 'Tests text for a regular expression match.',
      namedArgumentList: [named('pattern', 'pattern to find', { isRequired: true })],
      unnamedArgumentList: [unnamed('text to test', { isRequired: true })],
      callback: (args, text) => {
        if (!args.pattern) throw new Error("Argument of 'pattern=' cannot be empty");
        const re = regexFromString(String(args.pattern));
        if (!re) throw new Error("The value of 'pattern' argument is not a valid regular expression.");
        return JSON.stringify(re.test(String(text)));
      },
    })
    .add({
      name: 'match',
      helpString: 'Returns the groups of the regular expression match(es) as a JSON list.',
      namedArgumentList: [named('pattern', 'pattern to find', { isRequired: true })],
      unnamedArgumentList: [unnamed('text to match against', { isRequired: true })],
      callback: (args, text) => {
        if (!args.pattern) throw new Error("Argument of 'pattern=' cannot be empty");
        const re = regexFromString(String(args.pattern));
        if (!re) throw new Error("The value of 'pattern' argument is not a valid regular expression.");
        if (re.flags.includes('g')) return JSON.stringify([...String(text).matchAll(re)]);
        const match = String(text).match(re);
        return match ? JSON.stringify(match) : '';
      },
    })
    .add({
      name: 'trimstart',
      helpString: 'Trims the text to the start of the first full sentence.',
      unnamedArgumentList: [unnamed('text', { isRequired: true })],
      callback: (_, value) => (value ? trimToStartSentence(String(value)) : ''),
    })
    .add({
      name: 'trimend',
      helpString: 'Trims the text to the end of the last full sentence.',
      unnamedArgumentList: [unnamed('text', { isRequired: true })],
      callback: (_, value) => (value ? trimToEndSentence(String(value)) : ''),
    })
    .add({
      name: 'array-wrap',
      aliases: ['list-wrap'],
      helpString: 'Wraps the provided value into an array, if it is not one already.',
      namedArgumentList: [
        named('stringify', 'Whether to keep JSON primitives as they were written', {
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'true',
        }),
      ],
      unnamedArgumentList: [unnamed('value', { isRequired: true, typeList: [ArgType.STRING, ArgType.LIST] })],
      callback: (args, value) => {
        if (value instanceof Closure)
          throw new Error(
            'Closures are not supported as unnamed arguments for /array-wrap. Did you forget to call the closure with parentheses?',
          );
        if (Array.isArray(value)) throw new Error('/array-wrap does not support multiple unnamed arguments.');
        if (value === '') return JSON.stringify([]);
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed)) return value;
          if (typeof parsed === 'object' && parsed !== null) return JSON.stringify([parsed]);
          const primitive = parsed === null || ['string', 'number', 'boolean'].includes(typeof parsed);
          if (primitive && isFalseBoolean(String(args.stringify))) return JSON.stringify([parsed]);
          return JSON.stringify([value]);
        } catch {
          return JSON.stringify([value]);
        }
      },
    })
    .add({
      name: 'array-unwrap',
      aliases: ['list-unwrap'],
      helpString: 'Unwraps the first element of an array. Other values pass unchanged.',
      unnamedArgumentList: [unnamed('value', { isRequired: true, typeList: [ArgType.STRING, ArgType.LIST] })],
      callback: (_, value) => {
        if (value instanceof Closure)
          throw new Error(
            'Closures are not supported as unnamed arguments for /array-unwrap. Did you forget to call the closure with parentheses?',
          );
        if (Array.isArray(value))
          throw new Error('/array-unwrap does not support multiple unnamed arguments.');
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed)) {
            const first: unknown = parsed[0] ?? '';
            if (first === null || first === undefined) return '';
            return typeof first === 'object' ? JSON.stringify(first) : String(first);
          }
          return value;
        } catch {
          return value;
        }
      },
    });

  // Variables
  const keyArg = named('key', 'variable name', { typeList: [ArgType.VARIABLE_NAME], isRequired: true });
  const indexArg = named('index', 'list index', { typeList: [ArgType.NUMBER, ArgType.STRING] });
  const asArg = named('as', 'change the type of the value when used with index', { defaultValue: 'string' });
  const valueArg = unnamed('value', {
    isRequired: true,
    typeList: [ArgType.STRING, ArgType.NUMBER, ArgType.BOOLEAN, ArgType.LIST, ArgType.DICTIONARY],
  });
  const nameArg = unnamed('key', { typeList: [ArgType.VARIABLE_NAME] });
  for (const global of [false, true]) {
    const store = () => (global ? stores().global : stores().local);
    const prefix = global ? 'global' : '';
    const alias = (base: string) => (global ? [] : [base.replace('var', 'chatvar')]);
    st.commands
      .add({
        name: `set${prefix}var`,
        aliases: alias('setvar'),
        helpString: `Sets a ${global ? 'global' : 'local'} variable value and passes it down the pipe.`,
        namedArgumentList: [keyArg, indexArg, asArg],
        unnamedArgumentList: [valueArg],
        callback: (args, value) =>
          String(setVariable(store(), String(args.key || args.name), value, args as IndexArgs)),
      })
      .add({
        name: `get${prefix}var`,
        aliases: alias('getvar'),
        helpString: `Gets a ${global ? 'global' : 'local'} variable value and passes it down the pipe.`,
        namedArgumentList: [{ ...keyArg, isRequired: false }, indexArg],
        unnamedArgumentList: [nameArg],
        callback: (args, value) => String(getVariable(store(), String(value), args as IndexArgs)),
      })
      .add({
        name: `add${prefix}var`,
        aliases: alias('addvar'),
        helpString: 'Adds a value to a variable: appends to a list, adds to a number, or appends text.',
        namedArgumentList: [keyArg],
        unnamedArgumentList: [valueArg],
        callback: (args, value) => String(addToVariable(store(), String(args.key || args.name), value)),
      })
      .add({
        name: `inc${prefix}var`,
        aliases: alias('incvar'),
        helpString: 'Increments a variable by 1 and passes the result down the pipe.',
        unnamedArgumentList: [{ ...nameArg, isRequired: true }],
        callback: (_, value) => String(addToVariable(store(), String(value), 1)),
      })
      .add({
        name: `dec${prefix}var`,
        aliases: alias('decvar'),
        helpString: 'Decrements a variable by 1 and passes the result down the pipe.',
        unnamedArgumentList: [{ ...nameArg, isRequired: true }],
        callback: (_, value) => String(addToVariable(store(), String(value), -1)),
      })
      .add({
        name: `flush${prefix}var`,
        aliases: alias('flushvar'),
        helpString: 'Deletes a variable.',
        unnamedArgumentList: [
          { ...nameArg, isRequired: true, typeList: [ArgType.VARIABLE_NAME, ArgType.CLOSURE] },
        ],
        callback: async (_, value) =>
          deleteVariable(
            store(),
            value instanceof Closure ? String((await value.execute()).pipe) : String(value),
          ),
      });
  }
  st.commands.add({
    name: 'listvar',
    aliases: ['listchatvar'],
    helpString: 'Lists the chat and global variables (in a popup unless return= says otherwise).',
    namedArgumentList: [
      named('scope', 'filter variables by scope', {
        defaultValue: 'all',
        enumList: ['all', 'local', 'global'],
      }),
      named('return', 'The way how you want the return value to be provided', { defaultValue: 'popup-html' }),
    ],
    callback: async (args) => {
      const scope =
        String(args.scope || '')
          .toLowerCase()
          .trim() || 'all';
      const { local, global } = stores();
      const entries = (store: typeof local) => store.entries?.() ?? [];
      const localVars = scope === 'all' || scope === 'local' ? entries(local) : [];
      const globalVars = scope === 'all' || scope === 'global' ? entries(global) : [];
      const json = [
        ...localVars.map(([key, value]) => ({ key, value, scope: 'local' })),
        ...globalVars.map(([key, value]) => ({ key, value, scope: 'global' })),
      ];
      const text = () =>
        [
          scope === 'all' || scope === 'local'
            ? `### Local variables (${st.options.chatName?.() ?? ''}):\n${localVars.map(([k, v]) => `${k}: ${String(v)}`).join('\n\n') || 'No local variables'}`
            : '',
          scope === 'all' || scope === 'global'
            ? `### Global variables:\n${globalVars.map(([k, v]) => `${k}: ${String(v)}`).join('\n\n') || 'No global variables'}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n');
      return st.doReturn(String(args.return ?? 'popup-html'), json, { toText: text });
    },
  });

  // Flow control
  const comparison = [
    named('left', 'left operand', {
      typeList: [ArgType.VARIABLE_NAME, ArgType.STRING, ArgType.NUMBER],
      isRequired: true,
    }),
    named('right', 'right operand', { typeList: [ArgType.VARIABLE_NAME, ArgType.STRING, ArgType.NUMBER] }),
    named('rule', 'comparison rule', {
      enumList: ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'not'],
    }),
  ];
  st.commands
    .add({
      name: 'if',
      helpString: 'Compares the left and right operands and runs the command when the comparison is true.',
      namedArgumentList: [
        ...comparison,
        named('else', 'command to execute if not true', { typeList: [ArgType.CLOSURE, ArgType.SUBCOMMAND] }),
      ],
      unnamedArgumentList: [
        unnamed('command to execute if true', {
          typeList: [ArgType.CLOSURE, ArgType.SUBCOMMAND],
          isRequired: true,
        }),
      ],
      splitUnnamedArgument: true,
      callback: async (args, value) => {
        const { a, b, rule } = booleanOperands(args, stores());
        const result = evalBoolean(rule, a, b);
        const command = subCommand(asList(value));
        if (result && command) {
          if (command instanceof Closure) return (await command.execute()).pipe;
          return (await sub(command, args)).pipe;
        }
        const otherwise = args.else as ScriptValue | undefined;
        if (!result && otherwise && (otherwise instanceof Closure || otherwise !== '')) {
          if (otherwise instanceof Closure) return (await otherwise.execute()).pipe;
          return (await sub(otherwise, args)).pipe;
        }
        return '';
      },
    })
    .add({
      name: 'while',
      helpString: 'Runs the command while the comparison is true (at most 100 times unless guard=off).',
      namedArgumentList: [
        ...comparison,
        named('guard', 'disable loop iteration limit', { typeList: [ArgType.BOOLEAN], defaultValue: 'on' }),
      ],
      unnamedArgumentList: [
        unnamed('command to execute while true', {
          typeList: [ArgType.CLOSURE, ArgType.SUBCOMMAND],
          isRequired: true,
        }),
      ],
      splitUnnamedArgument: true,
      callback: async (args, value) => {
        if (args.guard instanceof Closure)
          throw new Error("argument 'guard' cannot be a closure for command /while");
        const iterations = isFalseBoolean(String(args.guard ?? '')) ? Number.MAX_SAFE_INTEGER : MAX_LOOPS;
        const command = subCommand(asList(value));
        let result;
        for (let i = 0; i < iterations; i++) {
          const { a, b, rule } = booleanOperands(args, stores());
          if (!evalBoolean(rule, a, b) || !command) break;
          if (command instanceof Closure) {
            command.breakController = new BreakController();
            result = await command.execute();
          } else {
            result = await sub(command, args);
          }
          if (result.isAborted || result.isBreak) break;
        }
        return result ? result.pipe : '';
      },
    })
    .add({
      name: 'times',
      helpString: 'Runs the command the given number of times; {{timesIndex}} is the round, from 0.',
      namedArgumentList: [
        named('guard', 'disable loop iteration limit', { typeList: [ArgType.BOOLEAN], defaultValue: 'on' }),
      ],
      unnamedArgumentList: [
        unnamed('repeats', { typeList: [ArgType.NUMBER], isRequired: true }),
        unnamed('command', { typeList: [ArgType.CLOSURE, ArgType.SUBCOMMAND], isRequired: true }),
      ],
      splitUnnamedArgument: true,
      splitUnnamedArgumentCount: 1,
      callback: async (args, value) => {
        if (args.guard instanceof Closure)
          throw new Error("argument 'guard' cannot be a closure for command /while");
        let repeats: ScriptValue | undefined;
        let command: ScriptValue | undefined;
        if (Array.isArray(value)) {
          [repeats] = value;
          command = subCommand(value.slice(1));
        } else {
          const [count, ...rest] = String(value).split(' ');
          repeats = count;
          command = rest.join(' ');
        }
        const guardOff = isFalseBoolean(String(args.guard ?? ''));
        const iterations = Math.min(Number(repeats), guardOff ? Number.MAX_SAFE_INTEGER : MAX_LOOPS);
        let result;
        for (let i = 0; i < iterations; i++) {
          if (command instanceof Closure) {
            command.breakController = new BreakController();
            command.scope.setMacro('timesIndex', i);
            result = await command.execute();
          } else {
            result = await sub(String(command ?? '').replace(/\{\{timesIndex\}\}/g, String(i)), args);
          }
          if (result.isAborted || result.isBreak) break;
        }
        return result?.pipe ?? '';
      },
    });

  // Math
  const series = [
    unnamed('values to operate on', {
      typeList: [ArgType.NUMBER, ArgType.VARIABLE_NAME, ArgType.LIST],
      isRequired: true,
      acceptsMultiple: true,
    }),
  ];
  const math = (name: string, help: string, operation: (values: number[]) => number, single = false) =>
    st.commands.add({
      name,
      helpString: help,
      unnamedArgumentList: single
        ? [unnamed('value', { typeList: [ArgType.NUMBER, ArgType.VARIABLE_NAME], isRequired: true })]
        : series,
      splitUnnamedArgument: !single,
      callback: (args, value) => mathOperation(value, operation, single, args._scope, stores()),
    });
  math('add', 'Performs an addition of the set of values and passes the result down the pipe.', (v) =>
    v.reduce((a, b) => a + b, 0),
  );
  math('mul', 'Performs a multiplication of the set of values.', (v) => v.reduce((a, b) => a * b, 1));
  math('max', 'Returns the maximum value of the set of values.', (v) => Math.max(...v));
  math('min', 'Returns the minimum value of the set of values.', (v) => Math.min(...v));
  math('sub', 'Performs a subtraction of the set of values.', (v) =>
    v.reduce((a, b) => a - b, v.shift() ?? 0),
  );
  math('div', 'Performs a division of two values.', (v) => (v[1] === 0 ? 0 : v[0]! / v[1]!));
  math('mod', 'Performs a modulo operation of two values.', (v) => (v[1] === 0 ? 0 : v[0]! % v[1]!));
  math('pow', 'Performs a power operation of two values.', (v) => Math.pow(v[0]!, v[1]!));
  math('sin', 'Performs a sine operation of a value.', (v) => Math.sin(v[0]!), true);
  math('cos', 'Performs a cosine operation of a value.', (v) => Math.cos(v[0]!), true);
  math('log', 'Performs a logarithm operation of a value.', (v) => Math.log(v[0]!), true);
  math('abs', 'Performs an absolute value operation of a value.', (v) => Math.abs(v[0]!), true);
  math('sqrt', 'Performs a square root operation of a value.', (v) => Math.sqrt(v[0]!), true);
  math('round', 'Rounds a value.', (v) => Math.round(v[0]!), true);

  st.commands
    .add({
      name: 'len',
      aliases: ['length'],
      helpString: 'Gets the length of a value (characters of text, items of a list or object).',
      unnamedArgumentList: [
        unnamed('value', { typeList: [ArgType.STRING, ArgType.LIST, ArgType.DICTIONARY] }),
      ],
      callback: (_, value) => String(lengthOf(value)),
    })
    .add({
      name: 'sort',
      helpString: 'Sorts a list by value, or an object by keys (by values with keysort=false).',
      namedArgumentList: [
        named('keysort', 'whether to sort by key or value', {
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'true',
        }),
      ],
      unnamedArgumentList: [unnamed('value', { typeList: [ArgType.LIST, ArgType.DICTIONARY] })],
      callback: (args, value) => {
        let parsed: unknown;
        if (typeof value === 'string') {
          try {
            parsed = JSON.parse(value);
          } catch {
            return value;
          }
        } else {
          parsed = value;
        }
        if (Array.isArray(parsed)) {
          parsed.sort(sortComparator);
        } else if (typeof parsed === 'object' && parsed !== null) {
          const object = parsed as Record<string, unknown>;
          parsed = isFalseBoolean(String(args.keysort))
            ? Object.keys(object).sort((a, b) => sortComparator(object[a], object[b]))
            : Object.keys(object).sort(sortComparator);
        }
        return JSON.stringify(parsed);
      },
    })
    .add({
      name: 'rand',
      helpString: 'Returns a random number between from= and to= (0 and 1, or 0 and the argument).',
      namedArgumentList: [
        named('from', 'starting value for the range (inclusive)', {
          typeList: [ArgType.NUMBER],
          defaultValue: '0',
        }),
        named('to', 'ending value for the range (inclusive)', { typeList: [ArgType.NUMBER] }),
        named('round', 'rounding method for the result', { enumList: ['round', 'ceil', 'floor'] }),
      ],
      unnamedArgumentList: [unnamed('upper bound', { typeList: [ArgType.NUMBER] })],
      callback: (args, value) => {
        const from = Number(args.from ?? 0);
        const to = Number(args.to ?? (value ? value : 1));
        const result = from + Math.random() * (to - from);
        if (args.round === 'round') return String(Math.round(result));
        if (args.round === 'ceil') return String(Math.ceil(result));
        if (args.round === 'floor') return String(Math.floor(result));
        return String(result);
      },
    });

  // Scoped variables and closures
  const scoped =
    (set: (args: NamedArguments, key: string, value: ScriptValue | undefined, has: boolean) => unknown) =>
    (args: NamedArguments, value: UnnamedValue) => {
      const parts = Array.isArray(value) ? [...value] : [value];
      if (args.key !== undefined) {
        if (typeof args.key !== 'string') throw new Error('Key must be a string');
        const val = typeof parts[0] === 'string' ? parts.join(' ') : parts[0];
        return set(args, args.key, val, args._hasUnnamedArgument);
      }
      const key = parts.shift();
      if (typeof key !== 'string') throw new Error('Key must be a string');
      const val = typeof parts[0] === 'string' ? parts.join(' ') : parts[0];
      return set(args, key, val, parts.length > 0);
    };
  st.commands
    .add({
      name: 'let',
      helpString: 'Declares a new variable in the current scope.',
      namedArgumentList: [
        named('key', 'variable name; or use as unnamed argument', { typeList: [ArgType.VARIABLE_NAME] }),
      ],
      unnamedArgumentList: [
        unnamed('variable name', { typeList: [ArgType.VARIABLE_NAME] }),
        unnamed('variable value', { typeList: any }),
      ],
      splitUnnamedArgument: true,
      splitUnnamedArgumentCount: 1,
      callback: scoped((args, key, value, has) => {
        if (has) {
          args._scope.letVariable(key, value);
          return value;
        }
        args._scope.letVariable(key);
        return '';
      }),
    })
    .add({
      name: 'var',
      helpString: 'Gets or sets a variable in the current scope or the nearest scope that has it.',
      namedArgumentList: [
        named('key', 'variable name; or use as unnamed argument', { typeList: [ArgType.VARIABLE_NAME] }),
        named('index', 'optional index for list or dictionary', {
          typeList: [ArgType.NUMBER, ArgType.STRING],
        }),
        named('as', 'change the type of the value when used with index', { defaultValue: 'string' }),
      ],
      unnamedArgumentList: [
        unnamed('variable name', { typeList: [ArgType.VARIABLE_NAME] }),
        unnamed('variable value', { typeList: any }),
      ],
      splitUnnamedArgument: true,
      splitUnnamedArgumentCount: 1,
      callback: scoped((args, key, value, has) => {
        const index = (args.index as string | undefined) ?? null;
        if (has) {
          args._scope.setVariable(key, value, index, (args.as as string | undefined) ?? null);
          return value;
        }
        return args._scope.getVariable(key, index);
      }),
    })
    .add({
      name: 'closure-serialize',
      helpString: 'Serializes a closure as text that can be stored and run later.',
      unnamedArgumentList: [
        unnamed('the closure to serialize', { typeList: [ArgType.CLOSURE], isRequired: true }),
      ],
      callback: (_, value) => {
        if (!(value instanceof Closure)) throw new Error('unnamed argument must be a closure');
        return value.rawText;
      },
    })
    .add({
      name: 'closure-deserialize',
      helpString: 'Turns serialized closure text back into a closure.',
      unnamedArgumentList: [unnamed('serialized closure', { isRequired: true })],
      callback: (args, value) => {
        const closure = st.parser().parse(String(value), true, args._parserFlags, args._abortController);
        closure.scope.parent = args._scope;
        return closure;
      },
    });
}

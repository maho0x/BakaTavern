import { stringHash } from '../util/hash.ts';
import { rollDice, seededRandom } from '../util/random.ts';
import { isFalseBoolean } from '../util/text.ts';
import { formatDate, humanizeDuration, shiftToUtcOffset } from './datetime.ts';
import { ELSE_MARKER, ORIGINAL_STATE, TRIM_MARKER, splitOnTopLevelElse } from './engine.ts';
import type { MacroEnv, VariableScope } from './env.ts';
import type { MacroCall, MacroRegistry } from './registry.ts';
import { addVariable, readVariablePath, stringifyValue } from './variables.ts';

const VAR_SHORTHAND = /^([.$])([a-zA-Z](?:[\w-]*\w)?)$/;

/** `{{random:a,b}}` legacy lists: `::` wins over commas; `\,` escapes a comma. */
function readList(args: string[]): string[] {
  if (args.length !== 1) return args;
  const single = args[0]!;
  if (single.includes('::')) return single.split('::').map((s) => s.trim());
  return single
    .replaceAll('\\,', '\u0000COMMA\u0000')
    .split(',')
    .map((s) => s.trim().replaceAll('\u0000COMMA\u0000', ','));
}

function now(env: MacroEnv): Date {
  return env.now ? env.now() : new Date();
}

function lastMatching(env: MacroEnv, predicate: (m: NonNullable<MacroEnv['messages']>[number]) => boolean) {
  const messages = env.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (predicate(messages[i]!)) return messages[i];
  }
  return undefined;
}

function scopeOf(env: MacroEnv, global: boolean): VariableScope | undefined {
  return global ? env.globalVariables : env.localVariables;
}

function registerVariableMacros(registry: MacroRegistry, global: boolean): void {
  const prefix = global ? 'global' : '';
  const scope = (c: MacroCall) => scopeOf(c.env, global);
  const name = (base: string) => (global ? base.replace('var', `${prefix}var`) : base);
  registry
    .register(name('getvar'), {
      minArgs: 1,
      maxArgs: 1,
      handler: (c) => stringifyValue(scope(c) && readVariablePath(scope(c)!, c.args[0]!)),
    })
    .register(name('setvar'), {
      minArgs: 2,
      maxArgs: 2,
      handler: (c) => {
        scope(c)?.set(c.args[0]!, c.args[1]!);
        return '';
      },
    })
    .register(name('addvar'), {
      minArgs: 2,
      maxArgs: 2,
      handler: (c) => {
        const s = scope(c);
        if (s) addVariable(s, c.args[0]!, c.args[1]!);
        return '';
      },
    })
    .register(name('incvar'), {
      minArgs: 1,
      maxArgs: 1,
      handler: (c) => {
        const s = scope(c);
        return s ? stringifyValue(addVariable(s, c.args[0]!, 1)) : '';
      },
    })
    .register(name('decvar'), {
      minArgs: 1,
      maxArgs: 1,
      handler: (c) => {
        const s = scope(c);
        return s ? stringifyValue(addVariable(s, c.args[0]!, -1)) : '';
      },
    })
    .register(name('hasvar'), {
      minArgs: 1,
      maxArgs: 1,
      aliases: [global ? 'globalvarexists' : 'varexists'],
      handler: (c) => (scope(c)?.has(c.args[0]!) ? 'true' : 'false'),
    })
    .register(name('deletevar'), {
      minArgs: 1,
      maxArgs: 1,
      aliases: [global ? 'flushglobalvar' : 'flushvar'],
      handler: (c) => {
        scope(c)?.delete(c.args[0]!);
        return '';
      },
    });
}

/** Registers SillyTavern's built-in macros. */
export function registerBuiltinMacros(registry: MacroRegistry): MacroRegistry {
  // Utility
  registry
    .register('space', { maxArgs: 1, handler: (c) => ' '.repeat(Math.max(1, Number(c.args[0] ?? 1) || 1)) })
    .register('newline', {
      maxArgs: 1,
      handler: (c) => '\n'.repeat(Math.max(1, Number(c.args[0] ?? 1) || 1)),
    })
    .register('noop', { maxArgs: 0, handler: () => '' })
    .register('trim', { maxArgs: 1, handler: (c) => (c.isScoped ? (c.args[0] ?? '') : TRIM_MARKER) })
    .register('//', { aliases: ['comment'], handler: () => '' })
    .register('else', { maxArgs: 0, handler: () => ELSE_MARKER })
    .register('if', {
      delayArgResolution: true,
      minArgs: 1,
      maxArgs: 2,
      handler: (c) => {
        let condition = c.args[0] ?? '';
        let inverted = false;
        if (/^\s*!/.test(condition)) {
          inverted = true;
          condition = condition.replace(/^\s*!\s*/, '');
        }
        condition = c.resolve(condition).trim();
        const short = VAR_SHORTHAND.exec(condition);
        if (short) {
          condition = c.resolve(`{{${short[1] === '.' ? 'getvar' : 'getglobalvar'}::${short[2]}}}`);
        } else {
          const def = registry.get(condition);
          if (def && (def.minArgs ?? 0) === 0 && /^[a-zA-Z][\w-]*$/.test(condition)) {
            condition = c.resolve(`{{${condition}}}`);
          }
        }
        let falsy = condition === '' || isFalseBoolean(condition);
        if (inverted) falsy = !falsy;
        const { thenBranch, elseBranch } = splitOnTopLevelElse(c.args[1] ?? '');
        const branch = falsy ? elseBranch : thenBranch;
        if (branch === undefined) return '';
        const result = c.resolve(branch);
        return c.flags.preserveWhitespace ? result : c.trimContent(result);
      },
    })
    .register('input', { maxArgs: 0, handler: (c) => c.env.input ?? '' })
    .register('maxPrompt', {
      maxArgs: 0,
      aliases: ['maxPromptTokens'],
      handler: (c) => String(c.env.maxPromptTokens ?? ''),
    })
    .register('maxContext', {
      maxArgs: 0,
      aliases: ['maxContextTokens'],
      handler: (c) => String(c.env.maxContextTokens ?? ''),
    })
    .register('maxResponse', {
      maxArgs: 0,
      aliases: ['maxResponseTokens'],
      handler: (c) => String(c.env.maxResponseTokens ?? ''),
    })
    .register('reverse', {
      minArgs: 1,
      maxArgs: 1,
      handler: (c) => Array.from(c.args[0]!).reverse().join(''),
    })
    .register('roll', {
      minArgs: 1,
      maxArgs: 1,
      handler: (c) => {
        const result = rollDice(c.args[0]!, c.env.random);
        return result === null ? '' : String(result);
      },
    })
    .register('random', {
      handler: (c) => {
        const list = readList(c.args);
        if (!list.length) return '';
        const rng = c.env.random ?? Math.random;
        return list[Math.floor(rng() * list.length)] ?? '';
      },
    })
    .register('pick', {
      handler: (c) => {
        const list = readList(c.args);
        if (!list.length) return '';
        const seed = stringHash(
          [String(stringHash(c.env.chatId ?? '')), c.offset, c.rawArgs.join('::')].join('-'),
        );
        return list[Math.floor(seededRandom(seed)() * list.length)] ?? '';
      },
    })
    .register('banned', {
      minArgs: 1,
      maxArgs: 1,
      handler: (c) => {
        const word = c.args[0]!.replace(/^"|"$/g, '');
        if (word) c.env.bannedWords?.push(word);
        return '';
      },
    })
    .register('outlet', { minArgs: 1, maxArgs: 1, handler: (c) => c.env.outlets?.[c.args[0]!] ?? '' });

  // Names and character card fields
  const field = (name: string, get: (env: MacroEnv) => string | undefined, aliases: string[] = []) =>
    registry.register(name, { maxArgs: 0, aliases, handler: (c) => get(c.env) ?? '' });
  field('user', (e) => e.user);
  field('char', (e) => e.char);
  field('group', (e) => e.group ?? e.char);
  field('groupNotMuted', (e) => e.groupNotMuted ?? e.group ?? e.char);
  field('notChar', (e) => e.notChar ?? e.user);
  field('charIfNotGroup', (e) => (e.isGroup ? (e.group ?? e.char) : e.char));
  field('charPrompt', (e) => e.charPrompt);
  field('charInstruction', (e) => e.charInstruction, ['charJailbreak']);
  field('charDescription', (e) => e.description, ['description']);
  field('charPersonality', (e) => e.personality, ['personality']);
  field('charScenario', (e) => e.scenario, ['scenario']);
  field('persona', (e) => e.persona);
  field('mesExamples', (e) => e.mesExamples);
  field('mesExamplesRaw', (e) => e.mesExamplesRaw);
  field('charDepthPrompt', (e) => e.charDepthPrompt);
  field('charCreatorNotes', (e) => e.creatorNotes, ['creatorNotes']);
  field('charVersion', (e) => e.charVersion, ['version', 'char_version']);
  field('model', (e) => e.model);
  registry.register('original', {
    maxArgs: 0,
    handler: (c) => {
      // Without an original text the macro stays as written, to be filled in by a later pass
      // (a card's system prompt is expanded before the preset's main prompt is known).
      if (c.env.original === undefined) throw new Error('no original text');
      const state = (c.env as MacroEnv & { [ORIGINAL_STATE]?: { used: boolean } })[ORIGINAL_STATE];
      if (state?.used) return '';
      if (state) state.used = true;
      return c.env.original;
    },
  });
  field('systemPrompt', (e) => e.systemPrompt);
  field('isMobile', (e) => String(Boolean(e.isMobile)));
  registry.register('charFirstMessage', {
    maxArgs: 1,
    aliases: ['greeting'],
    handler: (c) => {
      if (c.args[0] === undefined || c.args[0] === '') return c.env.firstMessage ?? '';
      const index = Number(c.args[0]);
      if (!Number.isInteger(index) || index < 0) return '';
      return index === 0 ? (c.env.firstMessage ?? '') : (c.env.alternateGreetings?.[index - 1] ?? '');
    },
  });

  // Chat state
  registry
    .register('lastMessage', { maxArgs: 0, handler: (c) => c.env.messages?.at(-1)?.text ?? '' })
    .register('lastMessageId', {
      maxArgs: 0,
      handler: (c) => (c.env.messages?.length ? String(c.env.messages.length - 1) : ''),
    })
    .register('lastUserMessage', {
      maxArgs: 0,
      handler: (c) => lastMatching(c.env, (m) => m.role === 'user' && !m.hidden)?.text ?? '',
    })
    .register('lastCharMessage', {
      maxArgs: 0,
      handler: (c) => lastMatching(c.env, (m) => m.role === 'assistant' && !m.hidden)?.text ?? '',
    })
    .register('firstIncludedMessageId', {
      maxArgs: 0,
      handler: (c) => String(c.env.firstIncludedMessageId ?? ''),
    })
    .register('firstDisplayedMessageId', {
      maxArgs: 0,
      handler: (c) => String(c.env.firstDisplayedMessageId ?? ''),
    })
    .register('lastSwipeId', { maxArgs: 0, handler: (c) => String(c.env.messages?.at(-1)?.swipeCount ?? '') })
    .register('currentSwipeId', {
      maxArgs: 0,
      handler: (c) => {
        const last = c.env.messages?.at(-1);
        return last ? String(last.swipeId + 1) : '';
      },
    })
    .register('allChatRange', {
      maxArgs: 0,
      handler: (c) => (c.env.messages?.length ? `0-${c.env.messages.length - 1}` : ''),
    })
    .register('lastGenerationType', { maxArgs: 0, handler: (c) => c.env.lastGenerationType ?? 'normal' })
    .register('hasExtension', {
      minArgs: 1,
      maxArgs: 1,
      handler: (c) => String(Boolean(c.env.extensions?.includes(c.args[0]!))),
    });

  // Time
  registry
    .register('time', {
      maxArgs: 1,
      handler: (c) => {
        const offset = c.args[0];
        const date = offset ? shiftToUtcOffset(now(c.env), offset) : now(c.env);
        return date ? formatDate(date, 'LT') : '';
      },
    })
    .register('date', { maxArgs: 0, handler: (c) => formatDate(now(c.env), 'LL') })
    .register('weekday', { maxArgs: 0, handler: (c) => formatDate(now(c.env), 'dddd') })
    .register('isotime', { maxArgs: 0, handler: (c) => formatDate(now(c.env), 'HH:mm') })
    .register('isodate', { maxArgs: 0, handler: (c) => formatDate(now(c.env), 'YYYY-MM-DD') })
    .register('datetimeformat', {
      minArgs: 1,
      maxArgs: 1,
      handler: (c) => formatDate(now(c.env), c.args[0]!),
    })
    .register('idleDuration', {
      maxArgs: 0,
      aliases: ['idle_duration'],
      handler: (c) => c.env.idleDuration ?? 'just now',
    })
    .register('timeDiff', {
      minArgs: 2,
      maxArgs: 2,
      handler: (c) => {
        const a = Date.parse(c.args[0]!);
        const b = Date.parse(c.args[1]!);
        if (Number.isNaN(a) || Number.isNaN(b)) return '';
        return `${humanizeDuration(a - b)}${a < b ? ' ago' : ''}`;
      },
    });

  registerVariableMacros(registry, false);
  registerVariableMacros(registry, true);
  return registry;
}

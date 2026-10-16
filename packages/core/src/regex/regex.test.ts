import { describe, expect, it } from 'vitest';

import { createMacroEngine } from '../macros/index.ts';
import {
  activeRegexScripts,
  getRegexedString,
  migrateRegexScript,
  newRegexScript,
  regexFromString,
  RegexPlacement,
  runRegexScript,
  SubstituteRegex,
  type RegexScript,
  type RegexSubstitute,
} from './index.ts';

const macros = createMacroEngine();
const substitute: RegexSubstitute = (text, options) =>
  macros.evaluate(text, {
    user: 'Mika',
    char: options?.charName ?? 'Aiko',
    postProcess: options?.postProcess,
  });

const script = (overrides: Partial<RegexScript>): RegexScript =>
  newRegexScript('id', { scriptName: 'test', placement: [RegexPlacement.AI_OUTPUT], ...overrides });

describe('regexFromString', () => {
  it('parses slash-delimited patterns with flags', () => {
    const regex = regexFromString('/a+b/gi')!;
    expect(regex.source).toBe('a+b');
    expect(regex.flags).toBe('gi');
  });

  it('treats a bare pattern as a regex without flags', () => {
    const regex = regexFromString('cat')!;
    expect(regex.source).toBe('cat');
    expect(regex.global).toBe(false);
  });

  it('falls back to a literal pattern when the flags are invalid', () => {
    expect(regexFromString('/x/gg')!.test('/x/gg')).toBe(true);
  });

  it('returns undefined for an invalid regex', () => {
    expect(regexFromString('/(/g')).toBeUndefined();
    expect(regexFromString('')).toBeUndefined();
  });
});

describe('runRegexScript', () => {
  it('replaces with numbered and named groups and {{match}}', () => {
    const swap = script({ findRegex: '/(\\w+) (\\w+)/', replaceString: '$2 $1 ({{match}})' });
    expect(runRegexScript(swap, 'hello world!', substitute)).toBe('world hello (hello world)!');
    const named = script({ findRegex: '/(?<word>\\w+)!/g', replaceString: '[$<word>]' });
    expect(runRegexScript(named, 'hi! yo!', substitute)).toBe('[hi] [yo]');
  });

  it('drops groups that did not participate', () => {
    const optional = script({ findRegex: '/a(b)?c/', replaceString: '<$1>' });
    expect(runRegexScript(optional, 'ac', substitute)).toBe('<>');
  });

  it('keeps $$ and $& literally, as SillyTavern does', () => {
    const literal = script({ findRegex: '/x/', replaceString: '$$ $&' });
    expect(runRegexScript(literal, 'x', substitute)).toBe('$$ $&');
  });

  it('removes trim strings from captured text, with {{char}} as the message author', () => {
    const trim = script({
      findRegex: '/<b>(.*?)<\\/b>/g',
      replaceString: '**$1**',
      trimStrings: ['{{char}}: '],
    });
    expect(runRegexScript(trim, '<b>Rin: hi</b>', substitute, { characterOverride: 'Rin' })).toBe('**hi**');
    expect(runRegexScript(trim, '<b>Rin: hi</b>', substitute)).toBe('**Rin: hi**');
  });

  it('expands macros in the replacement', () => {
    const greet = script({ findRegex: '/hello/', replaceString: 'hello {{user}}' });
    expect(runRegexScript(greet, 'hello', substitute)).toBe('hello Mika');
  });

  it('substitutes macros in the find regex, raw or escaped', () => {
    const raw = script({
      findRegex: '/{{user}}/g',
      replaceString: 'you',
      substituteRegex: SubstituteRegex.RAW,
    });
    expect(runRegexScript(raw, 'Mika and Mika', substitute)).toBe('you and you');
    const none = script({ findRegex: '/{{user}}/g', replaceString: 'you' });
    expect(runRegexScript(none, 'Mika', substitute)).toBe('Mika');
    const dotted = (sub: number) =>
      script({ findRegex: '/{{getvar::v}}/g', replaceString: '!', substituteRegex: sub });
    const withVar: RegexSubstitute = (text, options) =>
      macros.evaluate(text, {
        user: 'Mika',
        char: 'Aiko',
        localVariables: {
          get: () => 'a.c',
          set: () => {},
          has: () => true,
          delete: () => {},
        },
        postProcess: options?.postProcess,
      });
    expect(runRegexScript(dotted(SubstituteRegex.RAW), 'abc a.c', withVar)).toBe('! !');
    expect(runRegexScript(dotted(SubstituteRegex.ESCAPED), 'abc a.c', withVar)).toBe('abc !');
  });

  it('accepts legacy boolean substituteRegex', () => {
    const legacy = script({ findRegex: '/{{char}}/', replaceString: 'her', substituteRegex: true });
    expect(runRegexScript(legacy, 'Aiko smiles', substitute)).toBe('her smiles');
  });

  it('does nothing when disabled or without a find regex', () => {
    expect(runRegexScript(script({ findRegex: '/a/', disabled: true }), 'a', substitute)).toBe('a');
    expect(runRegexScript(script({ findRegex: '' }), 'a', substitute)).toBe('a');
  });
});

describe('getRegexedString', () => {
  const plain = script({ findRegex: '/a/g', replaceString: 'b' });
  const display = script({ findRegex: '/b/g', replaceString: 'c', markdownOnly: true });
  const prompt = script({ findRegex: '/a/g', replaceString: 'p', promptOnly: true });

  it('picks scripts by display, prompt or plain text', () => {
    const scripts = [plain, display, prompt];
    expect(getRegexedString('ab', RegexPlacement.AI_OUTPUT, scripts, substitute)).toBe('bb');
    expect(getRegexedString('ab', RegexPlacement.AI_OUTPUT, scripts, substitute, { isMarkdown: true })).toBe(
      'ac',
    );
    expect(getRegexedString('ab', RegexPlacement.AI_OUTPUT, scripts, substitute, { isPrompt: true })).toBe(
      'pb',
    );
  });

  it('honours placement, run-on-edit and depth limits', () => {
    expect(getRegexedString('a', RegexPlacement.USER_INPUT, [plain], substitute)).toBe('a');
    const noEdit = { ...plain, runOnEdit: false };
    expect(getRegexedString('a', RegexPlacement.AI_OUTPUT, [noEdit], substitute, { isEdit: true })).toBe('a');
    const shallow = { ...prompt, minDepth: 1, maxDepth: 2 };
    const at = (depth: number) =>
      getRegexedString('a', RegexPlacement.AI_OUTPUT, [shallow], substitute, { isPrompt: true, depth });
    expect([at(0), at(1), at(2), at(3)]).toEqual(['a', 'p', 'p', 'a']);
    // -1 is the message being continued.
    const continued = { ...prompt, minDepth: -1 };
    expect(
      getRegexedString('a', RegexPlacement.AI_OUTPUT, [continued], substitute, { isPrompt: true, depth: -1 }),
    ).toBe('p');
  });

  it('runs scripts in order, each on the previous output', () => {
    const second = script({ findRegex: '/b/g', replaceString: 'c' });
    expect(getRegexedString('a', RegexPlacement.AI_OUTPUT, [plain, second], substitute)).toBe('c');
  });
});

describe('activeRegexScripts', () => {
  it('orders global, preset and character scripts and skips disallowed ones', () => {
    const g = script({ scriptName: 'g' });
    const p = script({ scriptName: 'p' });
    const c = script({ scriptName: 'c' });
    const names = (list: RegexScript[]) => list.map((s) => s.scriptName);
    expect(
      names(
        activeRegexScripts({
          global: [g],
          preset: [p],
          presetAllowed: true,
          character: [c],
          characterAllowed: true,
        }),
      ),
    ).toEqual(['g', 'p', 'c']);
    expect(names(activeRegexScripts({ global: [g], preset: [p], character: [c] }))).toEqual(['g']);
  });
});

describe('migrateRegexScript', () => {
  it('turns the old Markdown display placement into display and prompt flags', () => {
    const migrated = migrateRegexScript(
      { scriptName: 'old', findRegex: '/a/', placement: [0] } as Partial<RegexScript>,
      () => 'new-id',
    );
    expect(migrated.id).toBe('new-id');
    expect(migrated.placement).toEqual([1, 2, 3, 5, 6]);
    expect(migrated.markdownOnly && migrated.promptOnly).toBe(true);
    expect(migrateRegexScript({ placement: [4] }, () => 'x').placement).toEqual([
      RegexPlacement.SLASH_COMMAND,
    ]);
    expect(migrateRegexScript({ placement: [2, 4] }, () => 'x').placement).toEqual([2]);
  });
});

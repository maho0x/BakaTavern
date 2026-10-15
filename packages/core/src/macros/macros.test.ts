import { describe, expect, it } from 'vitest';

import { createMacroEngine, objectVariables, type MacroEnv } from './index.ts';

const engine = createMacroEngine();

function env(overrides: Partial<MacroEnv> = {}): MacroEnv {
  return {
    user: 'Alice',
    char: 'Seraphina',
    description: 'A forest guardian.',
    personality: '',
    now: () => new Date(2026, 9, 14, 23, 56, 7),
    ...overrides,
  };
}

const run = (text: string, overrides?: Partial<MacroEnv>) => engine.evaluate(text, env(overrides));

describe('basic macros', () => {
  it('replaces names and fields, case-insensitively', () => {
    expect(run('{{user}} meets {{char}}. {{Char}}: {{description}}')).toBe(
      'Alice meets Seraphina. Seraphina: A forest guardian.',
    );
  });

  it('keeps unknown macros and plain braces', () => {
    expect(run('{{unknownThing}} {notAMacro} {{{user}}}')).toBe('{{unknownThing}} {notAMacro} {Alice}');
  });

  it('supports legacy angle-bracket names', () => {
    expect(run('<USER> and <BOT>')).toBe('Alice and Seraphina');
  });

  it('handles newline/space counts, comments and noop', () => {
    expect(run('a{{newline::2}}b{{space}}c{{// hidden}}{{noop}}')).toBe('a\n\nb c');
    expect(run('x{{//}}\nmulti\nline{{///}}y')).toBe('xy');
  });

  it('resolves nested macros inside arguments', () => {
    const local: Record<string, unknown> = {};
    expect(run('{{setvar::who::{{char}}}}{{getvar::who}}', { localVariables: objectVariables(local) })).toBe(
      'Seraphina',
    );
    expect(local.who).toBe('Seraphina');
    expect(run('{{reverse::{{user}}}}')).toBe('ecilA');
  });

  it('formats time and dates', () => {
    expect(run('{{isodate}} {{isotime}} {{weekday}}')).toBe('2026-10-14 23:56 Wednesday');
    expect(run('{{date}} at {{time}}')).toBe('October 14, 2026 at 11:56 PM');
    expect(run('{{datetimeformat YYYY/MM/DD [at] HH:mm:ss}}')).toBe('2026/10/14 at 23:56:07');
  });
});

describe('if / else', () => {
  it('chooses branches and inverts', () => {
    expect(run('{{if description}}Has desc{{else}}None{{/if}}')).toBe('Has desc');
    expect(run('{{if personality}}Has{{else}}None{{/if}}')).toBe('None');
    expect(run('{{if !personality}}Missing{{/if}}')).toBe('Missing');
    expect(run('{{if 0}}yes{{else}}no{{/if}}')).toBe('no');
  });

  it('nests and dedents scoped content', () => {
    const text = '{{if char}}\n  # {{char}}\n  {{if user}}\n    with {{user}}\n  {{/if}}\n{{/if}}';
    expect(run(text)).toBe('# Seraphina\nwith Alice');
  });

  it('only evaluates the chosen branch', () => {
    const local: Record<string, unknown> = { count: 1 };
    run('{{if false}}{{incvar::count}}{{else}}{{.count += 10}}{{/if}}', {
      localVariables: objectVariables(local),
    });
    expect(local.count).toBe(11);
  });

  it('preserves whitespace with the # flag', () => {
    expect(run('[{{#if char}}  padded  {{/if}}]')).toBe('[  padded  ]');
  });
});

describe('variables', () => {
  it('implements shorthand operators', () => {
    const local: Record<string, unknown> = {};
    const global: Record<string, unknown> = { flag: 'on' };
    const vars = { localVariables: objectVariables(local), globalVariables: objectVariables(global) };
    expect(run('{{.hp = 10}}{{.hp -= 3}}{{.hp}}', vars)).toBe('7');
    expect(run('{{.hp++}}', vars)).toBe('8');
    expect(run('{{.missing ?? fallback}}|{{.hp ?? fallback}}', vars)).toBe('fallback|8');
    expect(run('{{.hp > 5}} {{.hp == 8}} {{.hp != 8}}', vars)).toBe('true true false');
    expect(run('{{if $flag}}global on{{/if}}', vars)).toBe('global on');
    expect(run('{{.name ||= Bob}}{{.name}}', vars)).toBe('BobBob');
    expect(run('{{.list = ["a"]}}{{addvar::list::b}}{{getvar::list}}', vars)).toBe('["a","b"]');
    expect(
      run(
        '{{.stats = {"str": 5, "items": ["x", "y"]} }}{{getvar::stats.str}}/{{getvar::stats.items[1]}}',
        vars,
      ),
    ).toBe('5/y');
    // Arguments are trimmed (as in SillyTavern), so strings concatenate without the leading space.
    expect(run('{{addvar::greeting::Hello}}{{addvar::greeting:: world}}{{getvar::greeting}}', vars)).toBe(
      'Helloworld',
    );
    expect(run('{{hasvar::hp}} {{deletevar::hp}}{{hasvar::hp}}', vars)).toBe('true false');
  });
});

describe('random and pick', () => {
  it('pick is stable for the same chat and position', () => {
    const a = run('{{pick::a::b::c::d::e}}', { chatId: 'chat-1' });
    const b = run('{{pick::a::b::c::d::e}}', { chatId: 'chat-1' });
    expect(a).toBe(b);
    expect(['a', 'b', 'c', 'd', 'e']).toContain(a);
  });

  it('random supports legacy comma lists', () => {
    expect(run('{{random:x,y}}', { random: () => 0.99 })).toBe('y');
    expect(run('{{random::only}}')).toBe('only');
  });

  it('rolls dice', () => {
    expect(run('{{roll 2d6+3}}', { random: () => 0 })).toBe('5');
    expect(run('{{roll::20}}', { random: () => 0.999 })).toBe('20');
  });
});

describe('trim and greetings', () => {
  it('removes newlines around the non-scoped trim', () => {
    expect(run('line one\n\n{{trim}}\n\nline two')).toBe('line oneline two');
  });

  it('indexes alternate greetings', () => {
    const e = { firstMessage: 'Hi!', alternateGreetings: ['Hello again', 'Yo'] };
    expect(run('{{greeting}}|{{greeting::0}}|{{greeting::2}}|{{greeting::9}}', e)).toBe('Hi!|Hi!|Yo|');
  });

  it('collects banned words', () => {
    const bannedWords: string[] = [];
    expect(run('a{{banned "delve"}}b', { bannedWords })).toBe('ab');
    expect(bannedWords).toEqual(['delve']);
  });
});

describe('{{original}}', () => {
  it('stays as written until an original text is known', () => {
    // A card's system prompt is expanded first; the preset's main prompt fills in {{original}} later.
    const card = run('{{original}}\n{{char}} stays in the café.');
    expect(card).toBe('{{original}}\nSeraphina stays in the café.');
    expect(run(card, { original: 'Write the reply.' })).toBe(
      'Write the reply.\nSeraphina stays in the café.',
    );
  });

  it('is substituted once per evaluation', () => {
    expect(run('{{original}} / {{original}}', { original: 'X' })).toBe('X / ');
    expect(run('{{original}}', { original: 'X' })).toBe('X');
  });
});

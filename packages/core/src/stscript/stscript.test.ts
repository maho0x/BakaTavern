import { describe, expect, it } from 'vitest';

import { createMacroEngine, objectVariables } from '../macros/index.ts';
import { registerBuiltinCommands } from './builtins.ts';
import { Stscript } from './runtime.ts';

function setup() {
  const local: Record<string, unknown> = {};
  const global: Record<string, unknown> = {};
  const toasts: string[] = [];
  const st = new Stscript({
    macros: createMacroEngine(),
    env: () => ({
      user: 'User',
      char: 'Aiko',
      localVariables: objectVariables(local),
      globalVariables: objectVariables(global),
    }),
    variables: () => ({ local: objectVariables(local), global: objectVariables(global) }),
    ui: {
      toast: (text) => void toasts.push(text),
      popup: async () => {},
      systemMessage: async () => {},
    },
  });
  registerBuiltinCommands(st);
  const run = async (script: string) => (await st.execute(script))?.pipe;
  return { st, run, local, global, toasts };
}

describe('STscript', () => {
  it('pipes values from command to command', async () => {
    const { run } = setup();
    expect(await run('/pass hello | /upper')).toBe('HELLO');
    expect(await run('/pass hello || /pass')).toBe('');
    expect(await run('/pass a | /pass {{pipe}}b | /pass {{pipe}}c')).toBe('abc');
    expect(await run('/pass {{char}} meets {{user}}')).toBe('Aiko meets User');
  });

  it('keeps escaped pipes and closures as text', async () => {
    const { run } = setup();
    expect(await run('/pass a \\| b')).toBe('a | b');
    expect(await run('/pass \\{: x :\\}')).toBe('{: x :}');
  });

  it('skips comments', async () => {
    const { run } = setup();
    expect(await run('/pass 1 | // a comment | /pass 2')).toBe('2');
    expect(await run('/pass 1 | /* block\ncomment *| /pass 3')).toBe('3');
  });

  it('reads and writes chat and global variables', async () => {
    const { run, local, global } = setup();
    expect(await run('/setvar key=x 5 | /addvar key=x 3 | /getvar x')).toBe('8');
    expect(local.x).toBe(8);
    await run('/setglobalvar key=list ["a"] | /addglobalvar key=list b');
    expect(global.list).toBe('["a","b"]');
    expect(await run('/setvar key=obj {"a":{"b":1}} | /getvar key=obj index=a')).toBe('{"b":1}');
    expect(await run('/setvar key=ages index=John as=number 21 | /getvar key=ages index=John')).toBe('21');
    expect(await run('/incvar n | /incvar n | /decvar n')).toBe('1');
    await run('/flushvar n');
    expect('n' in local).toBe(false);
    expect(await run('/pass {{getvar::x}}')).toBe('8');
  });

  it('scopes variables to closures', async () => {
    const { run } = setup();
    expect(await run('/let a 1 | /var a 2 | /var a')).toBe('2');
    expect(await run('/let x outer | /run {: /let x inner | /pass {{var::x}} :}')).toBe('inner');
    expect(await run('/let f {: a=1 b=2 /pass {{var::a}}+{{var::b}} :} | /run b=5 f')).toBe('1+5');
    expect(await run('/let key=k value with spaces | /var k')).toBe('value with spaces');
    await expect(run('/let a 1 | /let a 2')).rejects.toThrow('already exists');
  });

  it('branches and loops', async () => {
    const { run } = setup();
    expect(await run('/if left=1 rule=lt right=2 else={: /pass no :} {: /pass yes :}')).toBe('yes');
    expect(await run('/if left=abc rule=in right=b "/pass found"')).toBe('found');
    expect(await run('/if left=x rule=eq right=y else={: /pass no :} {: /pass yes :}')).toBe('no');
    expect(await run('/times 3 {: /addvar key=c 1 :} | /getvar c')).toBe('3');
    expect(await run('/times 3 {: /pass {{timesIndex}} :}')).toBe('2');
    expect(await run('/setvar key=i 0 | /while left=i rule=lt right=5 {: /incvar i :} | /getvar i')).toBe(
      '5',
    );
    expect(await run('/times 10 {: /incvar t | /if left=t rule=gte right=3 {: /break done :} :}')).toBe(
      'done',
    );
  });

  it('does math like SillyTavern', async () => {
    const { run } = setup();
    expect(await run('/add 1 2 3')).toBe('6');
    expect(await run('/sub 10 3 2')).toBe('5');
    expect(await run('/div 10 4')).toBe('2.5');
    expect(await run('/div 1 0')).toBe('0');
    expect(await run('/setvar key=v 7 | /mul v 2')).toBe('14');
    expect(await run('/add [1, 2, 3]')).toBe('6');
    expect(await run('/round 2.5')).toBe('3');
    expect(await run('/max 1 9 3')).toBe('9');
    expect(await run('/pow 2 10')).toBe('1024');
    expect(await run('/rand from=3 to=3')).toBe('3');
  });

  it('handles text, lists and patterns', async () => {
    const { run } = setup();
    expect(await run('/len hello')).toBe('5');
    expect(await run('/len ["a","b"]')).toBe('2');
    expect(await run('/sort [3,1,2]')).toBe('[1,2,3]');
    expect(await run('/replace mode=regex pattern=/a/g replacer=o banana')).toBe('bonono');
    expect(await run('/replace pattern=na replacer=NA banana')).toBe('baNANA');
    expect(await run('/test pattern=/^b/ banana')).toBe('true');
    expect(await run('/match pattern=/(a)(n)/ banana')).toBe('["an","a","n"]');
    expect(await run('/substr start=1 end=3 hello')).toBe('el');
    expect(await run('/array-wrap foo')).toBe('["foo"]');
    expect(await run('/array-unwrap ["x","y"]')).toBe('x');
    expect(await run('/fuzzy list=["apple","banana"] mode=best banan')).toBe('banana');
    expect(await run('/trimstart Hi. There you are.')).toBe('There you are.');
  });

  it('aborts and reports errors', async () => {
    const { st, run, toasts } = setup();
    const result = await st.execute('/pass 1 | /abort quiet=false Stopped here | /pass 2');
    expect(result?.isAborted).toBe(true);
    expect(toasts).toContain('Stopped here');
    const parsed = await st.execute('/nonexistent');
    expect(parsed?.isError).toBe(true);
    expect(await run('/pass {: /pass inner :}() | /pass got {{pipe}}')).toBe('got inner');
  });

  it('serializes closures', async () => {
    const { run } = setup();
    expect(await run('/closure-serialize {: /pass x :}')).toBe(' /pass x ');
    expect(await run('/closure-deserialize /pass y | /run')).toBe('y');
  });
});

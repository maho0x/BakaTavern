import { describe, expect, it } from 'vitest';

import {
  isFrontend,
  messageDocument,
  replaceViewportHeight,
  scriptDocument,
  splitFrontend,
} from './document.ts';
import type { FrameConfig } from './protocol.ts';

const config = {
  name: 'TH-message--3--0',
  kind: 'message',
  token: 'abc',
  messageId: 3,
  viewportHeight: 800,
  globals: {},
  state: {
    chatId: 'c1',
    messages: [],
    variables: { global: {}, chat: {}, character: null, preset: {} },
    user: { name: 'Mika', avatarUrl: '/u.png', persona: '' },
    character: null,
    group: null,
    characters: [],
    personas: [],
    lorebooks: { names: [], global: [], chat: null, character: { primary: null, additional: [] } },
    regex: { global: [], character: [], preset: [], characterEnabled: false, presetEnabled: false },
    scripts: {},
    generating: false,
  },
} satisfies FrameConfig;

describe('splitFrontend', () => {
  it('turns code blocks holding a page into frames and leaves the rest as text', () => {
    const text = 'Hello\n```html\n<html><body>Bar</body></html>\n```\nAfter\n```js\nconst x = 1;\n```';
    expect(splitFrontend(text)).toEqual([
      { kind: 'text', text: 'Hello' },
      { kind: 'frontend', code: '<html><body>Bar</body></html>' },
      { kind: 'text', text: 'After\n```js\nconst x = 1;\n```' },
    ]);
  });

  it('detects pages as TavernHelper does', () => {
    expect(isFrontend('<body>')).toBe(true);
    expect(isFrontend('<!DOCTYPE html>')).toBe(true);
    expect(isFrontend('<div>no</div>')).toBe(false);
  });

  it('runs an unclosed fence to the end and leaves plain text alone', () => {
    expect(splitFrontend('a\n~~~\n<head></head>')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'frontend', code: '<head></head>' },
    ]);
    expect(splitFrontend('just text')).toEqual([{ kind: 'text', text: 'just text' }]);
  });
});

describe('documents', () => {
  it('measures vh heights against the page', () => {
    expect(replaceViewportHeight('.a{min-height:100vh}')).toBe('.a{min-height:var(--TH-viewport-height)}');
    expect(replaceViewportHeight('<div style="min-height: 50vh">')).toBe(
      '<div style="min-height: calc(var(--TH-viewport-height) * 0.5)">',
    );
    expect(replaceViewportHeight('el.style.minHeight = "80vh"')).toBe(
      'el.style.minHeight = "calc(var(--TH-viewport-height) * 0.8)"',
    );
    expect(replaceViewportHeight('.a{height:100vh}')).toBe('.a{height:100vh}');
  });

  it('starts the runtime with its configuration, safely embedded', () => {
    const doc = messageDocument('<body>hi</script></body>', {
      runtimeUrl: '/th.js',
      cdn: false,
      config: { ...config, state: { ...config.state, chatId: '</script><b>' } },
    });
    expect(doc).toContain('<script src="/th.js"></script>');
    expect(doc).toContain('\\u003c/script>\\u003cb>');
    expect(doc).not.toContain('jsdelivr');
    expect(doc).toContain("background-image:url('/u.png')");
  });

  it('runs scripts as modules, without their code fence', () => {
    const doc = scriptDocument('```js\nconsole.log(1)\n```', { runtimeUrl: '/th.js', cdn: true, config });
    expect(doc).toContain('<script type="module">\nconsole.log(1)\n</script>');
    expect(doc).toContain('jsdelivr');
  });
});

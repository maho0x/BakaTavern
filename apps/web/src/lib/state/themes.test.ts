import { describe, expect, it } from 'vitest';

import { themeFromSt } from './themes.ts';

describe('themeFromSt', () => {
  it('maps SillyTavern colors and display options', () => {
    const style = themeFromSt({
      name: 'Cappuccino',
      main_text_color: 'rgba(235, 235, 235, 1)',
      italics_text_color: 'rgba(230, 210, 190, 1)',
      quote_text_color: 'rgba(165, 140, 115, 1)',
      blur_tint_color: 'rgba(34, 30, 32, 0.95)',
      chat_tint_color: 'rgba(50, 45, 50, 0.75)',
      border_color: 'rgba(80, 80, 80, 0.89)',
      font_scale: 1.1,
      chat_width: 50,
      timestamps_enabled: true,
      message_token_count_enabled: false,
      custom_css: '.mes { padding: 0 }',
    });
    expect(style.colors['--bt-ink']).toBe('rgba(235, 235, 235, 1)');
    expect(style.colors['--bt-action']).toBe('rgba(230, 210, 190, 1)');
    expect(style.colors['--bt-dialogue']).toBe('rgba(165, 140, 115, 1)');
    expect(style.colors['--bt-bg']).toBe('rgb(50, 45, 50)');
    expect(style.colors['--bt-surface']).toBe('rgb(34, 30, 32)');
    expect(style.colors['--bt-ink-muted']).toContain('color-mix');
    expect(style.ui).toEqual({
      textScale: 1.1,
      chatWidth: 46,
      showTimestamps: true,
      showTokenCounts: false,
      customCss: '.mes { padding: 0 }',
    });
  });

  it('leaves out what a theme does not set', () => {
    expect(themeFromSt({ name: 'Empty' })).toEqual({ colors: {}, ui: {} });
    expect(themeFromSt(null)).toEqual({ colors: {}, ui: {} });
  });
});

/**
 * SillyTavern themes (`themes/*.json`, kept as presets of kind `theme`): their colors become this
 * app's color tokens, their display options its UI settings. Selectors in their custom CSS refer
 * to SillyTavern's page and mostly have no effect here.
 */

import type { UiPrefs } from './prefs.ts';

export const THEME_KIND = 'theme';

export interface ThemeStyle {
  /** CSS custom properties to set on the page. */
  colors: Record<string, string>;
  ui: Partial<UiPrefs>;
}

const color = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** `rgba(r, g, b, a)` without its transparency (other forms are kept). */
function opaque(value: string | null): string | null {
  const match = value?.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)$/i);
  return match ? `rgb(${match[1]}, ${match[2]}, ${match[3]})` : value;
}

/** What a SillyTavern theme changes here. */
export function themeFromSt(json: unknown): ThemeStyle {
  const theme = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const colors: Record<string, string> = {};
  const set = (token: string, value: string | null) => {
    if (value) colors[token] = value;
  };
  const ink = color(theme.main_text_color);
  const bg = color(theme.chat_tint_color);
  const surface = color(theme.blur_tint_color);
  const solid = opaque(bg) ?? opaque(surface);
  set('--bt-ink', ink);
  set('--bt-action', color(theme.italics_text_color));
  set('--bt-underline', color(theme.underline_text_color));
  set('--bt-dialogue', color(theme.quote_text_color));
  set('--bt-line', color(theme.border_color));
  // Tints are often translucent (over a background picture); the page needs them opaque.
  set('--bt-bg', opaque(bg));
  set('--bt-surface', opaque(surface));
  set('--bt-user-tint', color(theme.user_mes_blur_tint_color));
  set('--bt-bot-tint', color(theme.bot_mes_blur_tint_color));
  if (ink && solid) {
    set('--bt-ink-muted', `color-mix(in oklch, ${ink} 72%, ${solid})`);
    set('--bt-ink-faint', `color-mix(in oklch, ${ink} 52%, ${solid})`);
  }
  if (surface && ink) {
    set('--bt-surface-2', `color-mix(in oklch, ${opaque(surface)}, ${ink} 6%)`);
    set('--bt-surface-3', `color-mix(in oklch, ${opaque(surface)}, ${ink} 11%)`);
  }

  const ui: Partial<UiPrefs> = {};
  const scale = Number(theme.font_scale);
  if (Number.isFinite(scale) && scale > 0) ui.textScale = Math.min(1.4, Math.max(0.8, scale));
  const width = Number(theme.chat_width);
  // SillyTavern's width is a share of the window (50 = its default); ours is in rem (46 = ours).
  if (Number.isFinite(width) && width > 0)
    ui.chatWidth = Math.round(Math.min(80, Math.max(30, (width / 50) * 46)));
  if (typeof theme.timestamps_enabled === 'boolean') ui.showTimestamps = theme.timestamps_enabled;
  if (typeof theme.message_token_count_enabled === 'boolean')
    ui.showTokenCounts = theme.message_token_count_enabled;
  if (typeof theme.custom_css === 'string') ui.customCss = theme.custom_css;
  return { colors, ui };
}

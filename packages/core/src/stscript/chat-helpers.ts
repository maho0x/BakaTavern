/** Small SillyTavern helpers the chat commands share. */

import { loadHandlebars, renderTemplate } from '../prompt/handlebars.ts';

/** `"3"` or `"2-5"` within [min, max] (SillyTavern `stringToRange`); null when invalid. */
export function stringToRange(
  input: unknown,
  min: number,
  max: number,
): { start: number; end: number } | null {
  const text = String(input);
  let start: number;
  let end: number;
  if (text.includes('-')) {
    const [a, b] = text.split('-');
    start = a ? parseInt(a, 10) : Number.NaN;
    end = b ? parseInt(b, 10) : Number.NaN;
  } else {
    start = end = parseInt(text, 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < min || end > max) return null;
  return { start, end };
}

/** Text without its `{{macros}}` (SillyTavern `removeMacros`). */
export function removeMacros(text: string): string {
  return (text ?? '').replace(/\{\{[\s\S]*?\}\}/gm, '').trim();
}

/**
 * `{{bias "text"}}` in a message: what the reply should start with (SillyTavern
 * `extractMessageBias`). Empty when there is none or the text is not a valid template.
 */
export async function extractMessageBias(message: string): Promise<string> {
  if (!message) return '';
  try {
    const handlebars = await loadHandlebars();
    const matches: unknown[] = [];
    renderTemplate(
      handlebars,
      message,
      {},
      {
        bias: (text: unknown) => {
          matches.push(text);
          return '';
        },
      },
    );
    return matches.length ? ` ${matches.join(' ')}` : '';
  } catch {
    return '';
  }
}

/** A depth (`-1` = the last message) or an index, as an index (`at=` arguments). */
export function resolveIndex(at: unknown, length: number): number {
  let index = Number(at);
  if (!Number.isNaN(index) && (index < 0 || Object.is(index, -0))) index = length + index;
  return index;
}

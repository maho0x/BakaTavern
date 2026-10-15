/** Post-processing of model output (port of SillyTavern `cleanUpMessage` and reasoning parsing). */

export interface CleanupOptions {
  isImpersonate: boolean;
  isContinue: boolean;
  stoppingStrings: readonly string[];
  /** Name that must not start the reply (the user's name for normal replies). */
  wrongName?: string;
  collapseNewlines?: boolean;
  /** "Start reply with" text, prepended unless impersonating or continuing. */
  promptBias?: string;
  applyRegex?: (text: string) => string;
}

export function cleanUpMessage(text: string, options: CleanupOptions): string {
  if (!text) return '';
  let message = text;
  if (options.promptBias && !options.isImpersonate && !options.isContinue)
    message = options.promptBias + message;

  // Remove a stopping string, or a partial one dangling at the end.
  for (const stop of options.stoppingStrings) {
    if (!stop.length) continue;
    const at = message.indexOf(stop);
    if (at >= 0) {
      message = message.slice(0, at);
      continue;
    }
    for (let j = stop.length; j > 0; j--) {
      if (message.slice(-j) === stop.slice(0, j)) {
        message = message.slice(0, -j);
        break;
      }
    }
  }
  if (options.applyRegex) message = options.applyRegex(message);
  if (options.collapseNewlines) message = message.replaceAll(/\n+/g, '\n');
  message = message.replace(/[^\S\r\n]+$/gm, '');
  if (options.wrongName) {
    if (message.indexOf(`${options.wrongName}:`) === 0) message = '';
    const trailing = message.indexOf(`\n${options.wrongName}:`);
    if (trailing >= 0) message = message.substring(0, trailing);
  }
  const eot = message.indexOf('<|endoftext|>');
  if (eot >= 0) message = message.substring(0, eot);
  return message;
}

export interface ReasoningTemplate {
  prefix: string;
  suffix: string;
}

export const DEFAULT_REASONING_TEMPLATE: ReasoningTemplate = { prefix: '<think>\n', suffix: '\n</think>' };

/**
 * Splits a leading reasoning block (`<think>...</think>`) off a reply. Works on partial streams:
 * an unterminated block is returned as reasoning with `complete: false`.
 */
export function extractReasoning(
  text: string,
  template: ReasoningTemplate = DEFAULT_REASONING_TEMPLATE,
): { reasoning: string; content: string; complete: boolean } | null {
  const prefix = template.prefix.trim();
  const suffix = template.suffix.trim();
  if (!prefix || !suffix) return null;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  const end = rest.indexOf(suffix);
  if (end < 0) return { reasoning: rest.trim(), content: '', complete: false };
  return {
    reasoning: rest.slice(0, end).trim(),
    content: rest.slice(end + suffix.length).trimStart(),
    complete: true,
  };
}

/** Post-processing of model output (port of SillyTavern `cleanUpMessage` and reasoning parsing). */

export interface CleanupOptions {
  isImpersonate: boolean;
  isContinue: boolean;
  stoppingStrings: readonly string[];
  /** Name that must not start the reply (the user's name for normal replies). */
  wrongName?: string;
  /** The character's name, removed from the start of the reply's lines. */
  charName?: string;
  /** The speaker's name, removed from the start of the reply (the user's when impersonating). */
  ownName?: string;
  collapseNewlines?: boolean;
  /** "Start reply with" text, prepended unless impersonating or continuing. */
  promptBias?: string;
  applyRegex?: (text: string) => string;
  /** Text Completion with instruct mode: sequences that leak into the reply are cut or removed. */
  instruct?: {
    stop_sequence: string;
    input_sequence: string;
    output_sequence: string;
    last_output_sequence: string;
    sequences_as_stop_strings: boolean;
  };
  /** Cut the reply after its last complete sentence. */
  trimSentences?: boolean;
}

/** Cuts text after its last complete sentence (SillyTavern `trimToEndSentence`). */
export function trimToEndSentence(input: string): string {
  if (!input) return '';
  const isEmoji = (x: string) => /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u.test(x);
  const punctuation = new Set([
    '.',
    '!',
    '?',
    '*',
    '"',
    ')',
    '}',
    '`',
    ']',
    '$',
    '。',
    '！',
    '？',
    '”',
    '）',
    '】',
    '’',
    '」',
    '_',
  ]);
  let last = -1;
  const characters = Array.from(input);
  for (let i = characters.length - 1; i >= 0; i--) {
    const char = characters[i]!;
    const emoji = isEmoji(char);
    if (punctuation.has(char) || emoji) {
      last = !emoji && i > 0 && /[\s\n]/.test(characters[i - 1]!) ? i - 1 : i;
      break;
    }
  }
  if (last === -1) return input.trimEnd();
  return characters
    .slice(0, last + 1)
    .join('')
    .trimEnd();
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const instruct = options.instruct;
  if (instruct) {
    if (instruct.stop_sequence && message.includes(instruct.stop_sequence)) {
      message = message.substring(0, message.indexOf(instruct.stop_sequence));
    }
    // Only the first turn counts: anything from the next user turn on is dropped.
    if (instruct.input_sequence.trim() && message.includes(instruct.input_sequence)) {
      message = message.substring(0, message.indexOf(instruct.input_sequence));
    }
    if (instruct.sequences_as_stop_strings) {
      const leaked = options.isImpersonate
        ? [instruct.input_sequence]
        : [instruct.output_sequence, instruct.last_output_sequence];
      for (const sequence of leaked.filter((x) => x.trim())) {
        for (const line of sequence.split('\n').filter((l) => l.trim() !== ''))
          message = message.replaceAll(line, '');
      }
    }
  }
  if (options.charName) {
    message = message.replace(new RegExp(`(^|\n)${escapeRegex(options.charName)}:\\s*`, 'g'), '$1');
  }
  if (options.isImpersonate) message = message.trim();
  if (options.ownName && message.startsWith(`${options.ownName}:`)) {
    message = message.replace(`${options.ownName}:`, '').trimStart();
  }
  if (options.isImpersonate) message = message.trim();
  if (options.trimSentences) message = trimToEndSentence(message);
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

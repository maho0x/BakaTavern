/** Reasoning blocks added back into prompts (port of SillyTavern's `PromptReasoning`). */

/** SillyTavern `power_user.reasoning` (the prompt-related part). */
export interface ReasoningPromptSettings {
  /** Add the reasoning of past replies to the prompt. */
  addToPrompts: boolean;
  /** How many replies (newest first) get their reasoning added. */
  maxAdditions: number;
  prefix: string;
  suffix: string;
  separator: string;
}

export const defaultReasoningPromptSettings: ReasoningPromptSettings = {
  addToPrompts: false,
  maxAdditions: 1,
  prefix: '<think>',
  suffix: '</think>',
  separator: '\n',
};

/** Legacy placeholder SillyTavern stored for hidden reasoning. */
const REASONING_PLACEHOLDER = '​';

export class PromptReasoning {
  counter = 0;
  /** Length of the formatted reasoning put before a continued message (-1 if none). */
  prefixLength = -1;
  prefixFormatted = '';
  /** The continued message had reasoning but no content yet: the model continues the reasoning. */
  prefixIncomplete = false;
  readonly #settings: ReasoningPromptSettings;
  readonly #substitute: (text: string) => string;

  constructor(settings: ReasoningPromptSettings, substitute: (text: string) => string) {
    this.#settings = settings;
    this.#substitute = substitute;
  }

  isLimitReached(): boolean {
    if (!this.#settings.addToPrompts) return true;
    return this.counter >= this.#settings.maxAdditions;
  }

  addToMessage(content: string, reasoning: string, isPrefix: boolean): string {
    if (!isPrefix && (!this.#settings.addToPrompts || this.counter >= this.#settings.maxAdditions))
      return content;
    if (!reasoning || reasoning === REASONING_PLACEHOLDER) return content;
    this.counter++;
    const prefix = this.#substitute(this.#settings.prefix || '');
    const separator = this.#substitute(this.#settings.separator || '');
    const suffix = this.#substitute(this.#settings.suffix || '');
    if (isPrefix && !content) {
      const formatted = `${prefix}${reasoning}`;
      this.prefixFormatted = formatted;
      this.prefixLength = formatted.length;
      this.prefixIncomplete = true;
      return formatted;
    }
    const formatted = `${prefix}${reasoning}${suffix}${separator}`;
    if (isPrefix) {
      this.prefixFormatted = formatted;
      this.prefixLength = formatted.length;
      this.prefixIncomplete = false;
    }
    return `${formatted}${content}`;
  }

  removePrefix(content: string): string {
    return this.prefixLength > 0 ? content.slice(this.prefixLength) : content;
  }
}

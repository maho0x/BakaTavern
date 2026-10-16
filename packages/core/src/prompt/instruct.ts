/**
 * Instruct mode, context templates and system prompts for Text Completion APIs: port of
 * SillyTavern's `instruct-mode.js` and the story string parts of `power-user.js`. Templates keep
 * SillyTavern's keys so presets and settings import and export as they are.
 */

import { loadHandlebars, renderTemplate } from './handlebars.ts';
import { ExtensionPromptPosition, ExtensionPromptRole } from './types.ts';

export type InstructNamesBehavior = 'none' | 'force' | 'always';

/** Instruct template (`power_user.instruct`, `instruct/*.json`). */
export interface InstructTemplate {
  name?: string;
  input_sequence: string;
  input_suffix: string;
  output_sequence: string;
  output_suffix: string;
  system_sequence: string;
  system_suffix: string;
  last_system_sequence: string;
  first_input_sequence: string;
  first_output_sequence: string;
  last_input_sequence: string;
  last_output_sequence: string;
  story_string_prefix: string;
  story_string_suffix: string;
  stop_sequence: string;
  wrap: boolean;
  macro: boolean;
  names_behavior: InstructNamesBehavior;
  activation_regex: string;
  bind_to_context?: boolean;
  user_alignment_message: string;
  system_same_as_user: boolean;
  skip_examples: boolean;
  sequences_as_stop_strings: boolean;
  [key: string]: unknown;
}

/** Context template (`power_user.context`, `context/*.json`). */
export interface ContextTemplate {
  name?: string;
  story_string: string;
  example_separator: string;
  chat_start: string;
  use_stop_strings: boolean;
  names_as_stop_strings: boolean;
  /** `ExtensionPromptPosition.IN_PROMPT` or `IN_CHAT`. */
  story_string_position: number;
  story_string_depth: number;
  story_string_role: number;
  /** SillyTavern keeps these power user options in the context template too. */
  always_force_name2: boolean;
  trim_sentences: boolean;
  single_line: boolean;
  [key: string]: unknown;
}

/** System prompt (`power_user.sysprompt`, `sysprompt/*.json`). */
export interface SystemPromptTemplate {
  name?: string;
  content: string;
  post_history: string;
  [key: string]: unknown;
}

/** SillyTavern's built-in instruct settings (Alpaca-like, disabled until a template is chosen). */
export const defaultInstructTemplate: InstructTemplate = {
  name: 'Alpaca',
  input_sequence: '### Instruction:',
  input_suffix: '',
  output_sequence: '### Response:',
  output_suffix: '',
  system_sequence: '',
  system_suffix: '',
  last_system_sequence: '',
  first_input_sequence: '',
  first_output_sequence: '',
  last_input_sequence: '',
  last_output_sequence: '',
  story_string_prefix: '',
  story_string_suffix: '',
  stop_sequence: '',
  wrap: true,
  macro: true,
  names_behavior: 'force',
  activation_regex: '',
  bind_to_context: false,
  user_alignment_message: '',
  system_same_as_user: false,
  skip_examples: false,
  sequences_as_stop_strings: true,
};

const defaultStoryString =
  "{{#if system}}{{system}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{char}}'s personality: {{personality}}\n{{/if}}{{#if scenario}}Scenario: {{scenario}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}";

export const defaultContextTemplate: ContextTemplate = {
  name: 'Default',
  story_string: defaultStoryString,
  example_separator: '***',
  chat_start: '***',
  use_stop_strings: true,
  names_as_stop_strings: true,
  story_string_position: ExtensionPromptPosition.IN_PROMPT,
  story_string_depth: 1,
  story_string_role: ExtensionPromptRole.SYSTEM,
  always_force_name2: true,
  trim_sentences: false,
  single_line: false,
};

export const defaultSystemPrompt: SystemPromptTemplate = {
  name: 'Neutral - Chat',
  content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
  post_history: '',
};

/** Brings an instruct template up to date (`migrateInstructModeSettings`) and fills in defaults. */
export function normalizeInstructTemplate(raw: Record<string, unknown> | null | undefined): InstructTemplate {
  const settings: Record<string, unknown> = { ...raw };
  if (settings.separator_sequence !== undefined) {
    settings.output_suffix = settings.separator_sequence || '';
    delete settings.separator_sequence;
  }
  if (settings.names !== undefined) {
    settings.names_behavior = settings.names ? 'always' : settings.names_force_groups ? 'force' : 'none';
  }
  for (const field of ['names', 'names_force_groups', 'system_sequence_prefix', 'system_sequence_suffix']) {
    delete settings[field];
  }
  const template = { ...defaultInstructTemplate } as InstructTemplate;
  for (const [key, value] of Object.entries(settings)) if (value !== undefined) template[key] = value;
  return template;
}

const contextDefaults = {
  use_stop_strings: false,
  names_as_stop_strings: true,
  story_string_position: ExtensionPromptPosition.IN_PROMPT,
  story_string_depth: 1,
  story_string_role: ExtensionPromptRole.SYSTEM,
  always_force_name2: true,
  trim_sentences: false,
  single_line: false,
};

/**
 * Fills in a context template. Templates from before the story string positions get the
 * `anchorBefore` / `anchorAfter` fields they lack (SillyTavern's `autoFixStoryString`).
 */
export function normalizeContextTemplate(raw: Record<string, unknown> | null | undefined): ContextTemplate {
  const template = {
    story_string: defaultStoryString,
    example_separator: '',
    chat_start: '',
    ...contextDefaults,
  } as ContextTemplate;
  for (const [key, value] of Object.entries(raw ?? {})) if (value !== undefined) template[key] = value;
  for (const key of ['story_string_position', 'story_string_depth', 'story_string_role'] as const) {
    template[key] = Number(template[key]);
  }
  if (raw && !Object.hasOwn(raw, 'story_string_position')) {
    template.story_string = autoFixStoryString(String(template.story_string ?? ''));
  }
  return template;
}

function autoFixStoryString(storyString: string): string {
  const fix = (field: string, position: 'start' | 'end') => {
    if (storyString.includes(`{{${field}}}`)) return;
    const fieldTemplate = `{{#if ${field}}}{{${field}}}\n{{/if}}`;
    const firstCurly = storyString.includes('{{') ? storyString.indexOf('{{') : 0;
    const lastCurly = storyString.includes('}}') ? storyString.lastIndexOf('}}') + 2 : storyString.length;
    const lastTrim = storyString.includes('{{trim}}')
      ? storyString.lastIndexOf('{{trim}}')
      : storyString.length;
    const end = Math.min(lastTrim, lastCurly);
    storyString =
      position === 'start'
        ? storyString.substring(0, firstCurly) + fieldTemplate + storyString.substring(firstCurly)
        : storyString.substring(0, end) + fieldTemplate + storyString.substring(end);
  };
  fix('anchorBefore', 'start');
  fix('anchorAfter', 'end');
  return storyString;
}

export function normalizeSystemPrompt(raw: Record<string, unknown> | null | undefined): SystemPromptTemplate {
  return {
    ...raw,
    content: String(raw?.content ?? ''),
    post_history: String(raw?.post_history ?? ''),
  };
}

/** Use the first or last sequence of a kind (SillyTavern `force_output_sequence`). */
export const ForceSequence = { FIRST: 1, LAST: 2 } as const;

/** Everything the instruct formatting functions read besides their arguments. */
export interface InstructContext {
  instruct: InstructTemplate;
  context: ContextTemplate;
  /** The user's and the character's name (SillyTavern `name1`, `name2`). */
  userName: string;
  charName: string;
  isGroup: boolean;
  /** Macro substitution; `names` overrides `{{user}}` and `{{char}}`. */
  substitute: (text: string, names?: { user: string; char: string }) => string;
}

/** `String.replace` with a string replacement, as SillyTavern does it (`$` patterns apply). */
const replaceName = (text: string, name: string) => text.replace(/{{name}}/gi, name);

/** Stop strings from the instruct sequences and the context template (`getInstructStoppingSequences`). */
export function instructStoppingSequences(
  f: InstructContext,
  instructEnabled: boolean,
  useStopStrings = f.context.use_stop_strings,
): string[] {
  const { instruct } = f;
  const result: string[] = [];
  const add = (sequence: string) => {
    if (sequence.length > 0 && sequence.trim().length > 0) {
      const wrapped = instruct.wrap ? `\n${sequence}` : sequence;
      result.push(instruct.macro ? f.substitute(wrapped) : wrapped);
    }
  };
  if (instructEnabled) {
    const combined = [instruct.stop_sequence || ''];
    if (instruct.sequences_as_stop_strings) {
      combined.push(
        (instruct.input_sequence && replaceName(instruct.input_sequence, f.userName)) || '',
        (instruct.output_sequence && replaceName(instruct.output_sequence, f.charName)) || '',
        (instruct.first_output_sequence && replaceName(instruct.first_output_sequence, f.charName)) || '',
        (instruct.last_output_sequence && replaceName(instruct.last_output_sequence, f.charName)) || '',
        (instruct.system_sequence && replaceName(instruct.system_sequence, 'System')) || '',
        (instruct.last_system_sequence && replaceName(instruct.last_system_sequence, 'System')) || '',
      );
    }
    const lines = combined.join('\n').split('\n');
    lines.filter((line, index) => lines.indexOf(line) === index).forEach(add);
  }
  if (useStopStrings) {
    if (f.context.chat_start) result.push(`\n${f.substitute(f.context.chat_start)}`);
    if (f.context.example_separator) result.push(`\n${f.substitute(f.context.example_separator)}`);
  }
  return result;
}

export interface InstructChatMessage {
  name: string;
  mes: string;
  isUser: boolean;
  isNarrator: boolean;
  forceAvatar?: boolean;
}

/** One chat message in instruct format (`formatInstructModeChat`). */
export function formatInstructChat(
  f: InstructContext,
  message: InstructChatMessage,
  forceSequence: number | false = false,
): string {
  const { instruct } = f;
  const { name, mes, isUser, isNarrator, forceAvatar } = message;
  let includeNames = isNarrator ? false : instruct.names_behavior === 'always';
  if (
    !isNarrator &&
    instruct.names_behavior === 'force' &&
    ((f.isGroup && name !== f.userName) || (forceAvatar && name !== f.userName))
  ) {
    includeNames = true;
  }

  const prefixOf = () => {
    if (isNarrator) return instruct.system_same_as_user ? instruct.input_sequence : instruct.system_sequence;
    if (isUser) {
      if (forceSequence === ForceSequence.FIRST)
        return instruct.first_input_sequence || instruct.input_sequence;
      if (forceSequence === ForceSequence.LAST)
        return instruct.last_input_sequence || instruct.input_sequence;
      return instruct.input_sequence;
    }
    if (forceSequence === ForceSequence.FIRST)
      return instruct.first_output_sequence || instruct.output_sequence;
    if (forceSequence === ForceSequence.LAST)
      return instruct.last_output_sequence || instruct.output_sequence;
    return instruct.output_sequence;
  };
  const suffixOf = () => {
    if (isNarrator) return instruct.system_same_as_user ? instruct.input_suffix : instruct.system_suffix;
    return isUser ? instruct.input_suffix : instruct.output_suffix;
  };

  let prefix = prefixOf() || '';
  let suffix = suffixOf() || '';
  if (instruct.macro) {
    const names = { user: f.userName, char: f.charName };
    prefix = replaceName(f.substitute(prefix, names), name || 'System');
    suffix = replaceName(f.substitute(suffix, names), name || 'System');
  }
  if (!suffix && instruct.wrap) suffix = '\n';
  const separator = instruct.wrap ? '\n' : '';
  const parts = includeNames && name ? [prefix, `${name}: ${mes}${suffix}`] : [prefix, mes + suffix];
  return parts.filter((x) => x).join(separator);
}

/** Wraps the story string in the instruct template's story string sequences. */
export function formatInstructStoryString(f: InstructContext, storyString: string): string {
  if (!storyString) return '';
  const { instruct } = f;
  const applySequences = f.context.story_string_position !== ExtensionPromptPosition.IN_CHAT;
  const separator = instruct.wrap ? '\n' : '';
  if (applySequences && instruct.story_string_prefix) {
    const prefix = replaceName(f.substitute(instruct.story_string_prefix), 'System');
    storyString = prefix + separator + storyString;
  }
  if (applySequences && instruct.story_string_suffix) {
    storyString += f.substitute(instruct.story_string_suffix);
  }
  return storyString;
}

/** A dialogue example line group (SillyTavern `parseExampleIntoIndividual`). */
export interface ExampleMessage {
  name: 'example_user' | 'example_assistant';
  content: string;
}

/**
 * Splits one example block (its first line is the heading) into messages by speaker, the way
 * SillyTavern's `parseExampleIntoIndividual` does.
 */
export function parseExampleIntoIndividual(
  text: string,
  options: { userName: string; charName: string; groupNames: readonly string[]; appendNames: boolean },
): ExampleMessage[] {
  const groupBotNames = options.groupNames.map((n) => `${n}:`);
  const result: ExampleMessage[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  let inUser = false;
  let inBot = false;
  let botName = options.charName;
  const add = (name: string, systemName: ExampleMessage['name']) => {
    let parsed = current.join('\n').replace(`${name}:`, '').trim();
    if (options.appendNames) parsed = `${name}: ${parsed}`;
    result.push({ name: systemName, content: parsed });
    current = [];
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(`${options.userName}:`)) {
      inUser = true;
      if (inBot) add(botName, 'example_assistant');
      inBot = false;
    } else if (line.startsWith(`${options.charName}:`) || groupBotNames.some((n) => line.startsWith(n))) {
      if (!line.startsWith(`${options.charName}:`) && groupBotNames.length) botName = line.split(':')[0]!;
      inBot = true;
      if (inUser) add(options.userName, 'example_user');
      inUser = false;
    }
    current.push(line);
  }
  if (inUser) add(options.userName, 'example_user');
  else if (inBot) add(botName, 'example_assistant');
  return result;
}

/** Example dialogue blocks in instruct format (`formatInstructModeExamples`). */
export function formatInstructExamples(
  f: InstructContext,
  examples: readonly string[],
  groupNames: readonly string[] = [],
): string[] {
  const { instruct, context } = f;
  const blockHeading = context.example_separator ? `${f.substitute(context.example_separator)}\n` : '';
  if (instruct.skip_examples) return examples.map((x) => x.replace(/<START>\n/i, blockHeading));

  const includeNames = instruct.names_behavior === 'always';
  const includeGroupNames = f.isGroup && ['always', 'force'].includes(instruct.names_behavior);
  let inputPrefix = instruct.input_sequence || '';
  let outputPrefix = instruct.output_sequence || '';
  let inputSuffix = instruct.input_suffix || '';
  let outputSuffix = instruct.output_suffix || '';
  if (instruct.macro) {
    const names = { user: f.userName, char: f.charName };
    inputPrefix = replaceName(f.substitute(inputPrefix, names), f.userName);
    outputPrefix = replaceName(f.substitute(outputPrefix, names), f.charName);
    inputSuffix = replaceName(f.substitute(inputSuffix, names), f.userName);
    outputSuffix = replaceName(f.substitute(outputSuffix, names), f.charName);
    if (!inputSuffix && instruct.wrap) inputSuffix = '\n';
    if (!outputSuffix && instruct.wrap) outputSuffix = '\n';
  }
  const separator = instruct.wrap ? '\n' : '';
  const formatted: string[] = [];
  for (const item of examples) {
    const cleaned = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
    const block = parseExampleIntoIndividual(cleaned, {
      userName: f.userName,
      charName: f.charName,
      groupNames,
      appendNames: includeGroupNames && f.isGroup,
    });
    if (!block.length) continue;
    if (blockHeading) formatted.push(blockHeading);
    for (const example of block) {
      const isUser = example.name === 'example_user';
      const includeThisName =
        !includeGroupNames && (includeNames || (instruct.names_behavior === 'force' && isUser));
      const name = isUser ? f.userName : f.charName;
      const content = includeThisName ? `${name}: ${example.content}` : example.content;
      formatted.push(
        [isUser ? inputPrefix : outputPrefix, content + (isUser ? inputSuffix : outputSuffix)]
          .filter((x) => x)
          .join(separator),
      );
    }
  }
  if (!formatted.length) return examples.map((x) => x.replace(/<START>\n/i, blockHeading));
  return formatted;
}

export interface InstructPromptOptions {
  name: string;
  isImpersonate: boolean;
  promptBias: string;
  isQuiet: boolean;
  isQuietToLoud: boolean;
}

/** The line that starts the reply (`formatInstructModePrompt`). */
export function formatInstructPrompt(f: InstructContext, options: InstructPromptOptions): string {
  const { instruct } = f;
  const { name, isImpersonate, promptBias, isQuiet, isQuietToLoud } = options;
  const includeNames =
    Boolean(name) &&
    (instruct.names_behavior === 'always' || (f.isGroup && instruct.names_behavior === 'force')) &&
    !(isQuiet && !isQuietToLoud);

  const sequenceOf = () => {
    if (isImpersonate) return instruct.last_input_sequence || instruct.input_sequence;
    if (isQuiet && !isQuietToLoud) return instruct.last_system_sequence || instruct.output_sequence;
    return instruct.last_output_sequence || instruct.output_sequence;
  };
  let sequence = sequenceOf() || '';
  let nameFiller = '';
  // Mistral's output sequence ends with a space that its last output sequence lacks.
  if (
    includeNames &&
    instruct.last_output_sequence &&
    instruct.output_sequence &&
    sequence === instruct.last_output_sequence &&
    /\s$/.test(instruct.output_sequence) &&
    !/\s$/.test(instruct.last_output_sequence)
  ) {
    nameFiller = instruct.output_sequence.slice(-1);
  }
  if (instruct.macro) {
    sequence = replaceName(f.substitute(sequence, { user: f.userName, char: f.charName }), name || 'System');
  }
  const separator = instruct.wrap ? '\n' : '';
  let text = includeNames ? `${separator}${sequence}${separator}${nameFiller}${name}:` : separator + sequence;
  // A quiet prompt already ends with a newline.
  if (isQuiet && separator) text = text.slice(separator.length);
  if (!isImpersonate && promptBias) text += includeNames ? promptBias : separator + promptBias.trimStart();
  return (instruct.wrap ? text.trimEnd() : text) + (includeNames ? '' : separator);
}

/** Story string fields (SillyTavern `storyStringParams`). */
export interface StoryStringParams {
  description: string;
  personality: string;
  persona: string;
  scenario: string;
  system: string;
  char: string;
  user: string;
  wiBefore: string;
  wiAfter: string;
  loreBefore: string;
  loreAfter: string;
  anchorBefore: string;
  anchorAfter: string;
  mesExamples: string;
  mesExamplesRaw: string;
  [key: string]: unknown;
}

/**
 * Renders the context template's story string (`renderStoryString`): Handlebars, then macros,
 * leading newlines removed and a trailing newline added where SillyTavern adds one.
 */
export async function renderStoryString(
  f: Pick<InstructContext, 'instruct' | 'context' | 'substitute'>,
  instructEnabled: boolean,
  params: StoryStringParams,
): Promise<string> {
  const handlebars = await loadHandlebars();
  const position = f.context.story_string_position ?? ExtensionPromptPosition.IN_PROMPT;
  let output = renderTemplate(handlebars, f.context.story_string, params, {
    // Left for the macro pass: `{{trim}}` removes the newlines around it.
    trim: () => '{{trim}}',
    helperMissing: (...args: unknown[]) => f.substitute(`{{${(args.at(-1) as { name: string }).name}}}`),
  });
  output = f.substitute(output, { user: params.user, char: params.char });
  output = output.replace(/^\n+/, '');
  if (output.length > 0 && !output.endsWith('\n') && position !== ExtensionPromptPosition.IN_CHAT) {
    if (!instructEnabled || (f.instruct.wrap && !f.instruct.story_string_suffix)) output += '\n';
  }
  return output;
}

/**
 * Regex scripts: a port of SillyTavern's regex extension engine (extensions/regex/engine.js).
 * Scripts keep SillyTavern's shape so they import and export unchanged.
 */

/** Where a script applies (SillyTavern `regex_placement`). */
export const RegexPlacement = {
  /** @deprecated Markdown display; kept so old scripts load. */
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  // 4 was "sendAs" (legacy)
  WORLD_INFO: 5,
  REASONING: 6,
} as const;

/** How macros in the find regex are substituted (SillyTavern `substitute_find_regex`). */
export const SubstituteRegex = { NONE: 0, RAW: 1, ESCAPED: 2 } as const;

/** SillyTavern `RegexScriptData`. */
export interface RegexScript {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  placement: number[];
  disabled: boolean;
  /** Only alters what is displayed. */
  markdownOnly: boolean;
  /** Only alters what is sent to the model. */
  promptOnly: boolean;
  runOnEdit: boolean;
  /** `SubstituteRegex`; older scripts store a boolean (true = raw). */
  substituteRegex: number | boolean;
  minDepth: number | null;
  maxDepth: number | null;
  [extra: string]: unknown;
}

/**
 * Macro substitution as SillyTavern's `substituteParams`: `charName` overrides `{{char}}`,
 * `postProcess` transforms the output of every macro.
 */
export type RegexSubstitute = (
  text: string,
  options?: { charName?: string; postProcess?: (value: string) => string },
) => string;

export interface RegexParams {
  /** Character name for `{{char}}` in trim strings (the message author). */
  characterOverride?: string;
  /** The text is being rendered for display. */
  isMarkdown?: boolean;
  /** The text is going into a prompt. */
  isPrompt?: boolean;
  /** The text comes from a message edit. */
  isEdit?: boolean;
  /** Depth of the message (0 = last); scripts with a depth range skip messages outside it. */
  depth?: number | null;
}

export function newRegexScript(id: string, overrides: Partial<RegexScript> = {}): RegexScript {
  return {
    id,
    scriptName: '',
    findRegex: '',
    replaceString: '',
    trimStrings: [],
    placement: [],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: SubstituteRegex.NONE,
    minDepth: null,
    maxDepth: null,
    ...overrides,
  };
}

/**
 * Parses `/pattern/flags` (or a bare pattern) into a RegExp, like SillyTavern's
 * `regexFromString`. Returns undefined for an invalid regex.
 */
export function regexFromString(input: string): RegExp | undefined {
  try {
    const m = input.match(/(\/?)(.+)\1([a-z]*)/i)!;
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) return RegExp(input);
    return new RegExp(m[2]!, m[3]);
  } catch {
    return undefined;
  }
}

/** Compiled regexes by source, least recently used first (SillyTavern `RegexProvider`). */
const cache = new Map<string, RegExp | null>();
const CACHE_LIMIT = 1000;

function compiled(source: string): RegExp | undefined {
  let regex = cache.get(source);
  if (regex === undefined) {
    regex = regexFromString(source) ?? null;
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  } else {
    cache.delete(source);
  }
  cache.set(source, regex);
  if (!regex) return undefined;
  if (regex.global || regex.sticky) regex.lastIndex = 0;
  return regex;
}

/** Escapes a macro's output so it matches literally inside a regex (`sanitizeRegexMacro`). */
export function sanitizeRegexMacro(value: string): string {
  if (!value || typeof value !== 'string') return value;
  return value.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (s) => {
    switch (s) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\v':
        return '\\v';
      case '\f':
        return '\\f';
      case '\0':
        return '\\0';
      default:
        return '\\' + s;
    }
  });
}

function findRegexSource(script: RegexScript, substitute: RegexSubstitute): string {
  switch (Number(script.substituteRegex)) {
    case SubstituteRegex.RAW:
      return substitute(script.findRegex);
    case SubstituteRegex.ESCAPED:
      return substitute(script.findRegex, { postProcess: sanitizeRegexMacro });
    default:
      return script.findRegex;
  }
}

function filterString(
  text: string,
  trimStrings: readonly string[] | undefined,
  substitute: RegexSubstitute,
  characterOverride?: string,
): string {
  let out = text;
  for (const trim of trimStrings ?? []) {
    out = out.replaceAll(substitute(trim, { charName: characterOverride }), '');
  }
  return out;
}

/** Runs one script over `text` (SillyTavern `runRegexScript`). */
export function runRegexScript(
  script: RegexScript,
  text: string,
  substitute: RegexSubstitute,
  { characterOverride }: { characterOverride?: string } = {},
): string {
  if (!script || script.disabled || !script.findRegex || !text) return text;
  const regex = compiled(findRegexSource(script, substitute));
  if (!regex) return text;
  return text.replace(regex, (...args: unknown[]) => {
    let match: unknown = args[0];
    const replaceString = String(script.replaceString ?? '').replace(/{{match}}/gi, '$0');
    const withGroups = replaceString.replaceAll(
      /\$(\d+)|\$<([^>]+)>/g,
      (_: string, num: string | undefined, groupName: string | undefined) => {
        if (num) {
          match = args[Number(num)];
        } else if (groupName) {
          const groups = args[args.length - 1];
          match =
            groups && typeof groups === 'object' ? (groups as Record<string, unknown>)[groupName] : false;
        }
        if (!match) return '';
        return filterString(String(match), script.trimStrings, substitute, characterOverride);
      },
    );
    return substitute(withGroups);
  });
}

const numberLike = (value: unknown) => value !== null && !Number.isNaN(Number(value));

/** Does a script run for this kind of text (display, prompt, plain) and depth? */
export function regexScriptApplies(script: RegexScript, placement: number, params: RegexParams): boolean {
  const { isMarkdown, isPrompt, isEdit, depth } = params;
  const kind =
    (script.markdownOnly && isMarkdown) ||
    (script.promptOnly && isPrompt) ||
    (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt);
  if (!kind) return false;
  if (isEdit && !script.runOnEdit) return false;
  if (typeof depth === 'number') {
    if (numberLike(script.minDepth) && Number(script.minDepth) >= -1 && depth < Number(script.minDepth))
      return false;
    if (numberLike(script.maxDepth) && Number(script.maxDepth) >= 0 && depth > Number(script.maxDepth))
      return false;
  }
  return Array.isArray(script.placement) && script.placement.includes(placement);
}

/**
 * Applies every matching script in order (SillyTavern `getRegexedString`). `scripts` must
 * already be ordered (global, preset, character) and limited to the allowed ones.
 */
export function getRegexedString(
  text: string,
  placement: number,
  scripts: readonly RegexScript[],
  substitute: RegexSubstitute,
  params: RegexParams = {},
): string {
  if (typeof text !== 'string') return '';
  if (!text || placement === undefined) return text;
  let out = text;
  for (const script of scripts) {
    if (regexScriptApplies(script, placement, params)) {
      out = runRegexScript(script, out, substitute, { characterOverride: params.characterOverride });
    }
  }
  return out;
}

export interface RegexSources {
  global: readonly RegexScript[];
  /** Scripts embedded in the active preset (`extensions.regex_scripts`). */
  preset?: readonly RegexScript[];
  presetAllowed?: boolean;
  /** Scripts embedded in the character card (`data.extensions.regex_scripts`). */
  character?: readonly RegexScript[];
  characterAllowed?: boolean;
}

/** The scripts in effect, in SillyTavern's order: global, preset, then character. */
export function activeRegexScripts(sources: RegexSources): RegexScript[] {
  const list = (value: unknown) => (Array.isArray(value) ? (value as RegexScript[]) : []);
  return [
    ...list(sources.global),
    ...(sources.presetAllowed ? list(sources.preset) : []),
    ...(sources.characterAllowed ? list(sources.character) : []),
  ];
}

/**
 * Brings a script from an older SillyTavern up to date (`migrateSettings`): the "Markdown display"
 * placement became the display/prompt flags, and placement 4 ("send as") became slash commands.
 */
export function migrateRegexScript(script: Partial<RegexScript>, newId: () => string): RegexScript {
  const out = { ...newRegexScript(script.id || newId()), ...script } as RegexScript;
  if (!out.id) out.id = newId();
  if (!Array.isArray(out.placement)) out.placement = [];
  if (out.placement.includes(RegexPlacement.MD_DISPLAY)) {
    out.placement =
      out.placement.length === 1
        ? Object.values(RegexPlacement).filter((p) => p !== RegexPlacement.MD_DISPLAY)
        : out.placement.filter((p) => p !== RegexPlacement.MD_DISPLAY);
    out.markdownOnly = true;
    out.promptOnly = true;
  }
  if (out.placement.includes(4)) {
    out.placement =
      out.placement.length === 1 ? [RegexPlacement.SLASH_COMMAND] : out.placement.filter((p) => p !== 4);
  }
  if (!Array.isArray(out.trimStrings)) out.trimStrings = [];
  return out;
}

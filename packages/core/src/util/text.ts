/** Values SillyTavern treats as boolean false in macro conditions and settings. */
export function isFalseBoolean(value: string): boolean {
  return ['false', 'off', '0'].includes(value.trim().toLowerCase());
}

export function isTrueBoolean(value: string): boolean {
  return ['true', 'on', '1'].includes(value.trim().toLowerCase());
}

/** `{0}`-style positional formatting (SillyTavern `stringFormat`). */
export function stringFormat(format: string, ...args: string[]): string {
  return format.replace(/{(\d+)}/g, (match, index: string) => args[Number(index)] ?? match);
}

/** Collapses runs of blank lines into a single newline (SillyTavern `collapseNewlines`). */
export function collapseNewlines(text: string): string {
  return text.replaceAll(/\n+/g, '\n');
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

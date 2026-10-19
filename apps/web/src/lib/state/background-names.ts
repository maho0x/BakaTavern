/** How SillyTavern refers to a chat background: `url("backgrounds/<file name>")`. */

/** The file name in a SillyTavern background value (`url("backgrounds/rain%20day.jpg")`). */
export function backgroundName(css: unknown): string | null {
  if (typeof css !== 'string') return null;
  const match = css.match(/backgrounds\/([^"')]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

/** SillyTavern's value for a background (`url("backgrounds/<name>")`). */
export function backgroundCss(name: string): string {
  return `url("backgrounds/${encodeURIComponent(name)}")`;
}

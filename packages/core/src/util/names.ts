/**
 * SillyTavern's names for branches and checkpoints of a chat (`bookmarks.js`): the chat's name
 * without its own `- Branch #n` / `- Checkpoint #n` suffix (or the old `Branch #n - ` prefix),
 * then the first free number.
 */
export function branchChatTitle(
  main: string,
  kind: 'branch' | 'checkpoint',
  taken: (title: string) => boolean,
): string {
  const token = kind === 'checkpoint' ? 'Checkpoint #' : 'Branch #';
  const clean = main.replace(new RegExp(` - ${token}\\d+$`), '').replace(new RegExp(`^${token}\\d+ - `), '');
  let i = 1;
  while (taken(`${clean} - ${token}${i}`)) i++;
  return `${clean} - ${token}${i}`;
}

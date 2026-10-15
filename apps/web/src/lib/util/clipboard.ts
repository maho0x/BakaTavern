/**
 * Copies text to the clipboard. The async clipboard API only exists in secure contexts, so plain
 * HTTP access from another device on the LAN falls back to a hidden textarea.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;inset:0 auto auto 0;opacity:0';
  document.body.append(area);
  area.select();
  // Deprecated, but the only option without a secure context.
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('The browser blocked copying.');
}

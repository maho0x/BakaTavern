import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: true, async: false });

/**
 * Wraps quoted speech in `<q>` so dialogue can be styled apart from narration (as SillyTavern
 * does). Code spans/blocks and style tags are left alone. Works on Markdown source, so emphasis
 * inside quotes still renders.
 */
const QUOTES =
  /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[^`\n]*`|(".+?")|(“.+?”)|(«.+?»)|(「.+?」)|(『.+?』)|(＂.+?＂)/gm;

export function highlightQuotes(text: string): string {
  return text.replace(QUOTES, (match, ...groups: (string | undefined)[]) => {
    const quoted = groups.slice(0, 6).find((g) => g !== undefined);
    return quoted ? `<q>${quoted}</q>` : match;
  });
}

let hooksInstalled = false;
let allowExternal = false;

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node instanceof HTMLAnchorElement) {
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
    const src = node.getAttribute?.('src');
    if (src && !allowExternal && /^https?:/i.test(src)) {
      const url = new URL(src, location.href);
      if (url.origin !== location.origin) {
        node.removeAttribute('src');
        node.setAttribute('data-blocked-src', src);
        node.setAttribute('title', 'External media is blocked (Settings → Messages)');
      }
    }
  });
}

export interface RenderOptions {
  /** Allow (sanitized) HTML from the message; otherwise it is shown as text. */
  html: boolean;
  externalMedia: boolean;
}

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Message text → safe HTML. */
export function renderMessage(text: string, options: RenderOptions): string {
  installHooks();
  allowExternal = options.externalMedia;
  const source = options.html ? text : escapeHtml(text);
  const html = marked.parse(highlightQuotes(source)) as string;
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['q', 'details', 'summary', 'font', 'center'],
    ADD_ATTR: ['target', 'color', 'size', 'face', 'open'],
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'textarea',
      'button',
      'meta',
      'link',
      'base',
    ],
  });
}

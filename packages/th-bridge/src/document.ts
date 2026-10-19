/**
 * Front-end code in messages and the documents frames show: TavernHelper renders a message's code
 * block as a page when the code looks like one, and runs scripts as module code.
 */

import type { FrameConfig } from './protocol.ts';

/** Code that is a page rather than a snippet (TavernHelper `isFrontend`). */
export function isFrontend(code: string): boolean {
  return ['html>', '<head>', '<body'].some((tag) => code.includes(tag));
}

export type MessagePart = { kind: 'text'; text: string } | { kind: 'frontend'; code: string };

/**
 * Splits message text at fenced code blocks that hold a page; the rest stays Markdown. An
 * unclosed fence runs to the end, as Markdown renders it.
 */
export function splitFrontend(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const lines = text.split('\n');
  let buffer: string[] = [];
  const flushText = () => {
    if (buffer.length) parts.push({ kind: 'text', text: buffer.join('\n') });
    buffer = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!open) {
      buffer.push(lines[i]!);
      continue;
    }
    const fence = open[1]!;
    let end = i + 1;
    while (end < lines.length) {
      const close = lines[end]!.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) break;
      end++;
    }
    const code = lines.slice(i + 1, end).join('\n');
    if (isFrontend(code)) {
      flushText();
      parts.push({ kind: 'frontend', code });
    } else {
      buffer.push(...lines.slice(i, Math.min(end + 1, lines.length)));
    }
    i = end;
  }
  flushText();
  return parts;
}

/** `min-height: …vh` measured against the page, not the frame (TavernHelper `replaceVhInContent`). */
export function replaceViewportHeight(content: string): string {
  const hasVh =
    /min-height\s*:\s*[^;{}]*\d+(?:\.\d+)?vh/i.test(content) ||
    /(\.style\.minHeight\s*=\s*(["']))([\s\S]*?vh)(\2)/i.test(content) ||
    /(setProperty\s*\(\s*(["'])min-height\2\s*,\s*(["']))([\s\S]*?vh)(\3\s*\))/i.test(content);
  if (!hasVh) return content;
  const convert = (value: string) =>
    value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (match, number: string) => {
      const parsed = parseFloat(number);
      if (!Number.isFinite(parsed)) return match;
      return parsed === 100
        ? 'var(--TH-viewport-height)'
        : `calc(var(--TH-viewport-height) * ${parsed / 100})`;
    });
  return content
    .replace(
      /(min-height\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh)(?=\s*[;}])/gi,
      (_m, prefix: string, value: string) => `${prefix}${convert(value)}`,
    )
    .replace(
      /(style\s*=\s*(["']))([^"']*?)(\2)/gi,
      (match, prefix: string, _q: string, style: string, suffix: string) =>
        /min-height\s*:\s*[^;]*vh/i.test(style)
          ? `${prefix}${style.replace(/(min-height\s*:\s*)([^;]*?\d+(?:\.\d+)?vh)/gi, (_x, p: string, v: string) => `${p}${convert(v)}`)}${suffix}`
          : match,
    )
    .replace(
      /(\.style\.minHeight\s*=\s*(["']))([\s\S]*?)(\2)/gi,
      (match, prefix: string, _q: string, value: string, suffix: string) =>
        /\b\d+(?:\.\d+)?vh\b/i.test(value) ? `${prefix}${convert(value)}${suffix}` : match,
    )
    .replace(
      /(setProperty\s*\(\s*(["'])min-height\2\s*,\s*(["']))([\s\S]*?)(\3\s*\))/gi,
      (match, prefix: string, _q1: string, _q2: string, value: string, suffix: string) =>
        /\b\d+(?:\.\d+)?vh\b/i.test(value) ? `${prefix}${convert(value)}${suffix}` : match,
    );
}

/**
 * Libraries TavernHelper puts into every frame besides its own (`third_party_message.html`):
 * cards expect them, so they load from the same CDN unless turned off.
 */
export const CDN_HEAD = `<link rel="stylesheet" href="https://testingcf.jsdelivr.net/npm/@fortawesome/fontawesome-free/css/all.min.css" />
<script src="https://testingcf.jsdelivr.net/npm/jquery-ui/dist/jquery-ui.min.js"></script>
<link rel="stylesheet" href="https://testingcf.jsdelivr.net/npm/jquery-ui/themes/base/theme.min.css" />
<script src="https://testingcf.jsdelivr.net/npm/jquery-ui-touch-punch"></script>
<script src="https://testingcf.jsdelivr.net/npm/vue/dist/vue.runtime.global.prod.min.js"></script>
<script src="https://testingcf.jsdelivr.net/npm/vue-router/dist/vue-router.global.prod.min.js"></script>`;

export interface DocumentOptions {
  /** URL of the built runtime (`th-runtime.js`). */
  runtimeUrl: string;
  config: FrameConfig;
  /** Load the CDN libraries cards expect ({@link CDN_HEAD}). */
  cdn: boolean;
}

/** JSON that is safe inside a `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

const escapeAttribute = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

function head(options: DocumentOptions): string {
  return `<script>window.__TH_CONFIG__=${scriptJson(options.config)};window.name=${scriptJson(options.config.name)};</script>
<script src="${escapeAttribute(options.runtimeUrl)}"></script>
${options.cdn ? CDN_HEAD : ''}`;
}

/** The page a message's front-end code block becomes (TavernHelper `createSrcContent`). */
export function messageDocument(code: string, options: DocumentOptions): string {
  const state = options.config.state;
  const url = (value: string) => value.replaceAll("'", '%27');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;}
.user_avatar,.user-avatar{background-image:url('${url(state.user.avatarUrl)}')}
.char_avatar,.char-avatar{background-image:url('${url(state.character?.avatarUrl ?? '')}')}
</style>
${head(options)}
</head>
<body>
${replaceViewportHeight(code)}
</body>
</html>
`;
}

/** The hidden page a TavernHelper script runs in. */
export function scriptDocument(content: string, options: DocumentOptions): string {
  const code = content.match(/^\s*```[^\n]*\n(.*)\n```\s*$/is)?.[1] ?? content;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${head(options)}
</head>
<body>
<script type="module">
${code.replaceAll('</script', '<\\/script')}
</script>
</body>
</html>
`;
}

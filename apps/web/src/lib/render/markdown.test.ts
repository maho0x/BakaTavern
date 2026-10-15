import { describe, expect, it } from 'vitest';

import { highlightQuotes, renderMessage } from './markdown.ts';

describe('message rendering', () => {
  it('wraps dialogue but not code', () => {
    expect(highlightQuotes('She said "hello" and `"code"`')).toBe('She said <q>"hello"</q> and `"code"`');
    expect(highlightQuotes('「你好」和“欢迎”')).toBe('<q>「你好」</q>和<q>“欢迎”</q>');
  });

  it('renders markdown and strips scripts', () => {
    const html = renderMessage('*waves* "Hi!"<script>alert(1)</script><img src=x onerror=alert(1)>', {
      html: true,
      externalMedia: false,
    });
    expect(html).toContain('<em>waves</em>');
    expect(html).toContain('<q>"Hi!"</q>');
    expect(html).not.toContain('script');
    expect(html).not.toContain('onerror');
  });

  it('escapes HTML when disabled and blocks external images', () => {
    expect(renderMessage('<b>x</b>', { html: false, externalMedia: false })).toContain('&lt;b&gt;');
    const html = renderMessage('![a](https://example.com/a.png)', { html: true, externalMedia: false });
    expect(html).toContain('data-blocked-src="https://example.com/a.png"');
    expect(html).not.toContain(' src="https://example.com');
  });
});

import en from './en.ts';

export type MessageKey = keyof typeof en;
export type Locale = 'zh-CN' | 'en';
type Dict = Record<MessageKey, string>;

export const locales: { id: Locale; label: string }[] = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: 'English' },
];

const loaders: Record<Locale, () => Promise<Dict>> = {
  en: async () => en,
  'zh-CN': async () => (await import('./zh-CN.ts')).default,
};

function detect(): Locale {
  try {
    const saved = localStorage.getItem('bt.locale');
    if (saved === 'en' || saved === 'zh-CN') return saved;
  } catch {
    // storage unavailable
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

class I18n {
  locale = $state<Locale>('en');
  dict = $state.raw<Dict>(en);

  async init() {
    await this.set(detect());
  }

  async set(locale: Locale) {
    this.dict = await loaders[locale]();
    this.locale = locale;
    document.documentElement.lang = locale;
    try {
      localStorage.setItem('bt.locale', locale);
    } catch {
      // storage unavailable
    }
  }
}

export const i18n = new I18n();

/** Translates `key`, replacing `{name}` placeholders. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text = i18n.dict[key] ?? en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
}

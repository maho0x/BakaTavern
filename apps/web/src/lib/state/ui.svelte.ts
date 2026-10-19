export type PanelId =
  | 'connection'
  | 'preset'
  | 'formatting'
  | 'persona'
  | 'worldinfo'
  | 'regex'
  | 'quickreplies'
  | 'frontend'
  | 'plugins'
  | 'settings';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success' | 'warning';
  text: string;
  title?: string;
  /** The text is HTML (sanitized before it is shown). */
  html?: boolean;
  /** Runs when the toast is tapped (it is dismissed too). */
  onclick?: () => void;
}

export interface ToastOptions {
  /** Milliseconds before it goes away by itself; 0 keeps it until tapped. */
  timeout?: number;
  title?: string;
  html?: boolean;
  onclick?: () => void;
  /** Called once the toast is gone. */
  onhidden?: () => void;
}

let nextToast = 1;

class Ui {
  /** Which side panel is open (right drawer on desktop, sheet on mobile). */
  panel = $state<PanelId | null>(null);
  /** Library visibility on narrow screens. */
  libraryOpen = $state(false);
  /** Character editor target. */
  editingCharacterId = $state<string | null>(null);
  /** Group open in the group editor (`new` for a new group). */
  editingGroupId = $state<string | null>(null);
  /** Lorebook open in the World Info editor. */
  editingLorebookId = $state<string | null>(null);
  /** The "Import from a URL" dialog is open. */
  urlImportOpen = $state(false);
  /** The chat search is open. */
  searchOpen = $state(false);
  /** A message to scroll to once its chat is open (a search result). */
  jumpTo = $state<{ chatId: string; seq: number } | null>(null);
  /** The generation shown in the prompt viewer (chat and the reply's `gen_started`). */
  promptOf = $state<{ chatId: string; startedAt: string } | null>(null);
  toasts = $state<Toast[]>([]);
  narrow = $state(false);

  constructor() {
    if (typeof window !== 'undefined') {
      const query = window.matchMedia('(max-width: 900px)');
      this.narrow = query.matches;
      query.addEventListener('change', (e) => (this.narrow = e.matches));
    }
  }

  togglePanel(id: PanelId) {
    this.panel = this.panel === id ? null : id;
    if (this.narrow) this.libraryOpen = false;
  }

  toast(text: string, kind: Toast['kind'] = 'info', options: number | ToastOptions = {}) {
    const o = typeof options === 'number' ? { timeout: options } : options;
    const id = nextToast++;
    this.toasts.push({ id, kind, text, title: o.title, html: o.html, onclick: o.onclick });
    if (o.onhidden) this.#onHidden.set(id, o.onhidden);
    const ms = o.timeout ?? 4000;
    if (ms > 0) setTimeout(() => this.dismiss(id), kind === 'error' && o.timeout === undefined ? ms * 2 : ms);
  }

  #onHidden = new Map<number, () => void>();

  dismiss(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    const hidden = this.#onHidden.get(id);
    this.#onHidden.delete(id);
    hidden?.();
  }
}

export const ui = new Ui();

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

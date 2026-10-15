export type PanelId = 'connection' | 'preset' | 'persona' | 'worldinfo' | 'settings';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

let nextToast = 1;

class Ui {
  /** Which side panel is open (right drawer on desktop, sheet on mobile). */
  panel = $state<PanelId | null>(null);
  /** Library visibility on narrow screens. */
  libraryOpen = $state(false);
  /** Character editor target. */
  editingCharacterId = $state<string | null>(null);
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

  toast(text: string, kind: Toast['kind'] = 'info', ms = 4000) {
    const id = nextToast++;
    this.toasts.push({ id, kind, text });
    setTimeout(() => this.dismiss(id), kind === 'error' ? ms * 2 : ms);
  }

  dismiss(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const ui = new Ui();

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Dialogs scripts open (`/popup`, `/input`, `/buttons`, Quick Reply prompts): one at a time, in
 * the order asked. Bodies are HTML, sanitized when shown.
 */

export interface ButtonLabel {
  text: string;
  tooltip?: string;
}

interface Base {
  /** HTML shown above the controls. */
  body: string;
  wide?: boolean;
}

export type DialogRequest = Base &
  (
    | { kind: 'popup'; header?: string | null; okButton: string; cancelButton: string | null }
    | {
        kind: 'input';
        initial: string;
        rows: number;
        placeholder: string | null;
        okButton: string;
      }
    | { kind: 'buttons'; buttons: ButtonLabel[]; multiple: boolean }
  );

/** popup: 1 (OK), 0 (cancel button), null (closed); input: the text or null; buttons: labels. */
export type DialogResult = number | string | string[] | null;

type Pending = DialogRequest & { resolve: (result: DialogResult) => void };

class ScriptDialogs {
  queue = $state<Pending[]>([]);

  get current(): Pending | undefined {
    return this.queue[0];
  }

  open(request: DialogRequest): Promise<DialogResult> {
    return new Promise((resolve) => this.queue.push({ ...request, resolve }));
  }

  close(result: DialogResult) {
    const current = this.queue[0];
    if (!current) return;
    this.queue = this.queue.slice(1);
    current.resolve(result);
  }
}

export const scriptDialogs = new ScriptDialogs();

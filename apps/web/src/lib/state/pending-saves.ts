/**
 * Edits that are saved a moment after typing stops (presets, templates, personas, World Info
 * entries). Generation reads those from the server, so it flushes them first and always uses what
 * is on screen, as SillyTavern does with its in-memory settings.
 */

const active = new Set<DebouncedSave>();

export class DebouncedSave {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  readonly #save: () => Promise<void>;
  readonly #delay: number;

  constructor(save: () => Promise<void>, delay = 500) {
    this.#save = save;
    this.#delay = delay;
  }

  /** Saves `delay` ms after the last call. */
  schedule() {
    clearTimeout(this.#timer);
    // The save reports its own errors.
    this.#timer = setTimeout(() => void this.flush().catch(() => {}), this.#delay);
    active.add(this);
  }

  /** Saves now if a save is scheduled, and waits for the save in progress. */
  async flush() {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      const run = this.#save().finally(() => {
        if (this.#running === run) this.#running = undefined;
      });
      this.#running = run;
    }
    try {
      await this.#running;
    } finally {
      if (this.#timer === undefined && this.#running === undefined) active.delete(this);
    }
  }

  /** Drops a scheduled save (the edited thing is gone). */
  cancel() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#running === undefined) active.delete(this);
  }
}

/** Waits until every scheduled edit is stored; a failed save does not stop the caller. */
export async function flushPendingSaves() {
  await Promise.allSettled([...active].map((save) => save.flush()));
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebouncedSave, flushPendingSaves } from './pending-saves.ts';

describe('debounced saves', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves once after the last edit', async () => {
    const save = vi.fn(async () => {});
    const saver = new DebouncedSave(save, 500);
    saver.schedule();
    await vi.advanceTimersByTimeAsync(300);
    saver.schedule();
    await vi.advanceTimersByTimeAsync(300);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flushes scheduled edits at once and waits for saves in progress', async () => {
    let finish!: () => void;
    const slow = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const quick = vi.fn(async () => {});
    const a = new DebouncedSave(slow, 500);
    const b = new DebouncedSave(quick, 400);
    a.schedule();
    b.schedule();

    let flushed = false;
    const flushing = flushPendingSaves().then(() => (flushed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(quick).toHaveBeenCalledTimes(1);
    expect(flushed).toBe(false);
    finish();
    await flushing;

    // Nothing is left to save: the timers do not fire again.
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(quick).toHaveBeenCalledTimes(1);
  });

  it('waits for a save that the timer already started', async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    new DebouncedSave(save, 100).schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);

    let flushed = false;
    const flushing = flushPendingSaves().then(() => (flushed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false);
    finish();
    await flushing;
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('drops cancelled edits and keeps going when a save fails', async () => {
    const cancelled = vi.fn(async () => {});
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    const c = new DebouncedSave(cancelled);
    c.schedule();
    c.cancel();
    new DebouncedSave(failing).schedule();
    await expect(flushPendingSaves()).resolves.toBeUndefined();
    expect(cancelled).not.toHaveBeenCalled();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

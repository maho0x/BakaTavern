import { describe, expect, it } from 'vitest';

import { branchChatTitle } from './names.ts';

describe('branchChatTitle', () => {
  it('names branches and checkpoints like SillyTavern (same rule as the server)', () => {
    const none = () => false;
    expect(branchChatTitle('Aiko - 2026', 'branch', none)).toBe('Aiko - 2026 - Branch #1');
    expect(branchChatTitle('Aiko - Branch #1', 'branch', (t) => t === 'Aiko - Branch #1')).toBe(
      'Aiko - Branch #2',
    );
    expect(branchChatTitle('Checkpoint #4 - Aiko', 'checkpoint', none)).toBe('Aiko - Checkpoint #1');
    expect(branchChatTitle('Aiko - Branch #x', 'branch', none)).toBe('Aiko - Branch #x - Branch #1');
  });
});

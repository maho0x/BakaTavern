import { describe, expect, it } from 'vitest';

import { importFromUrl, importSite, parseAiccUrl, parseChubUrl, type ImportFetch } from './url.ts';

const encode = (value: unknown) =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

/** A fake network: answers by URL, records requests. */
function network(answers: Record<string, unknown>) {
  const requests: { url: string; method?: string; body?: string }[] = [];
  const fetch: ImportFetch = async (url, init) => {
    requests.push({ url, method: init?.method, body: init?.body });
    const answer = answers[url];
    if (answer === undefined)
      return { ok: false, status: 404, contentType: 'text/plain', bytes: encode('missing') };
    const bytes = answer instanceof Uint8Array ? answer : encode(answer);
    return {
      ok: true,
      status: 200,
      contentType: answer instanceof Uint8Array ? 'image/png' : 'application/json',
      bytes,
    };
  };
  return { fetch, requests };
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('URL import', () => {
  it('parses site addresses like SillyTavern', () => {
    expect(parseChubUrl('https://chub.ai/characters/alice/witch-123')).toEqual({
      id: 'alice/witch-123',
      type: 'character',
    });
    expect(parseChubUrl('https://www.chub.ai/lorebooks/alice/runes')).toEqual({
      id: 'lorebooks/alice/runes',
      type: 'lorebook',
    });
    expect(parseChubUrl('alice/witch')).toEqual({ id: 'alice/witch', type: 'character' });
    expect(parseAiccUrl('https://aicharactercards.com/charactercards/fantasy/bob/elf-ranger/')).toBe(
      'bob/elf-ranger',
    );
    expect(
      importSite('https://janitorai.com/characters/8c9f2f5e-1111-2222-3333-444455556666_character-x'),
    ).toBe('JanitorAI');
    expect(importSite('https://example.com/card.png')).toBeNull();
    expect(importSite('https://files.catbox.moe/abc.png')).toBe('files.catbox.moe');
  });

  it('builds Chub characters from their metadata, with the avatar', async () => {
    const { fetch, requests } = network({
      'https://api.chub.ai/api/characters/alice/witch?full=true': {
        node: {
          topics: ['fantasy'],
          max_res_url: 'https://avatars.charhub.io/witch.png',
          definition: {
            name: 'Witch',
            personality: 'Casts spells.',
            first_message: 'Hello.',
            description: 'Notes',
          },
        },
      },
      'https://avatars.charhub.io/witch.png': png,
    });
    const result = await importFromUrl('https://chub.ai/characters/alice/witch', fetch);
    expect(result).toMatchObject({
      kind: 'character',
      name: 'Witch.png',
      card: {
        spec: 'chara_card_v2',
        data: {
          name: 'Witch',
          description: 'Casts spells.',
          first_mes: 'Hello.',
          creator_notes: 'Notes',
          creator: 'alice',
          tags: ['fantasy'],
        },
      },
      avatar: { type: 'image/png', bytes: png },
    });
    expect(requests.map((r) => r.url)).toHaveLength(2);
  });

  it('downloads card files from the other sites and allowed hosts only', async () => {
    const janitor = network({
      'https://api.jannyai.com/api/v1/download': { status: 'ok', downloadUrl: 'https://cdn.janitor/c.png' },
      'https://cdn.janitor/c.png': png,
    });
    const result = await importFromUrl(
      'https://janitorai.com/characters/8c9f2f5e-1111-2222-3333-444455556666_character-x',
      janitor.fetch,
    );
    expect(result).toEqual({
      kind: 'character',
      file: { name: '8c9f2f5e-1111-2222-3333-444455556666.png', type: 'image/png', bytes: png },
    });
    expect(janitor.requests[0]).toMatchObject({
      method: 'POST',
      body: '{"characterId":"8c9f2f5e-1111-2222-3333-444455556666"}',
    });

    const risu = network({
      'https://realm.risuai.net/api/v1/download/png-v3/abc123?non_commercial=true': png,
    });
    expect(await importFromUrl('https://realm.risuai.net/character/abc123', risu.fetch)).toMatchObject({
      kind: 'character',
      file: { name: 'abc123.png' },
    });

    const generic = network({ 'https://files.catbox.moe/x7k2.png': png });
    expect(await importFromUrl('https://files.catbox.moe/x7k2.png', generic.fetch)).toMatchObject({
      file: { name: 'x7k2.png' },
    });
    await expect(importFromUrl('https://example.com/a.png', generic.fetch)).rejects.toThrow('not allowed');
  });

  it('imports Chub lorebooks by id', async () => {
    const { fetch } = network({
      'https://api.chub.ai/api/lorebooks/alice/runes': { node: { id: 42 } },
      'https://api.chub.ai/api/v4/projects/42/repository/files/raw%252Fsillytavern_raw.json/raw': {
        entries: {},
      },
    });
    expect(await importFromUrl('lorebooks/alice/runes', fetch)).toMatchObject({
      kind: 'lorebook',
      file: { name: 'runes.json' },
    });
  });
});

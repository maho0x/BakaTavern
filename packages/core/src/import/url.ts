/**
 * Importing characters and lorebooks from the sites SillyTavern knows (its content manager):
 * Chub, JanitorAI, Pygmalion, AICharacterCards, RisuRealm, Perchance, and whitelisted hosts for
 * plain card files. Input is a URL or, like SillyTavern's "UUID" import, a site id.
 *
 * Network access is the caller's (`fetch` goes through BakaTavern's server); this module knows
 * where to look and how to turn the answers into card files or card data.
 */

export interface FetchedFile {
  ok: boolean;
  status: number;
  contentType: string;
  bytes: Uint8Array;
}

export type ImportFetch = (
  url: string,
  init?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
) => Promise<FetchedFile>;

export interface ImportedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export type UrlImport =
  /** A card file to import as it is (PNG, JSON). */
  | { kind: 'character'; file: ImportedFile }
  /** Card data built from the site's answer, with the avatar image when there is one. */
  | { kind: 'character'; card: Record<string, unknown>; avatar?: ImportedFile; name: string }
  | { kind: 'lorebook'; file: ImportedFile };

/** Hosts plain card files may come from (SillyTavern's `whitelistImportDomains` default). */
export const defaultImportHosts = [
  'localhost',
  'cdn.discordapp.com',
  'files.catbox.moe',
  'raw.githubusercontent.com',
];

const USER_AGENT = 'BakaTavern';
const decoder = new TextDecoder();
const json = (file: FetchedFile): unknown => JSON.parse(decoder.decode(file.bytes));
/** A file name without characters file systems reject (like the `sanitize-filename` package). */
const sanitize = (name: string) =>
  [...name]
    .filter((c) => {
      const code = c.codePointAt(0)!;
      return !'/\\?<>:*|"'.includes(c) && code > 0x1f && (code < 0x80 || code > 0x9f);
    })
    .join('')
    .replace(/^\.+$/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 255);

export class ImportError extends Error {}

const fail = (message: string): never => {
  throw new ImportError(message);
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const uuidIn = (text: string) =>
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/.exec(text)?.[0] ?? null;

/** `creator/name` or `lorebooks/creator/name` from a Chub address (`parseChubUrl`). */
export function parseChubUrl(text: string): { id: string; type: 'character' | 'lorebook' } | null {
  const parts = text.split('/');
  let domain = -1;
  parts.forEach((part, i) => {
    if (['www.chub.ai', 'chub.ai', 'www.characterhub.org', 'characterhub.org'].includes(part)) domain = i;
  });
  const clean = domain !== -1 ? parts.slice(domain + 1) : parts;
  if (clean.length < 2) return null;
  const first = clean[0]!.toLowerCase();
  if (first === 'characters' || first === 'lorebooks') {
    const type = first === 'characters' ? 'character' : 'lorebook';
    return { id: type === 'character' ? clean.slice(1).join('/') : clean.join('/'), type };
  }
  return clean.length === 2 ? { id: clean.join('/'), type: 'character' } : null;
}

/** `author/card` from an AICharacterCards address (`parseAICC`). */
export function parseAiccUrl(text: string): string | null {
  const parts = (isUrl(text) ? new URL(text).pathname : text).split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
}

export function parseRisuUrl(text: string): string | null {
  return /^https?:\/\/realm\.risuai\.net\/character\/([a-f0-9-]+)\/?$/i.exec(text)?.[1] ?? null;
}

const isPerchanceId = (text: string) => /^\w+~[a-f0-9]{32}\.gz$/.test(text);
const perchanceSlug = (text: string) => text.split('~')[1] ?? '';

async function chubCharacter(id: string, fetch: ImportFetch): Promise<UrlImport> {
  const [creator, project] = id.split('/');
  const meta = await fetch(`https://api.chub.ai/api/characters/${creator}/${project}?full=true`, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  if (!meta.ok) fail('Chub could not find this character.');
  const node = (json(meta) as { node: Record<string, unknown> }).node;
  const definition = node.definition as Record<string, unknown>;
  const card = {
    data: {
      name: definition.name,
      description: definition.personality,
      personality: definition.tavern_personality,
      scenario: definition.scenario,
      first_mes: definition.first_message,
      mes_example: definition.example_dialogs,
      creator_notes: definition.description,
      system_prompt: definition.system_prompt,
      post_history_instructions: definition.post_history_instructions,
      alternate_greetings: definition.alternate_greetings,
      tags: node.topics,
      creator,
      character_version: '',
      character_book: definition.embedded_lorebook,
      extensions: definition.extensions,
    },
    spec: 'chara_card_v2',
    spec_version: '2.0',
  };
  let avatar: ImportedFile | undefined;
  if (typeof node.max_res_url === 'string' && node.max_res_url) {
    const image = await fetch(node.max_res_url);
    if (image.ok) avatar = { name: 'avatar', type: image.contentType, bytes: image.bytes };
  }
  return { kind: 'character', card, avatar, name: `${sanitize(String(definition.name ?? project))}.png` };
}

async function chubLorebook(id: string, fetch: ImportFetch): Promise<UrlImport> {
  const [lorebooks, creator, project] = id.split('/');
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  const meta = await fetch(`https://api.chub.ai/api/${lorebooks}/${creator}/${project}`, { headers });
  if (!meta.ok) fail('Chub could not find this lorebook.');
  const projectId = (json(meta) as { node?: { id?: unknown } }).node?.id;
  if (!projectId) fail('Chub did not say where the lorebook is.');
  const file = await fetch(
    `https://api.chub.ai/api/v4/projects/${projectId}/repository/files/raw%252Fsillytavern_raw.json/raw`,
    { headers },
  );
  if (!file.ok) fail('Chub could not send the lorebook.');
  return {
    kind: 'lorebook',
    file: { name: `${sanitize(project!)}.json`, type: file.contentType, bytes: file.bytes },
  };
}

async function pygmalionCharacter(id: string, fetch: ImportFetch): Promise<UrlImport> {
  const result = await fetch(`https://server.pygmalion.chat/api/export/character/${id}/v2`);
  if (!result.ok) fail('Pygmalion could not send this character.');
  const data = json(result) as { character?: Record<string, unknown> };
  const character = data.character;
  if (!character || typeof character !== 'object') return fail('Pygmalion sent no character.');
  const avatarUrl = (character.data as { avatar?: unknown } | undefined)?.avatar;
  if (typeof avatarUrl === 'string' && avatarUrl) {
    const image = await fetch(avatarUrl).catch(() => null);
    if (image?.ok) {
      return {
        kind: 'character',
        card: character,
        avatar: { name: 'avatar', type: image.contentType, bytes: image.bytes },
        name: `${sanitize(id)}.png`,
      };
    }
  }
  // Without an avatar the whole answer is imported as JSON, as SillyTavern does.
  return {
    kind: 'character',
    file: { name: `${sanitize(id)}.json`, type: 'application/json', bytes: result.bytes },
  };
}

async function janitorCharacter(uuid: string, fetch: ImportFetch): Promise<UrlImport> {
  const result = await fetch('https://api.jannyai.com/api/v1/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: uuid }),
  });
  if (result.ok) {
    const answer = json(result) as { status?: string; downloadUrl?: string };
    if (answer.status === 'ok' && answer.downloadUrl) {
      const image = await fetch(answer.downloadUrl);
      if (image.ok)
        return {
          kind: 'character',
          file: { name: `${sanitize(uuid)}.png`, type: image.contentType, bytes: image.bytes },
        };
    }
  }
  return fail('JanitorAI could not send this character (some characters are not available there).');
}

async function aiccCharacter(id: string, fetch: ImportFetch): Promise<UrlImport> {
  const result = await fetch(`https://aicharactercards.com/wp-json/pngapi/v1/image/${id}`);
  if (!result.ok) fail('AICharacterCards could not send this character.');
  return {
    kind: 'character',
    file: { name: `${sanitize(id)}.png`, type: result.contentType || 'image/png', bytes: result.bytes },
  };
}

async function risuCharacter(uuid: string, fetch: ImportFetch): Promise<UrlImport> {
  const result = await fetch(`https://realm.risuai.net/api/v1/download/png-v3/${uuid}?non_commercial=true`);
  if (!result.ok) fail('RisuRealm could not send this character.');
  return {
    kind: 'character',
    file: { name: `${sanitize(uuid)}.png`, type: 'image/png', bytes: result.bytes },
  };
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function perchanceCharacter(slug: string, fetch: ImportFetch): Promise<UrlImport> {
  const url = `https://user.uploads.dev/file/${slug}`;
  const result = await fetch(url, {
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
  });
  if (!result.ok) fail('Perchance could not send this character.');
  const parsed = JSON.parse(await gunzip(result.bytes)) as { addCharacter?: Record<string, unknown> };
  const character = parsed.addCharacter;
  if (!character) return fail('Perchance sent no character.');
  const avatarUrl = (character.avatar as { url?: unknown } | undefined)?.url;
  const avatarIsData = typeof avatarUrl === 'string' && avatarUrl.startsWith('data:image/');
  const name = String(character.name || 'Unnamed Perchance Character');
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      first_mes: '',
      tags: [],
      description: character.roleInstruction || '',
      creator: character.metaTitle || '',
      creator_notes: character.metaDescription || '',
      alternate_greetings: [],
      character_version: '',
      mes_example: '',
      post_history_instructions: '',
      system_prompt: '',
      scenario: '',
      personality: character.reminderMessage || '',
      extensions: {
        perchance_data: {
          slug,
          char_url: url,
          uuid: character.uuid || null,
          avatar_url: avatarIsData ? null : avatarUrl || null,
          folder_path: character.folderPath || null,
          folder_name: character.folderName || null,
          custom_data: character.customData || {},
        },
      },
    },
  };
  let avatar: ImportedFile | undefined;
  if (avatarIsData) {
    const [header, data] = (avatarUrl as string).split(',');
    const binary = atob(data ?? '');
    avatar = {
      name: 'avatar',
      type: /data:([^;]+)/.exec(header ?? '')?.[1] ?? 'image/png',
      bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    };
  } else if (typeof avatarUrl === 'string' && isUrl(avatarUrl)) {
    const image = await fetch(avatarUrl, { headers: { 'User-Agent': USER_AGENT } }).catch(() => null);
    if (image?.ok) avatar = { name: 'avatar', type: image.contentType, bytes: image.bytes };
  }
  return { kind: 'character', card, avatar, name: `${name}.png` };
}

async function genericCard(url: string, fetch: ImportFetch): Promise<UrlImport> {
  const result = await fetch(url);
  if (!result.ok) fail(`The site answered ${result.status}.`);
  let name = sanitize(url.split('?')[0]!.split('/').reverse()[0] ?? '') || 'card';
  const type = result.contentType || 'image/png';
  if (type === 'image/png' && !/\.(\w+)$/.test(name)) name += '.png';
  return { kind: 'character', file: { name, type, bytes: result.bytes } };
}

/** The site an address or id belongs to, for messages (`null` when it cannot be imported). */
export function importSite(
  input: string,
  allowedHosts: readonly string[] = defaultImportHosts,
): string | null {
  if (!isUrl(input)) {
    if (input.includes('_character')) return 'JanitorAI';
    if (input.length === 36) return 'Pygmalion';
    if (input.startsWith('AICC/')) return 'AICharacterCards';
    if (isPerchanceId(input)) return 'Perchance';
    return 'Chub';
  }
  const host = hostOf(input);
  if (host.includes('pygmalion.chat')) return 'Pygmalion';
  if (host.includes('janitorai')) return 'JanitorAI';
  if (host.includes('aicharactercards.com')) return 'AICharacterCards';
  if (host.includes('chub.ai') || host.includes('characterhub.org')) return 'Chub';
  if (host.includes('realm.risuai.net')) return 'RisuRealm';
  if (host.includes('perchance.org')) return 'Perchance';
  return allowedHosts.includes(host) ? host : null;
}

/**
 * Downloads what an address (SillyTavern's `importURL`) or a site id (`importUUID`) points to.
 * Plain card files come only from `allowedHosts`.
 */
export async function importFromUrl(
  input: string,
  fetch: ImportFetch,
  allowedHosts: readonly string[] = defaultImportHosts,
): Promise<UrlImport> {
  const text = input.trim();
  if (!isUrl(text)) {
    if (text.includes('_character')) return janitorCharacter(text.split('_')[0]!, fetch);
    if (text.length === 36) return pygmalionCharacter(text, fetch);
    if (text.startsWith('AICC/')) {
      const [, author, card] = text.split('/');
      return aiccCharacter(`${author}/${card}`, fetch);
    }
    if (isPerchanceId(text)) return perchanceCharacter(perchanceSlug(text), fetch);
    return text.includes('lorebook') ? chubLorebook(text, fetch) : chubCharacter(text, fetch);
  }
  const host = hostOf(text);
  if (host.includes('pygmalion.chat')) {
    const uuid = uuidIn(text);
    return uuid ? pygmalionCharacter(uuid, fetch) : fail('No character id in this address.');
  }
  if (host.includes('janitorai')) {
    const uuid = uuidIn(text);
    return uuid ? janitorCharacter(uuid, fetch) : fail('No character id in this address.');
  }
  if (host.includes('aicharactercards.com')) {
    const id = parseAiccUrl(text);
    return id ? aiccCharacter(id, fetch) : fail('No character in this address.');
  }
  if (host.includes('chub.ai') || host.includes('characterhub.org')) {
    const parsed = parseChubUrl(text);
    if (parsed?.type === 'character') return chubCharacter(parsed.id, fetch);
    if (parsed?.type === 'lorebook') return chubLorebook(parsed.id, fetch);
    return fail('No character or lorebook in this address.');
  }
  if (host.includes('realm.risuai.net')) {
    const uuid = parseRisuUrl(text);
    return uuid ? risuCharacter(uuid, fetch) : fail('No character in this address.');
  }
  if (host.includes('perchance.org')) {
    const slug = perchanceSlug(text);
    return slug ? perchanceCharacter(slug, fetch) : fail('No character in this address.');
  }
  if (allowedHosts.includes(host)) return genericCard(text, fetch);
  return fail(`Importing from ${host || 'this address'} is not allowed.`);
}

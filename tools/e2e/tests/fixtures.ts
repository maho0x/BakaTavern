import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function textChunk(keyword: string, value: object): Buffer {
  const base64 = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return chunk('tEXt', Buffer.from(`${keyword}\0${base64}`, 'latin1'));
}

/** A small portrait PNG carrying SillyTavern card chunks: `chara` (V2) and/or `ccv3` (V3). */
export function cardPng(
  card: { v2?: object; v3?: object },
  rgb: [number, number, number] = [95, 195, 174],
): Buffer {
  const [width, height] = [64, 96];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    ...(card.v2 ? [textChunk('chara', card.v2)] : []),
    ...(card.v3 ? [textChunk('ccv3', card.v3)] : []),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A V2 card with an embedded lorebook, as exported by SillyTavern. */
export function v2Card(name: string) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: '{{char}} is a cheerful barista at the Moonlit Café.',
      personality: 'cheerful, curious',
      scenario: '{{user}} walks into the café on a rainy evening.',
      first_mes: '*{{char}} looks up from the counter.* Welcome in, {{user}}! Rough weather out there?',
      mes_example: '<START>\n{{user}}: Hi!\n{{char}}: Oh, hello there!',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: ['*{{char}} waves from behind the espresso machine.* Back again?'],
      tags: ['cafe', 'slice of life'],
      creator: 'e2e',
      character_version: '1.0',
      extensions: {},
      character_book: {
        name: `${name}'s café`,
        entries: [
          {
            id: 0,
            keys: ['menu'],
            content: 'The Moonlit Café serves matcha lattes and lemon tarts.',
            enabled: true,
            insertion_order: 100,
            extensions: {},
          },
        ],
      },
    },
  };
}

/** A V3 card (written by newer editors). */
export function v3Card(name: string) {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      description: '{{char}} is a terse starship engineer.',
      personality: '',
      scenario: '',
      first_mes: 'Reactor’s humming. What do you need?',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      group_only_greetings: [],
      tags: ['sci-fi'],
      creator: 'e2e',
      character_version: '3',
      extensions: {},
      nickname: 'Chief',
    },
  };
}

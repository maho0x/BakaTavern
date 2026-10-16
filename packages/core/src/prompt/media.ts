/**
 * Message attachments as SillyTavern stores them (`extra.media`, `extra.files`) and their place in
 * the prompt: file text before the message, images, videos and audio inlined into Chat Completion
 * messages for models that accept them.
 *
 * Loading the files (fetching, converting, measuring) is the browser's job; core asks for it
 * through a `MediaResolver`.
 */

export type MediaType = 'image' | 'video' | 'audio';

/** SillyTavern `MediaAttachment`. */
export interface MediaAttachment {
  url: string;
  type?: MediaType;
  title?: string;
  /** `upload`, `generated`, `captioned`, `api`. */
  source?: string;
  /** Add the title to the message text in the prompt. */
  append_title?: boolean;
}

/** SillyTavern file attachment (`extra.files[]`); its text is a plain-text file at `url`. */
export interface FileAttachment {
  url: string;
  size?: number;
  name?: string;
  created?: number;
  /** Text kept with the attachment (otherwise read from `url`). */
  text?: string;
}

export interface MessageAttachments {
  media: MediaAttachment[];
  /** `list` sends every attachment, `gallery` the one shown (`index`). */
  display: 'list' | 'gallery';
  index: number;
  files: FileAttachment[];
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * A message's attachments, older formats included (SillyTavern `ensureMessageMediaIsArray`:
 * `extra.image`, `extra.image_swipes`, `extra.video`, `extra.file`).
 */
export function messageAttachments(
  extra: unknown,
  defaultDisplay: 'list' | 'gallery' = 'list',
): MessageAttachments {
  const e = record(extra);
  const media: MediaAttachment[] = Array.isArray(e.media)
    ? e.media.filter((m): m is MediaAttachment => typeof record(m).url === 'string')
    : [];
  let display = e.media_display;
  let index = Number(e.media_index);
  if (Array.isArray(e.image_swipes)) {
    for (const url of e.image_swipes) {
      if (url && typeof url === 'string') {
        display = 'gallery';
        media.push({ type: 'image', url });
      }
    }
  }
  if (typeof e.image === 'string' && e.image) {
    media.push({ type: 'image', url: e.image });
    if (display === 'gallery') {
      const selected = media.findIndex((m) => m.url === e.image);
      if (selected > -1) index = selected;
    }
  }
  const unique = media.filter((m, i, all) => i === all.findIndex((x) => x.url === m.url));
  if (typeof e.video === 'string' && e.video) unique.push({ type: 'video', url: e.video });
  const files: FileAttachment[] = Array.isArray(e.files)
    ? e.files.filter((f): f is FileAttachment => typeof record(f).url === 'string')
    : [];
  if (typeof record(e.file).url === 'string') files.push(e.file as FileAttachment);
  const shown = display || defaultDisplay;
  return {
    media: unique,
    display: shown === 'gallery' ? 'gallery' : 'list',
    index: Number.isInteger(index) && index >= 0 && index < unique.length ? index : 0,
    files,
  };
}

/** Loads attachments for the prompt. */
export interface MediaResolver {
  /**
   * The image as a data URL in a type every provider takes (JPEG, PNG or WebP) and its size.
   * `compress` asks for at most 2048 px per side when it is larger than 2 MB.
   */
  image(url: string, compress: boolean): Promise<{ dataUrl: string; width: number; height: number } | null>;
  /** Video or audio as a data URL, with its length in seconds when it can be read. */
  video(url: string): Promise<{ dataUrl: string; duration?: number } | null>;
  audio(url: string): Promise<{ dataUrl: string; duration?: number } | null>;
  /** The text of a file attachment. */
  fileText(url: string): Promise<string>;
}

/** What the model accepts inline, and how images are sent. */
export interface MediaInlining {
  image: boolean;
  video: boolean;
  audio: boolean;
  /** `low`, `high` or `auto` (SillyTavern `inline_image_quality`). */
  quality: string;
  /** Large images are scaled down for this source. */
  compress: boolean;
  resolver: MediaResolver;
}

/** Models listed by their provider with what they accept (a `/models` entry). */
export type ModelListEntry = Record<string, unknown>;

const VISION_MODELS = [
  // OpenAI
  'chatgpt-4o-latest',
  'gpt-4-turbo',
  'gpt-4-vision',
  'gpt-4.1',
  'gpt-4.5-preview',
  'gpt-4o',
  'gpt-6-astra',
  'gpt-5',
  'o1',
  'o3',
  'o4-mini',
  // Claude
  'claude-3',
  'claude-fable',
  'claude-opus-4',
  'claude-opus-5',
  'claude-sonnet-4',
  'claude-sonnet-5',
  'claude-haiku-4',
  // Cohere
  'c4ai-aya-vision',
  'command-a-vision',
  // Google AI Studio
  'gemini-2.0',
  'gemini-2.5',
  'gemini-3',
  'gemini-exp-1206',
  'learnlm',
  'gemini-robotics',
  'gemma-3-27b',
  'gemma-3-12b',
  'gemma-3-4b',
  'gemma-4',
  // MistralAI
  'mistral-small-2503',
  'mistral-small-2506',
  'mistral-small-latest',
  'mistral-medium-latest',
  'mistral-medium-2505',
  'mistral-medium-2508',
  'pixtral',
  // xAI
  'grok-4',
  'grok-2-vision',
  // Moonshot
  'moonshot-v1-8k-vision-preview',
  'moonshot-v1-32k-vision-preview',
  'moonshot-v1-128k-vision-preview',
  'kimi-k2.5',
  'kimi-latest',
  // DeepSeek
  'deepseek-v4-flash-vision-exp',
  // Z.AI
  'glm-4.5v',
  'glm-4.6v',
  'glm-5v-turbo',
  'autoglm-phone',
  // SiliconFlow
  'Qwen/Qwen3-VL-32B-Instruct',
  'Qwen/Qwen3-VL-8B-Instruct',
  'Qwen/Qwen3-VL-235B-A22B-Instruct',
  'Qwen/Qwen3-VL-30B-A3B-Instruct',
  'zai-org/GLM-4.5V',
];

const VIDEO_MODELS = [
  'gemini-2.0',
  'gemini-2.5',
  'gemini-exp-1206',
  'gemini-3',
  'gemma-4',
  'glm-4.5v',
  'glm-4.6v',
  'glm-5v-turbo',
];

const AUDIO_MODELS = [
  'gemini-2.0',
  'gemini-2.5',
  'gemini-3',
  'gemini-exp-1206',
  'gpt-4o-audio',
  'gpt-4o-realtime',
  'gpt-4o-mini-audio',
  'gpt-4o-mini-realtime',
  'gpt-audio',
  'gpt-realtime',
];

const listed = (models: readonly string[], model: string) => models.some((m) => model.includes(m));
const modalities = (entry: ModelListEntry | undefined, path: 'architecture' | 'root') =>
  (path === 'architecture' ? record(entry?.architecture).input_modalities : entry?.input_modalities) as
    unknown[] | undefined;

/** SillyTavern's `isImageInliningSupported` (with media inlining on). */
export function imageInliningSupported(source: string, model: string, entry?: ModelListEntry): boolean {
  switch (source) {
    case 'openai':
    case 'azure_openai':
      return (
        listed(VISION_MODELS, model) &&
        ['gpt-4-turbo-preview', 'o1-mini', 'o3-mini'].some((x) => !model.includes(x))
      );
    case 'makersuite':
    case 'vertexai':
    case 'claude':
    case 'cohere':
    case 'xai':
    case 'zai':
    case 'siliconflow':
    case 'deepseek':
      return listed(VISION_MODELS, model);
    case 'openrouter':
      return Boolean(modalities(entry, 'architecture')?.includes('image'));
    case 'custom':
    case 'cometapi':
      return true;
    case 'mistralai':
      return Boolean(record(entry?.capabilities).vision);
    case 'aimlapi':
      return Boolean((entry?.features as unknown[] | undefined)?.includes('openai/chat-completion.vision'));
    case 'chutes':
    case 'pollinations':
      return Boolean(modalities(entry, 'root')?.includes('image'));
    case 'electronhub':
      return Boolean(record(entry?.metadata).vision);
    case 'moonshot':
      return Boolean(entry?.supports_image_in);
    case 'nanogpt':
      return Boolean(record(entry?.capabilities).vision);
    case 'workers_ai':
      return Boolean(
        Array.isArray(entry?.properties) &&
        entry.properties.some((p) => record(p).property_id === 'vision' && record(p).value === 'true'),
      );
    case 'fireworks':
      return Boolean(entry?.supports_image_input);
    default:
      return false;
  }
}

/** SillyTavern's `isVideoInliningSupported`. */
export function videoInliningSupported(source: string, model: string, entry?: ModelListEntry): boolean {
  switch (source) {
    case 'makersuite':
    case 'vertexai':
    case 'zai':
      return listed(VIDEO_MODELS, model);
    case 'openrouter':
      return Boolean(modalities(entry, 'architecture')?.includes('video'));
    default:
      return false;
  }
}

/** SillyTavern's `isAudioInliningSupported`. */
export function audioInliningSupported(source: string, model: string, entry?: ModelListEntry): boolean {
  switch (source) {
    case 'openai':
    case 'makersuite':
    case 'vertexai':
      return listed(AUDIO_MODELS, model);
    case 'openrouter':
      return Boolean(modalities(entry, 'architecture')?.includes('audio'));
    case 'custom':
      return true;
    default:
      return false;
  }
}

/** Sources whose large images are scaled down (SillyTavern `compressImage`). */
export const compressImageSources = ['openrouter', 'makersuite', 'mistralai', 'vertexai'];

export const TOKENS_PER_IMAGE = 85;

/** OpenAI's image cost, which SillyTavern counts for every provider (`getImageTokenCost`). */
export function imageTokenCost(width: number, height: number, quality: string): number {
  if (quality === 'low') return TOKENS_PER_IMAGE;
  if (quality === 'auto' && width <= 512 && height <= 512) return TOKENS_PER_IMAGE;
  const scale = 2048 / Math.min(width, height);
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  const finalScale = 768 / Math.min(scaledWidth, scaledHeight);
  const finalWidth = Math.round(scaledWidth * finalScale);
  const finalHeight = Math.round(scaledHeight * finalScale);
  const squares = Math.ceil(finalWidth / 512) * Math.ceil(finalHeight / 512);
  return squares * 170 + 85;
}

/**
 * The message text with its attachments for the prompt (SillyTavern `appendFileContent` and the
 * titles of `append_title` attachments).
 */
export async function withAttachmentText(
  text: string,
  extra: unknown,
  fileText: ((url: string) => Promise<string>) | undefined,
): Promise<string> {
  const { media, files } = messageAttachments(extra);
  let result = text;
  if (files.length) {
    const texts: string[] = [];
    for (const file of files) {
      let content = file.text ?? '';
      if (!content && fileText) {
        try {
          content = await fileText(file.url);
        } catch {
          content = '';
        }
      }
      if (content) texts.push(content);
    }
    result = `${texts.join('\n\n')}\n\n${result}`;
  }
  const e = record(extra);
  const titles: string[] = [];
  if (e.append_title && e.title) titles.push(String(e.title));
  for (const item of media) if (item.title && item.append_title) titles.push(item.title);
  if (titles.length) result = `${result}\n\n${titles.join('\n\n')}`;
  return result;
}

/**
 * Message attachments in the browser: uploading what the user attaches (stored the way
 * SillyTavern stores it, `extra.media` and `extra.files`) and loading attachments for the prompt
 * (core's `MediaResolver`: fetch, convert, measure).
 */

import type { FileAttachment, MediaAttachment, MediaResolver, MediaType } from '@bakatavern/core';

import { api } from '../api.ts';

export interface PendingAttachment {
  id: string;
  file: File;
  kind: MediaType | 'file';
  /** Object URL for showing images before they are sent. */
  preview?: string;
}

const TEXT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'csv',
  'tsv',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'log',
  'ini',
  'toml',
  'srt',
  'vtt',
  'js',
  'ts',
  'py',
  'css',
];

export function attachmentKind(file: File): PendingAttachment['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Files whose text can go into the prompt. */
export function isTextFile(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return (
    file.type.startsWith('text/') ||
    /json|xml|yaml|javascript|x-subrip/.test(file.type) ||
    TEXT_EXTENSIONS.includes(extension)
  );
}

/** The text of a file attachment; web pages lose their markup (SillyTavern converts them too). */
async function fileText(file: File): Promise<string> {
  const text = await file.text();
  if (/html/.test(file.type) || /\.html?$/i.test(file.name)) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return (doc.body?.innerText || doc.body?.textContent || '').trim();
  }
  return text;
}

/** The address an uploaded file is stored under (relative, so it survives a new host name). */
const fileUrl = (hash: string) => `/api/files/${hash}`;

/** Uploads attachments; returns the message `extra` fields that list them. */
export async function uploadAttachments(
  list: readonly PendingAttachment[],
): Promise<Record<string, unknown>> {
  const media: MediaAttachment[] = [];
  const files: FileAttachment[] = [];
  for (const item of list) {
    if (item.kind === 'file') {
      // As in SillyTavern, the attachment is the file's text.
      const text = await fileText(item.file);
      const record = await api.uploadFile(new File([text], `${item.file.name}.txt`, { type: 'text/plain' }));
      files.push({
        url: fileUrl(record.hash),
        size: item.file.size,
        name: item.file.name,
        created: Date.now(),
      });
    } else {
      const record = await api.uploadFile(item.file);
      media.push({ url: fileUrl(record.hash), type: item.kind, title: item.file.name, source: 'upload' });
    }
  }
  const extra: Record<string, unknown> = {};
  if (media.length) Object.assign(extra, { media, media_index: media.length - 1, inline_image: true });
  if (files.length) extra.files = files;
  return extra;
}

// ---------------------------------------------------------------------------------------------
// Loading attachments for the prompt

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'force-cache' });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.blob();
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('could not load the image'));
    image.src = src;
  });
}

/** SillyTavern's `createThumbnail`: a JPEG on white, at most `max` px per side (no upscaling). */
async function thumbnail(src: string, max: number | null): Promise<string> {
  const image = await loadImage(src);
  let width = image.width;
  let height = image.height;
  if (max !== null && (width > max || height > max)) {
    const ratio = width / height;
    if (width > height) {
      width = max;
      height = max / ratio;
    } else {
      height = max;
      width = max * ratio;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = 'white';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg');
}

const SAFE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function mediaDuration(src: string, kind: 'video' | 'audio'): Promise<number | undefined> {
  return new Promise((resolve) => {
    const element = document.createElement(kind);
    element.preload = 'metadata';
    element.onloadedmetadata = () =>
      resolve(Number.isFinite(element.duration) ? element.duration : undefined);
    element.onerror = () => resolve(undefined);
    element.src = src;
  });
}

/** Attachments for the prompt, as SillyTavern's browser prepares them. */
export const browserAttachments: MediaResolver = {
  async image(url, compress) {
    const blob = await fetchBlob(url);
    let src = await dataUrl(blob);
    const mime = src.slice(5, src.indexOf(';'));
    if (compress && src.length * 0.75 > 2 * 1024 * 1024) src = await thumbnail(src, 2048);
    else if (!SAFE_IMAGE_TYPES.includes(mime)) src = await thumbnail(src, null);
    const image = await loadImage(src);
    return { dataUrl: src, width: image.width, height: image.height };
  },
  async video(url) {
    const src = await dataUrl(await fetchBlob(url));
    return { dataUrl: src, duration: await mediaDuration(src, 'video') };
  },
  async audio(url) {
    const src = await dataUrl(await fetchBlob(url));
    return { dataUrl: src, duration: await mediaDuration(src, 'audio') };
  },
  async fileText(url) {
    return (await fetchBlob(url)).text();
  },
};

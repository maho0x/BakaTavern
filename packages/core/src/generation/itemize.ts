/**
 * What a generation's prompt is made of, in tokens (SillyTavern's prompt itemization): its
 * parts, the context they had to fit in, the activated World Info and the final messages or text.
 */

import type { ChatMessage } from '../prompt/types.ts';
import { textCounter, type Tokenizer } from '../tokenizers/index.ts';
import { defaultFormattingSettings, type PreparedGeneration, type PrepareOptions } from './prepare.ts';

export interface PromptItem {
  /** Chat Completion: the prompt's identifier (`main`, `chatHistory`, ...); Text Completion: the part. */
  id: string;
  /** The prompt's name, for prompts of the preset. */
  name?: string;
  tokens: number;
  /** Counted inside another part (Text Completion's story string contents). */
  within?: string;
}

export interface PromptItemization {
  api: 'chat' | 'text';
  /** Provider (Chat Completion) or backend type (Text Completion). */
  source: string;
  model: string;
  tokenizer: string;
  maxContext: number;
  maxResponse: number;
  /** Tokens kept free on top (Text Completion's token padding). */
  padding: number;
  total: number;
  items: PromptItem[];
  /** World Info entries that were activated. */
  worldInfo: { book: string; uid: number; comment: string; tokens: number }[];
  /** Chat Completion: the messages sent. */
  messages?: ChatMessage[];
  /** Text Completion: the prompt sent. */
  prompt?: string;
}

export async function itemizePrompt(
  prepared: PreparedGeneration,
  options: PrepareOptions,
  tokenizer: Tokenizer,
): Promise<PromptItemization> {
  const count = textCounter(tokenizer);
  const worldInfo = await Promise.all(
    prepared.worldInfo.activated.map(async (e) => ({
      book: e.world,
      uid: e.uid,
      comment: e.comment ?? '',
      tokens: await count(e.content ?? ''),
    })),
  );
  if (prepared.api === 'chat' && options.api !== 'text') {
    const preset = options.preset;
    const items = prepared.prompt.parts.map((part) => ({
      id: part.identifier,
      name: preset.prompts.find((p) => p.identifier === part.identifier && !p.system_prompt)?.name,
      tokens: part.tokens,
    }));
    return {
      api: 'chat',
      source: options.connection.provider.id,
      model: prepared.model,
      tokenizer: tokenizer.id,
      maxContext: preset.openai_max_context,
      maxResponse: preset.openai_max_tokens,
      padding: 0,
      total: prepared.prompt.tokens,
      items,
      worldInfo,
      messages: prepared.prompt.messages,
    };
  }
  if (prepared.api !== 'text' || options.api !== 'text') throw new Error('mismatched generation');
  const result = prepared.prompt;
  const env = prepared.env;
  const formatting = options.formatting ?? defaultFormattingSettings;
  const items: PromptItem[] = [];
  const add = async (id: string, text: string | undefined, within?: string) => {
    const tokens = text ? await count(text) : 0;
    if (tokens) items.push({ id, tokens, ...(within ? { within } : {}) });
  };
  await add('storyString', result.storyString);
  // What the story string is made of, as SillyTavern lists it.
  await add('charDescription', env.description, 'storyString');
  await add('charPersonality', env.personality, 'storyString');
  await add('scenario', env.scenario, 'storyString');
  await add('personaDescription', env.persona, 'storyString');
  await add('worldInfoBefore', prepared.worldInfo.before, 'storyString');
  await add('worldInfoAfter', prepared.worldInfo.after, 'storyString');
  await add('dialogueExamples', result.examples);
  await add('chatHistory', result.messages);
  await add('continuePrompt', result.continuePrompt);
  return {
    api: 'text',
    source: options.text.settings.type,
    model: prepared.model,
    tokenizer: tokenizer.id,
    maxContext: options.text.maxContext,
    maxResponse: options.text.maxResponse,
    padding: formatting.tokenPadding,
    total: await count(result.prompt),
    items,
    worldInfo,
    prompt: result.prompt,
  };
}

/** SillyTavern 1.19's default formatting templates and Text Completion presets. */

export interface StTemplate {
  name: string;
  data: Record<string, unknown>;
}

export interface StTemplates {
  context: StTemplate[];
  instruct: StTemplate[];
  sysprompt: StTemplate[];
  reasoning: StTemplate[];
  textgen: StTemplate[];
}

/**
 * Loads SillyTavern's `default/content/presets` templates (context, instruct, system prompt,
 * reasoning) and Text Completion presets. A separate chunk: only needed to seed new users.
 */
export async function loadStTemplates(): Promise<StTemplates> {
  const module = await import('./st-templates.json', { with: { type: 'json' } });
  return module.default as StTemplates;
}

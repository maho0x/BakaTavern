/**
 * What scripts on the page can use: `window.BakaTavern` (function tools the model may call).
 * Plugins get more, with permissions, through the plugin API (`plugins/host.svelte.ts`).
 */

import { registerTool, unregisterTool, type RegisteredTool } from './generation/tools.ts';

export interface PageApi {
  tools: {
    register(tool: RegisteredTool): void;
    unregister(name: string): void;
  };
}

declare global {
  interface Window {
    BakaTavern?: PageApi;
  }
}

export function exposePageApi() {
  window.BakaTavern = Object.freeze({
    tools: Object.freeze({ register: registerTool, unregister: unregisterTool }),
  });
}

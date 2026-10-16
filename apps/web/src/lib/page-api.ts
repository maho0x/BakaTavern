/**
 * What scripts on the page can use: `window.BakaTavern`. Experimental until the plugin API (M3);
 * for now it registers function tools the model may call.
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

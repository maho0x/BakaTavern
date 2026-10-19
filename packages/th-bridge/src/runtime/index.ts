/**
 * Runs inside a front-end frame before the card's own code: the libraries TavernHelper provides
 * (lodash, jQuery, zod, YAML, toastr) and its functions, as globals and as `TavernHelper`.
 * Built into one classic script (`pnpm --filter @bakatavern/th-bridge build`).
 */

import $ from 'jquery';
import _ from 'lodash';
import YAML from 'yaml';
import * as z from 'zod';

import { tavernEvents } from '../events.ts';
import type { FrameConfig } from '../protocol.ts';
import { chatApi } from './api/chat.ts';
import { globalsApi } from './api/globals.ts';
import { miscApi } from './api/misc.ts';
import { sillyTavernApi, toastrShim } from './api/sillytavern.ts';
import { variablesApi } from './api/variables.ts';
import { worldbookApi } from './api/worldbook.ts';
import { macroSubstitute, type Runtime } from './context.ts';
import { FrameEvents } from './events.ts';
import { Mirror } from './state.ts';
import { Transport } from './transport.ts';

declare global {
  interface Window {
    __TH_CONFIG__?: FrameConfig;
  }
}

const config = window.__TH_CONFIG__;
if (config) install(config);

function install(config: FrameConfig) {
  const transport = new Transport(config.token);
  const mirror = new Mirror(config);
  const events = new FrameEvents(transport);
  const rt: Runtime = {
    mirror,
    transport,
    events,
    substitute: macroSubstitute(mirror, (type) =>
      transport.notify('replaceVariables', mirror.state.variables[type], { type }),
    ),
  };
  transport.onMessage((message) => {
    if (message.type === 'state') mirror.replace(message.state);
    if (message.type === 'viewport') setViewport(message.height);
  });

  const toastr = toastrShim(rt);
  const variables = variablesApi(rt, config);
  const globals = globalsApi(rt, variables, config.globals);
  const functions: Record<string, unknown> = {
    ...variables,
    ...chatApi(rt),
    ...worldbookApi(rt),
    ...miscApi(rt, config, (message, title) =>
      toastr.error(`<pre style="white-space: pre-wrap">${message}</pre>`, title, { escapeHtml: false }),
    ),
    ...globals,
    // events
    eventOn: (event: string, listener: () => unknown) => events.on(event, listener),
    eventOnButton: (name: string, listener: () => unknown) =>
      events.on((functions.getButtonEvent as (n: string) => string)(name), listener),
    eventMakeFirst: (event: string, listener: () => unknown) => events.makeFirst(event, listener),
    eventMakeLast: (event: string, listener: () => unknown) => events.makeLast(event, listener),
    eventOnce: (event: string, listener: () => unknown) => events.once(event, listener),
    eventEmit: (event: string, ...args: unknown[]) => events.emit(event, args),
    eventEmitAndWait: (event: string, ...args: unknown[]) => void events.emit(event, args),
    eventRemoveListener: (event: string, listener: () => unknown) => events.remove(event, listener),
    eventClearEvent: (event: string) => events.clearEvent(event),
    eventClearListener: (listener: () => unknown) => events.clearListener(listener),
    eventClearAll: () => events.clearAll(),
    tavern_events: tavernEvents,
  };

  const target = window as unknown as Record<string, unknown>;
  Object.assign(target, { _, $, jQuery: $, z, YAML, toastr, ...functions });
  target.TavernHelper = { ...functions };
  Object.defineProperty(window, 'SillyTavern', {
    get: () => sillyTavernApi(rt, functions),
    configurable: true,
  });

  // A sandboxed frame has no storage of its own; cards that use it get one that lasts while it is open.
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      void (window as unknown as Record<string, Storage>)[name]!.length;
    } catch {
      Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
    }
  }

  setViewport(config.viewportHeight);
  window.addEventListener('DOMContentLoaded', () => {
    reportHeight(transport);
    transport.send({ type: 'ready' });
  });
  window.addEventListener('pagehide', () => events.clearAll());
}

function setViewport(height: number) {
  document.documentElement.style.setProperty('--TH-viewport-height', `${height}px`);
}

/** Tells the page how tall the content is, so the frame fits it. */
function reportHeight(transport: Transport) {
  let scheduled = false;
  let last = 0;
  const measure = () => {
    scheduled = false;
    const height = document.body?.scrollHeight ?? 0;
    if (!Number.isFinite(height) || height <= 0 || height === last) return;
    last = height;
    transport.send({ type: 'height', height });
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(measure);
  };
  schedule();
  new ResizeObserver(schedule).observe(document.body);
  window.addEventListener('load', schedule);
}

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(String(key)) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(String(key)),
    setItem: (key, value) => void items.set(String(key), String(value)),
  };
}

/**
 * Function tools the model may call (SillyTavern's `ToolManager`): what plugins register, and
 * running the calls a reply makes. Core builds the requests and reads the calls; this module runs
 * them in the browser.
 */

import {
  toolArguments,
  type ModelToolCall,
  type ToolDefinition,
  type ToolInvocation,
} from '@bakatavern/core';

export interface RegisteredTool extends ToolDefinition {
  /** Runs the tool; a string result is passed on as it is, anything else as JSON. */
  action(parameters: Record<string, unknown>): unknown;
  /** The note shown while the tool runs. */
  formatMessage?(parameters: Record<string, unknown>): string | Promise<string>;
  /** Offered to the model only when this says so (checked before every generation). */
  shouldRegister?(): boolean | Promise<boolean>;
  /** Calls are not recorded in the chat, and the generation ends after them. */
  stealth?: boolean;
}

const tools = new Map<string, RegisteredTool>();

export function registerTool(tool: RegisteredTool) {
  if (tools.has(tool.name))
    console.warn(`[tools] "${tool.name}" was registered again; the new definition wins.`);
  tools.set(tool.name, tool);
}

export function unregisterTool(name: string) {
  tools.delete(name);
}

/** The tools to offer with the next request. */
export async function offeredTools(): Promise<ToolDefinition[]> {
  const offered: ToolDefinition[] = [];
  for (const tool of tools.values()) {
    if (tool.shouldRegister && !(await tool.shouldRegister())) continue;
    offered.push({
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      parameters: tool.parameters,
    });
  }
  return offered;
}

const parse = (parameters: unknown): Record<string, unknown> =>
  parameters === ''
    ? {}
    : typeof parameters === 'string'
      ? (JSON.parse(parameters) as Record<string, unknown>)
      : (parameters as Record<string, unknown>);

export interface ToolRunResult {
  invocations: ToolInvocation[];
  errors: Error[];
  stealthCalls: string[];
}

/**
 * Runs the calls of a reply (`invokeFunctionTools`). A failing tool still yields an invocation, so
 * the model sees the error. `onCall` shows what is running.
 */
export async function runToolCalls(
  calls: readonly ModelToolCall[],
  reasoning: string,
  onCall?: (note: string) => void,
): Promise<ToolRunResult> {
  const result: ToolRunResult = { invocations: [], errors: [], stealthCalls: [] };
  for (const call of calls) {
    if (!call?.function || typeof call.function !== 'object') continue;
    const name = call.function.name;
    const tool = tools.get(name);
    const displayName = tool?.displayName || name;
    let note = tool ? `Invoking tool: ${displayName}` : `Invoked unknown tool: ${name}`;
    if (tool?.formatMessage) {
      try {
        note = await tool.formatMessage(parse(call.function.arguments));
      } catch {
        // the default note
      }
    }
    if (note) onCall?.(note);
    let output: string | Error;
    try {
      if (!tool) throw new Error(`No tool with the name "${name}" has been registered.`);
      const value = await tool.action(parse(call.function.arguments));
      output = typeof value === 'string' ? value : JSON.stringify(value);
    } catch (error) {
      output = error instanceof Error ? error : new Error('Unknown error occurred while invoking the tool.');
      output.cause = name;
    }
    if (tool?.stealth) {
      if (output instanceof Error) result.errors.push(output);
      result.stealthCalls.push(name);
      continue;
    }
    const failed = output instanceof Error;
    if (failed) result.errors.push(output as Error);
    result.invocations.push({
      id: call.id,
      displayName,
      name,
      parameters: toolArguments(call.function.arguments),
      result: failed ? String(output) : (output as string),
      error: failed,
      signature: call.signature || null,
      reasoning: reasoning || null,
    });
  }
  return result;
}

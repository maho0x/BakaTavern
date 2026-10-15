/** Incremental Server-Sent Events parser (handles partial chunks, CRLF, multi-line data). */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  #decoder = new TextDecoder();
  #buffer = '';
  #event = '';
  #data: string[] = [];

  /** Feeds bytes or text; returns the events completed by this chunk. */
  push(chunk: Uint8Array | string): SseEvent[] {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    const events: SseEvent[] = [];
    let newline: number;
    while ((newline = this.#buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.#buffer.slice(0, newline);
      const sepLength = this.#buffer.startsWith('\r\n', newline) ? 2 : 1;
      this.#buffer = this.#buffer.slice(newline + sepLength);
      this.#line(line, events);
    }
    return events;
  }

  /** Flushes a final event that was not followed by a blank line. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    this.#buffer += this.#decoder.decode();
    if (this.#buffer) {
      this.#line(this.#buffer, events);
      this.#buffer = '';
    }
    this.#dispatch(events);
    return events;
  }

  #line(line: string, events: SseEvent[]): void {
    if (line === '') {
      this.#dispatch(events);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
  }

  #dispatch(events: SseEvent[]): void {
    if (this.#data.length) events.push({ event: this.#event || 'message', data: this.#data.join('\n') });
    this.#data = [];
    this.#event = '';
  }
}

/** Splits newline-delimited JSON streams (Ollama, KoboldCpp ...). */
export class NdjsonParser {
  #decoder = new TextDecoder();
  #buffer = '';

  push(chunk: Uint8Array | string): unknown[] {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';
    return lines.flatMap((l) => parseJsonLine(l));
  }

  end(): unknown[] {
    const rest = this.#buffer + this.#decoder.decode();
    this.#buffer = '';
    return parseJsonLine(rest);
  }
}

function parseJsonLine(line: string): unknown[] {
  const text = line.trim();
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}

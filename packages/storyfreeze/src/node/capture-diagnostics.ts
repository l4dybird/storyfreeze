import fs from 'node:fs';

export const CAPTURE_DIAGNOSTIC_PREFIX = 'STORYFREEZE_CAPTURE_DIAGNOSTIC=';

export type CaptureDiagnosticEvent = {
  type: string;
  backend?: string;
  durationMs?: number;
  phase?: string;
  requestId?: string;
  storyId?: string;
  variantKey?: string[];
  workerId?: number;
  [key: string]: unknown;
};

const captureDiagnosticListeners = new Set<(event: CaptureDiagnosticEvent) => void>();
const maximumQueuedDiagnosticBytes = 1024 * 1024;

class DiagnosticSink {
  private readonly lines: Array<Buffer | undefined> = [];
  private head = 0;
  private queuedBytes = 0;
  private writing = false;

  write(line: string) {
    if (Buffer.byteLength(line) > maximumQueuedDiagnosticBytes) return;
    const encoded = Buffer.from(line);
    if (this.queuedBytes + encoded.byteLength > maximumQueuedDiagnosticBytes) return;
    this.lines.push(encoded);
    this.queuedBytes += encoded.byteLength;
    this.flushNext();
  }

  private flushNext() {
    if (this.writing || this.head >= this.lines.length) return;
    this.writing = true;
    const line = this.lines[this.head];
    this.lines[this.head] = undefined;
    this.head += 1;
    if (!line) {
      this.writing = false;
      queueMicrotask(() => this.flushNext());
      return;
    }
    this.queuedBytes -= line.byteLength;
    let offset = 0;
    const complete = () => {
      this.writing = false;
      if (this.head === this.lines.length) {
        this.lines.length = 0;
        this.head = 0;
      } else if (this.head >= 64 && this.head * 2 >= this.lines.length) {
        this.lines.splice(0, this.head);
        this.head = 0;
      }
      queueMicrotask(() => this.flushNext());
    };
    const writeRemaining = () => {
      const remaining = line.byteLength - offset;
      try {
        fs.write(process.stdout.fd, line, offset, remaining, null, (error, bytesWritten) => {
          if (error) {
            complete();
            return;
          }
          const written = typeof bytesWritten === 'number' ? bytesWritten : remaining;
          if (!Number.isSafeInteger(written) || written <= 0) {
            complete();
            return;
          }
          offset += Math.min(written, remaining);
          if (offset >= line.byteLength) complete();
          else queueMicrotask(writeRemaining);
        });
      } catch {
        complete();
      }
    };
    writeRemaining();
  }
}

let diagnosticSink: DiagnosticSink | undefined;

export function captureDiagnosticsEnabled() {
  return process.env.STORYFREEZE_CAPTURE_DIAGNOSTICS === '1';
}

export function emitCaptureDiagnostic(event: CaptureDiagnosticEvent) {
  if (!captureDiagnosticsEnabled()) return;
  for (const listener of captureDiagnosticListeners) {
    try {
      listener(event);
    } catch {
      // Diagnostics must never change capture behavior.
    }
  }
  try {
    const line = `${CAPTURE_DIAGNOSTIC_PREFIX}${JSON.stringify(event)}\n`;
    if (process.stdout.destroyed || process.stdout.writableEnded) return;
    diagnosticSink ??= new DiagnosticSink();
    diagnosticSink.write(line);
  } catch {
    // Serialization and output are best effort for the same reason as diagnostic listeners.
  }
}

export function subscribeCaptureDiagnostics(listener: (event: CaptureDiagnosticEvent) => void) {
  captureDiagnosticListeners.add(listener);
  return () => captureDiagnosticListeners.delete(listener);
}

export async function measureCaptureDiagnostic<T>(event: CaptureDiagnosticEvent, action: () => Promise<T>): Promise<T> {
  if (!captureDiagnosticsEnabled()) return action();
  emitCaptureDiagnostic({ ...event, state: 'start' });
  const startedAt = performance.now();
  try {
    const result = await action();
    emitCaptureDiagnostic({ ...event, durationMs: performance.now() - startedAt, state: 'end' });
    return result;
  } catch (error) {
    emitCaptureDiagnostic({
      ...event,
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? { message: error.message, name: error.name } : String(error),
      state: 'end',
    });
    throw error;
  }
}

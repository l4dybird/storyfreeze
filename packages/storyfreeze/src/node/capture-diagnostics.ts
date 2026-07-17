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
let pendingDiagnosticWrites = 0;

function ignoreDiagnosticWriteError() {
  // A closed diagnostics consumer (for example EPIPE) must not fail capture work.
}

function beginDiagnosticWrite() {
  if (pendingDiagnosticWrites === 0) process.stdout.on('error', ignoreDiagnosticWriteError);
  pendingDiagnosticWrites += 1;
}

function finishDiagnosticWrite(error?: Error | null) {
  const release = () => {
    pendingDiagnosticWrites = Math.max(0, pendingDiagnosticWrites - 1);
    if (pendingDiagnosticWrites === 0) process.stdout.off('error', ignoreDiagnosticWriteError);
  };
  // Node invokes a failed write callback before emitting the stream's error.
  // Keep the scoped listener through that emission, then remove it immediately.
  if (error) setImmediate(release);
  else release();
}

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
    beginDiagnosticWrite();
    let finished = false;
    const finish = (error?: Error | null) => {
      if (finished) return;
      finished = true;
      finishDiagnosticWrite(error);
    };
    try {
      process.stdout.write(line, finish);
    } catch {
      finish();
    }
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

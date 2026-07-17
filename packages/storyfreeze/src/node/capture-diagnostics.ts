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
  process.stdout.write(`${CAPTURE_DIAGNOSTIC_PREFIX}${JSON.stringify(event)}\n`);
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

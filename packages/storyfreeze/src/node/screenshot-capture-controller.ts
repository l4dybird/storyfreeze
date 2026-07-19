import type { ScreenshotCaptureController } from './browser-backend.js';
import {
  estimateScreenshotBufferReservation,
  type FileSystem,
  type ScreenshotBudgetDiagnosticContext,
} from './file.js';

export function createScreenshotCaptureController(
  fileSystem: FileSystem,
  signal?: AbortSignal,
  diagnosticContext?: ScreenshotBudgetDiagnosticContext,
): ScreenshotCaptureController {
  return {
    capture(dimensions, capture) {
      if (typeof fileSystem.captureScreenshot !== 'function') return capture();
      return fileSystem.captureScreenshot(
        estimateScreenshotBufferReservation(dimensions),
        capture,
        signal,
        diagnosticContext,
      );
    },
  };
}

export function releaseCapturedScreenshot(fileSystem: FileSystem, buffer: Buffer | null | undefined) {
  fileSystem.releaseScreenshotBuffer?.(buffer);
}

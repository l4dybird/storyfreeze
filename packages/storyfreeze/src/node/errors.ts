export class InvalidCurrentStoryStateError extends Error {
  name = 'InvalidCurrentStoryStateError';

  constructor() {
    super();
    this.message = 'Fail to screenshot. The current story is not set.';
  }
}

export class CaptureAttemptTimeoutError extends Error {
  name = 'CaptureAttemptTimeoutError';

  constructor(timeout: number, requestId: string) {
    super(`Capture ${requestId} did not finish within ${timeout} msec.`);
  }
}

export class PreviewProtocolVersionError extends Error {
  name = 'PreviewProtocolVersionError';

  constructor(expected: number, actual: unknown) {
    super(`StoryFreeze preview protocol mismatch. Expected ${expected}, received ${JSON.stringify(actual)}.`);
  }
}

export class PreviewStateValidationError extends Error {
  name = 'PreviewStateValidationError';

  constructor(detail: string) {
    super(`Invalid StoryFreeze preview state: ${detail}.`);
  }
}

export class PreviewAddonVersionMismatchError extends Error {
  name = 'PreviewAddonVersionMismatchError';

  constructor(expected: string, actual: unknown) {
    super(`StoryFreeze addon version mismatch. CLI ${expected}, preview ${JSON.stringify(actual)}.`);
  }
}

export class PreviewStateMismatchError extends Error {
  name = 'PreviewStateMismatchError';

  constructor(expected: { storyId: string; requestId: string }, actual: { storyId: unknown; requestId: unknown }) {
    super(
      `StoryFreeze preview state is stale. Expected story ${JSON.stringify(expected.storyId)} request ${JSON.stringify(
        expected.requestId,
      )}, received story ${JSON.stringify(actual.storyId)} request ${JSON.stringify(actual.requestId)}.`,
    );
  }
}

export class PreviewRenderError extends Error {
  name = 'PreviewRenderError';

  constructor(storyId: string, error: { name: string; message: string; stack?: string }) {
    super(`StoryFreeze preview failed for ${JSON.stringify(storyId)}: ${error.name}: ${error.message}`);
    if (error.stack) this.stack = error.stack;
  }
}

export class PreviewReadyTimeoutError extends Error {
  name = 'PreviewReadyTimeoutError';

  constructor(timeout: number, url: string, expected: { storyId: string; requestId: string }, lastState: unknown) {
    super(
      `StoryFreeze preview did not become ready in ${timeout} msec. URL: ${url}; storyId: ${expected.storyId}; requestId: ${
        expected.requestId
      }; lastState: ${JSON.stringify(lastState)}.`,
    );
  }
}

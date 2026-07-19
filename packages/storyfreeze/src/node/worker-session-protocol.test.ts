import { describe, expect, it, vi } from 'vite-plus/test';

import { WorkerSessionProtocolClient } from './worker-session-protocol.js';

describe(WorkerSessionProtocolClient, () => {
  it('validates selection identity and completes the active request', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ requestId: '0-2', storyId: 'button--secondary', generation: 2 })
      .mockResolvedValueOnce(undefined);
    const client = new WorkerSessionProtocolClient({ evaluate } as never);

    await expect(client.selectStory({ requestId: '0-2', storyId: 'button--secondary' })).resolves.toEqual({
      requestId: '0-2',
      storyId: 'button--secondary',
      generation: 2,
    });
    expect(client.current).toMatchObject({ requestId: '0-2' });
    await client.completeCapture();
    expect(client.current).toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('rejects mismatched and invalid responses without retaining a request', async () => {
    const evaluate = vi.fn().mockResolvedValue({ requestId: 'stale', storyId: 'button--secondary', generation: 0 });
    const client = new WorkerSessionProtocolClient({ evaluate } as never);

    await expect(client.selectStory({ requestId: '0-2', storyId: 'button--secondary' })).rejects.toThrow(
      'selection mismatch',
    );
    expect(client.current).toBeUndefined();
  });

  it('does not allow overlapping requests', async () => {
    const evaluate = vi.fn().mockResolvedValue({ requestId: '0-2', storyId: 'button--secondary', generation: 1 });
    const client = new WorkerSessionProtocolClient({ evaluate } as never);
    await client.selectStory({ requestId: '0-2', storyId: 'button--secondary' });

    await expect(client.selectStory({ requestId: '0-3', storyId: 'button--tertiary' })).rejects.toThrow('still active');
  });
});

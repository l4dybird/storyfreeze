import { describe, expect, it } from 'vite-plus/test';
import { CaptureLeaseQueue } from './capture-lease-queue.js';

const desktop = {
  width: 800,
  height: 600,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  isLandscape: true,
};
const mobile = { ...desktop, width: 390, height: 844, isMobile: true, hasTouch: true, isLandscape: false };

function capture(captureId: string, storyId: string, profile = desktop) {
  return { captureId, storyId, profile, estimatedCostMs: 500 };
}

describe(CaptureLeaseQueue, () => {
  it('leases each capture once, rejects duplicate discovery, and supports retry transitions', () => {
    const first = capture('first', 'a');
    const second = capture('second', 'b', mobile);
    const queue = new CaptureLeaseQueue([[first], [second]]);

    expect(queue.enqueue({ ...first })).toBe(false);
    const lease = queue.lease(0)!;
    expect(lease.capture).toBe(first);
    queue.markRunning(first.captureId);
    queue.requeue(first.captureId, first, 0);
    expect(queue.stateOf(first.captureId)).toBe('requeued');

    const retry = queue.lease(0)!;
    queue.markRunning(retry.capture.captureId);
    queue.complete(retry.capture.captureId);
    expect(queue.stateOf(first.captureId)).toBe('completed');
  });

  it('steals from another worker only after its own queue is empty', () => {
    const first = capture('first', 'a');
    const second = capture('second', 'b');
    const queue = new CaptureLeaseQueue([[first, second], []]);

    const stolen = queue.lease(1, desktop, 'a')!;
    expect(stolen.stolen).toBe(true);
    expect(stolen.capture.captureId).toBe('first');
    queue.markRunning(stolen.capture.captureId);
    queue.complete(stolen.capture.captureId);
    expect(queue.snapshot).toMatchObject({ affinityHitCount: 1, stealCount: 1 });
  });

  it('wakes an idle worker when an active capture discovers more work', async () => {
    const first = capture('first', 'a');
    const queue = new CaptureLeaseQueue([[first], []]);
    const lease = queue.lease(0)!;
    queue.markRunning(lease.capture.captureId);

    const waiting = queue.waitForChange();
    expect(queue.enqueue(capture('discovered', 'a'), 1)).toBe(true);
    await expect(waiting).resolves.toBeUndefined();
    expect(queue.lease(1)?.capture.captureId).toBe('discovered');
  });

  it('fails a running lease, wakes drain waiters, and rejects invalid transitions', async () => {
    const first = capture('first', 'a');
    const queue = new CaptureLeaseQueue([[first]]);
    expect(() => queue.markRunning(first.captureId)).toThrow('must be leased');

    const lease = queue.lease(0)!;
    expect(() => queue.complete(lease.capture.captureId)).toThrow('must be running');
    queue.markRunning(lease.capture.captureId);
    const waiting = queue.waitForChange();
    queue.fail(lease.capture.captureId);

    await expect(waiting).resolves.toBeUndefined();
    expect(queue.stateOf(first.captureId)).toBe('failed');
    expect(queue.isDrained()).toBe(true);
    expect(() => queue.fail(first.captureId)).toThrow('must be running');
  });

  it('steals deterministically by capture id when affinity costs tie', () => {
    const queue = new CaptureLeaseQueue([[capture('z-last', 'story'), capture('a-first', 'story')], []]);

    expect(queue.lease(1)?.capture.captureId).toBe('a-first');
  });
});

import { profileSwitchCost, storySwitchCost } from './capture-plan.js';
import type { EmulationProfile } from './emulation-profile.js';
import { compareDeterministicStrings } from './capture-manifest.js';

export type CaptureExecutionState = 'planned' | 'leased' | 'running' | 'completed' | 'failed' | 'requeued';

export interface LeaseableCapture {
  captureId: string;
  storyId: string;
  profile?: EmulationProfile;
  estimatedCostMs?: number;
}

export interface CaptureLease<T> {
  capture: T;
  ownerWorkerId: number;
  stolen: boolean;
}

export interface CaptureLeaseQueueDiagnostics {
  affinityHitCount: number;
  affinityMissCount: number;
  duplicateEnqueueCount: number;
  leaseCount: number;
  stealCount: number;
}

type StateRecord<T> = {
  capture: T;
  ownerWorkerId: number;
  state: CaptureExecutionState;
};

/**
 * Owns every capture state transition and guarantees that a capture has at most one active lease.
 * JavaScript's run-to-completion semantics make transitions atomic between worker awaits.
 */
export class CaptureLeaseQueue<T extends LeaseableCapture> {
  private readonly queues: T[][];
  private readonly states = new Map<string, StateRecord<T>>();
  private readonly waiters: Array<() => void> = [];
  private activeLeaseCount = 0;
  private readonly diagnostics: CaptureLeaseQueueDiagnostics = {
    affinityHitCount: 0,
    affinityMissCount: 0,
    duplicateEnqueueCount: 0,
    leaseCount: 0,
    stealCount: 0,
  };

  constructor(assignments: readonly (readonly T[])[]) {
    if (assignments.length === 0) throw new Error('CaptureLeaseQueue requires at least one worker queue.');
    this.queues = assignments.map(() => []);
    assignments.forEach((captures, workerId) => {
      for (const capture of captures) {
        if (!this.enqueue(capture, workerId)) throw new Error(`Duplicate planned capture id: ${capture.captureId}.`);
      }
    });
  }

  get workerCount() {
    return this.queues.length;
  }

  get pendingCount() {
    return this.queues.reduce((total, queue) => total + queue.length, 0);
  }

  get activeCount() {
    return this.activeLeaseCount;
  }

  get snapshot(): CaptureLeaseQueueDiagnostics {
    return { ...this.diagnostics };
  }

  stateOf(captureId: string): CaptureExecutionState | undefined {
    return this.states.get(captureId)?.state;
  }

  enqueue(capture: T, preferredWorkerId?: number): boolean {
    if (this.states.has(capture.captureId)) {
      this.diagnostics.duplicateEnqueueCount += 1;
      return false;
    }
    const ownerWorkerId = this.selectOwner(preferredWorkerId);
    this.states.set(capture.captureId, { capture, ownerWorkerId, state: 'planned' });
    this.queues[ownerWorkerId].push(capture);
    this.wakeAll();
    return true;
  }

  lease(workerId: number, lastProfile?: EmulationProfile, lastStoryId?: string): CaptureLease<T> | undefined {
    this.assertWorkerId(workerId);
    let ownerWorkerId = workerId;
    let capture = this.queues[workerId].shift();
    if (!capture) {
      const candidates = this.queues
        .map((queue, candidateWorkerId) => ({
          candidateWorkerId,
          capture: this.peekBest(queue, lastProfile, lastStoryId),
        }))
        .filter(candidate => candidate.capture !== undefined)
        .sort((left, right) => {
          const leftCost = this.affinityCost(left.capture!, lastProfile, lastStoryId);
          const rightCost = this.affinityCost(right.capture!, lastProfile, lastStoryId);
          return leftCost - rightCost || left.candidateWorkerId - right.candidateWorkerId;
        });
      const selected = candidates[0];
      if (!selected) return undefined;
      ownerWorkerId = selected.candidateWorkerId;
      capture = this.takeById(this.queues[ownerWorkerId], selected.capture!.captureId);
    }
    if (!capture) return undefined;

    const record = this.states.get(capture.captureId);
    if (!record || (record.state !== 'planned' && record.state !== 'requeued')) {
      throw new Error(`Capture ${capture.captureId} cannot be leased from state ${String(record?.state)}.`);
    }
    record.state = 'leased';
    this.activeLeaseCount += 1;
    this.diagnostics.leaseCount += 1;
    const stolen = ownerWorkerId !== workerId;
    if (stolen) this.diagnostics.stealCount += 1;
    if (lastProfile && capture.profile) {
      if (profileSwitchCost(lastProfile, capture.profile) === 0) this.diagnostics.affinityHitCount += 1;
      else this.diagnostics.affinityMissCount += 1;
    }
    return { capture, ownerWorkerId, stolen };
  }

  markRunning(captureId: string): void {
    const record = this.requireState(captureId, 'leased');
    record.state = 'running';
  }

  complete(captureId: string): void {
    const record = this.requireState(captureId, 'running');
    record.state = 'completed';
    this.releaseLease();
  }

  fail(captureId: string): void {
    const record = this.requireState(captureId, 'running');
    record.state = 'failed';
    this.releaseLease();
  }

  requeue(captureId: string, capture: T, preferredWorkerId?: number): void {
    const record = this.requireState(captureId, 'running');
    const ownerWorkerId = this.selectOwner(preferredWorkerId ?? record.ownerWorkerId);
    record.capture = capture;
    record.ownerWorkerId = ownerWorkerId;
    record.state = 'requeued';
    this.queues[ownerWorkerId].push(capture);
    this.releaseLease();
  }

  isDrained(): boolean {
    return this.activeLeaseCount === 0 && this.pendingCount === 0;
  }

  waitForChange(): Promise<void> {
    if (this.isDrained() || this.pendingCount > 0) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }

  wakeAll(): void {
    this.waiters.splice(0).forEach(resolve => resolve());
  }

  private assertWorkerId(workerId: number) {
    if (!Number.isSafeInteger(workerId) || workerId < 0 || workerId >= this.queues.length) {
      throw new Error(`Invalid capture worker id: ${workerId}.`);
    }
  }

  private selectOwner(preferredWorkerId?: number): number {
    if (preferredWorkerId !== undefined) {
      this.assertWorkerId(preferredWorkerId);
      return preferredWorkerId;
    }
    return this.queues
      .map((queue, workerId) => ({
        workerId,
        cost: queue.reduce((total, item) => total + (item.estimatedCostMs ?? 0), 0),
      }))
      .sort((left, right) => left.cost - right.cost || left.workerId - right.workerId)[0].workerId;
  }

  private affinityCost(capture: T, lastProfile?: EmulationProfile, lastStoryId?: string): number {
    return (
      (capture.profile ? profileSwitchCost(lastProfile, capture.profile) : 0) +
      storySwitchCost(lastStoryId, capture.storyId)
    );
  }

  private peekBest(queue: T[], lastProfile?: EmulationProfile, lastStoryId?: string): T | undefined {
    return [...queue].sort(
      (left, right) =>
        this.affinityCost(left, lastProfile, lastStoryId) - this.affinityCost(right, lastProfile, lastStoryId) ||
        compareDeterministicStrings(left.captureId, right.captureId),
    )[0];
  }

  private takeById(queue: T[], captureId: string): T | undefined {
    const index = queue.findIndex(capture => capture.captureId === captureId);
    if (index < 0) return undefined;
    return queue.splice(index, 1)[0];
  }

  private requireState(captureId: string, expected: CaptureExecutionState): StateRecord<T> {
    const record = this.states.get(captureId);
    if (!record || record.state !== expected) {
      throw new Error(`Capture ${captureId} must be ${expected}, received ${String(record?.state)}.`);
    }
    return record;
  }

  private releaseLease() {
    this.activeLeaseCount -= 1;
    if (this.activeLeaseCount < 0) throw new Error('Capture lease count became negative.');
    this.wakeAll();
  }
}

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

type QueueLane<T> = {
  items: T[];
  head: number;
  queuedCostMs: number;
};

/**
 * Owns every capture state transition and guarantees that a capture has at most one active lease.
 * JavaScript's run-to-completion semantics make transitions atomic between worker awaits.
 */
export class CaptureLeaseQueue<T extends LeaseableCapture> {
  private readonly lanes: QueueLane<T>[];
  private readonly states = new Map<string, StateRecord<T>>();
  private readonly waiters: Array<() => void> = [];
  private activeLeaseCount = 0;
  private pendingCaptureCount = 0;
  private readonly diagnostics: CaptureLeaseQueueDiagnostics = {
    affinityHitCount: 0,
    affinityMissCount: 0,
    duplicateEnqueueCount: 0,
    leaseCount: 0,
    stealCount: 0,
  };

  constructor(assignments: readonly (readonly T[])[]) {
    if (assignments.length === 0) throw new Error('CaptureLeaseQueue requires at least one worker queue.');
    this.lanes = assignments.map(() => ({ items: [], head: 0, queuedCostMs: 0 }));
    assignments.forEach((captures, workerId) => {
      for (const capture of captures) {
        if (!this.enqueue(capture, workerId)) throw new Error(`Duplicate planned capture id: ${capture.captureId}.`);
      }
    });
  }

  get workerCount() {
    return this.lanes.length;
  }

  get pendingCount() {
    return this.pendingCaptureCount;
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
    this.push(ownerWorkerId, capture);
    this.wakeOne();
    return true;
  }

  lease(workerId: number, lastProfile?: EmulationProfile, lastStoryId?: string): CaptureLease<T> | undefined {
    this.assertWorkerId(workerId);
    let ownerWorkerId = workerId;
    let capture = this.takeFront(this.lanes[workerId]);
    if (!capture) {
      let selected: { candidateWorkerId: number; capture: T; index: number; affinityCost: number } | undefined;
      for (let candidateWorkerId = 0; candidateWorkerId < this.lanes.length; candidateWorkerId += 1) {
        const candidate = this.peekBest(this.lanes[candidateWorkerId], lastProfile, lastStoryId);
        if (
          candidate &&
          (!selected ||
            candidate.affinityCost < selected.affinityCost ||
            (candidate.affinityCost === selected.affinityCost && candidateWorkerId < selected.candidateWorkerId))
        ) {
          selected = { candidateWorkerId, ...candidate };
        }
      }
      if (!selected) return undefined;
      ownerWorkerId = selected.candidateWorkerId;
      capture = this.takeAt(this.lanes[ownerWorkerId], selected.index);
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
    this.push(ownerWorkerId, capture);
    this.wakeOne();
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
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private assertWorkerId(workerId: number) {
    if (!Number.isSafeInteger(workerId) || workerId < 0 || workerId >= this.lanes.length) {
      throw new Error(`Invalid capture worker id: ${workerId}.`);
    }
  }

  private selectOwner(preferredWorkerId?: number): number {
    if (preferredWorkerId !== undefined) {
      this.assertWorkerId(preferredWorkerId);
      return preferredWorkerId;
    }
    let selectedWorkerId = 0;
    let selectedCost = this.lanes[0].queuedCostMs;
    for (let workerId = 1; workerId < this.lanes.length; workerId += 1) {
      const cost = this.lanes[workerId].queuedCostMs;
      if (cost < selectedCost) {
        selectedWorkerId = workerId;
        selectedCost = cost;
      }
    }
    return selectedWorkerId;
  }

  private affinityCost(capture: T, lastProfile?: EmulationProfile, lastStoryId?: string): number {
    return (
      (capture.profile ? profileSwitchCost(lastProfile, capture.profile) : 0) +
      storySwitchCost(lastStoryId, capture.storyId)
    );
  }

  private push(workerId: number, capture: T) {
    const lane = this.lanes[workerId];
    lane.items.push(capture);
    lane.queuedCostMs += capture.estimatedCostMs ?? 0;
    this.pendingCaptureCount += 1;
  }

  private takeFront(lane: QueueLane<T>): T | undefined {
    if (lane.head >= lane.items.length) return undefined;
    const capture = lane.items[lane.head++];
    this.removed(lane, capture);
    if (lane.head >= 64 && lane.head * 2 >= lane.items.length) {
      lane.items = lane.items.slice(lane.head);
      lane.head = 0;
    }
    return capture;
  }

  private peekBest(lane: QueueLane<T>, lastProfile?: EmulationProfile, lastStoryId?: string) {
    let selected: { capture: T; index: number; affinityCost: number } | undefined;
    for (let index = lane.head; index < lane.items.length; index += 1) {
      const capture = lane.items[index];
      const affinityCost = this.affinityCost(capture, lastProfile, lastStoryId);
      if (
        !selected ||
        affinityCost < selected.affinityCost ||
        (affinityCost === selected.affinityCost &&
          compareDeterministicStrings(capture.captureId, selected.capture.captureId) < 0)
      ) {
        selected = { capture, index, affinityCost };
      }
    }
    return selected;
  }

  private takeAt(lane: QueueLane<T>, index: number): T | undefined {
    if (index === lane.head) return this.takeFront(lane);
    if (index < lane.head || index >= lane.items.length) return undefined;
    const [capture] = lane.items.splice(index, 1);
    if (capture) this.removed(lane, capture);
    return capture;
  }

  private removed(lane: QueueLane<T>, capture: T) {
    lane.queuedCostMs -= capture.estimatedCostMs ?? 0;
    this.pendingCaptureCount -= 1;
    if (this.pendingCaptureCount < 0) throw new Error('Capture pending count became negative.');
  }

  private wakeOne() {
    this.waiters.shift()?.();
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
    if (this.isDrained()) this.wakeAll();
  }
}

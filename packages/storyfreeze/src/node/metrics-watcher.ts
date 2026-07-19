import { raceAgainstTimeout, sleep } from './async-utils.js';
import type { BrowserMetrics, CapturePage } from './browser-backend.js';

export class MetricsWatcher {
  private readonly length = 3;
  private previous: BrowserMetrics[] = [];
  private _sampleCount = 0;
  private _incompleteSampleCount = 0;

  constructor(
    private readonly page: Pick<CapturePage, 'readMetrics'>,
    private readonly count = 1000,
  ) {}

  async waitForStable(options: { quietMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}) {
    const quietMs = options.quietMs ?? 0;
    const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let stableSince: number | undefined;
    let previousSignature: string | undefined;

    const result = (reason: 'stable' | 'sample-limit' | 'wall-timeout') => ({
      elapsedMs: Date.now() - startedAt,
      incompleteSampleCount: this._incompleteSampleCount,
      reason,
      sampleCount: this._sampleCount,
      samples: this.samples,
      stable: reason === 'stable',
    });

    while (this._sampleCount < this.count) {
      const read = await raceAgainstTimeout(this.page.readMetrics(), deadline - Date.now(), options.signal);
      if (read.timedOut) return result('wall-timeout');

      const now = Date.now();
      const current = read.value;
      this._sampleCount += 1;
      this.next(current);
      const signature = this.signature(current);
      if (!signature) {
        this._incompleteSampleCount += 1;
        stableSince = undefined;
        previousSignature = undefined;
      } else if (signature !== previousSignature) {
        stableSince = now;
        previousSignature = signature;
      }

      if (
        signature &&
        this.previous.length === this.length &&
        this.previous.every(sample => this.signature(sample) === signature) &&
        stableSince !== undefined &&
        now - stableSince >= quietMs
      ) {
        return result('stable');
      }
      if (this._sampleCount >= this.count) break;

      const pause = await raceAgainstTimeout(sleep(16), deadline - Date.now(), options.signal);
      if (pause.timedOut) return result('wall-timeout');
    }
    return result('sample-limit');
  }

  get sampleCount() {
    return this._sampleCount;
  }

  get samples() {
    return [...this.previous];
  }

  private signature(metrics: BrowserMetrics) {
    const values = [metrics.nodes, metrics.recalcStyleCount, metrics.layoutCount];
    return values.every(value => typeof value === 'number' && Number.isFinite(value)) ? values.join(':') : undefined;
  }

  private next(metrics: BrowserMetrics) {
    this.previous.push(metrics);
    this.previous = this.previous.slice(-this.length);
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function numericValues(events, field) {
  return events.map(event => event[field]).filter(value => typeof value === 'number' && Number.isFinite(value));
}

function maximum(values) {
  return values.length ? Math.max(...values) : null;
}

function summarizeScreenshotBudget(events) {
  const budgetEvents = events.filter(event => event.type === 'screenshot-budget');
  const acquired = budgetEvents.filter(event => event.state === 'acquired');
  const captured = budgetEvents.filter(event => event.state === 'captured');
  const failed = budgetEvents.filter(event => event.state === 'failed');
  const actualBytes = numericValues(captured, 'actualBytes');
  const reservationBytes = numericValues(acquired, 'reservationBytes');
  const waitTimes = numericValues(acquired, 'durationMs');

  return {
    actualBytesMax: maximum(actualBytes),
    actualBytesP50: percentile(actualBytes, 0.5),
    actualBytesP95: percentile(actualBytes, 0.95),
    capturedSamples: captured.length,
    failedSamples: failed.length,
    maximumBufferedBytes: maximum(numericValues(budgetEvents, 'maximumBufferedBytes')),
    peakActiveReservations: maximum(numericValues(budgetEvents, 'peakActiveReservations')),
    peakRetainedBytes: maximum(numericValues(budgetEvents, 'peakRetainedBytes')),
    reservationBytesP50: percentile(reservationBytes, 0.5),
    reservationBytesP95: percentile(reservationBytes, 0.95),
    waitMaxMs: maximum(waitTimes),
    waitP50Ms: percentile(waitTimes, 0.5),
    waitP95Ms: percentile(waitTimes, 0.95),
    waitSamples: waitTimes.length,
  };
}

module.exports = { summarizeScreenshotBudget };

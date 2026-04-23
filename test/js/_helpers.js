/**
 * Shared test helpers for JS handler tests.
 * Converts spec sample format { t_ms, I_mA } → { t, I } for the engine.
 */

export function toSample(s) {
  return { t: s.t_ms / 1000, I: s.I_mA };
}

export function runSamples(handler, samples, runtimeCtx) {
  let prev = null;
  const snapshots = {};
  for (const s of samples) {
    const sample = toSample(s);
    handler.update(sample, prev, runtimeCtx);
    snapshots[s.t_ms] = { ...runtimeCtx };
    prev = sample;
  }
  return { snapshots, lastSample: prev };
}

export function finalizeHandler(handler, lastSample, runtimeCtx) {
  return handler.finalize(lastSample, runtimeCtx);
}

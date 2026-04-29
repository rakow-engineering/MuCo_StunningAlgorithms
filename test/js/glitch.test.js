import { describe, it, expect } from 'vitest';
import { GlitchHandler } from '../../StunningEvaluationEngine.js';
import { runSamples } from './_helpers.js';
import spec from '../specs/glitch.json' with { type: 'json' };

/**
 * Build a minimal monitor handler mock.
 * GlitchHandler queries isViolating(I) to detect violation-level samples and
 * getThreshold() to know what value to raise effectiveI to when forgiving.
 * In the real engine these come from createSustainHandler / createDurationHandler.
 */
function makeMonitor(warnBelow) {
  return {
    isViolating: (I) => I < warnBelow,
    getThreshold: () => warnBelow,
  };
}

describe(spec.suite, () => {
  for (const tc of spec.cases) {
    it(tc.id, () => {
      const A    = spec.runtime_defaults.nominal_mA;
      const B    = spec.runtime_defaults.setpoint_mA;
      const step = { ...spec.step, ...(tc.step_override ?? {}) };

      const handler = GlitchHandler(step, A, B);

      // Wire a monitor that treats anything below setpoint_mA as violating.
      // This mirrors the sustain_thresholds step (warnBelow = setpoint_mA).
      handler.setMonitorHandlers([makeMonitor(B)]);

      // Batch mode: call preprocess with the full sample array so the handler
      // can do all-or-nothing forgiving (not the greedy streaming approach).
      const samples = tc.samples.map(s => ({ t: s.t_ms / 1000, I: s.I_mA }));
      handler.preprocess(samples);

      const ctx = {};
      const { snapshots } = runSamples(handler, tc.samples, ctx);

      for (const exp of (tc.expect.per_sample ?? [])) {
        expect(
          snapshots[exp.t_ms].effectiveI,
          `effectiveI at t=${exp.t_ms}ms`
        ).toBeCloseTo(exp.effectiveI, 1);
      }
    });
  }
});

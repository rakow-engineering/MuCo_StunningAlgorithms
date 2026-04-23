import { describe, it, expect } from 'vitest';
import { GlitchHandler } from '../../StunningEvaluationEngine.js';
import { runSamples } from './_helpers.js';
import spec from '../specs/glitch.json' with { type: 'json' };

describe(spec.suite, () => {
  for (const tc of spec.cases) {
    it(tc.id, () => {
      const A = spec.runtime_defaults.nominal_mA;
      const B = spec.runtime_defaults.setpoint_mA;
      const step = { ...spec.step, ...(tc.step_override ?? {}) };
      const handler = GlitchHandler(step, A, B);
      const ctx = {};
      const { snapshots } = runSamples(handler, tc.samples, ctx);

      for (const exp of (tc.expect.per_sample ?? [])) {
        expect(snapshots[exp.t_ms].effectiveI,
          `effectiveI at t=${exp.t_ms}ms`).toBeCloseTo(exp.effectiveI, 1);
      }
    });
  }
});

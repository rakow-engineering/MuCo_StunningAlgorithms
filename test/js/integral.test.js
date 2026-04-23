import { describe, it, expect } from 'vitest';
import { IntegralHandler } from '../../StunningEvaluationEngine.js';
import { runSamples, finalizeHandler } from './_helpers.js';
import spec from '../specs/integral.json' with { type: 'json' };

describe(spec.suite, () => {
  for (const tc of spec.cases) {
    it(tc.id, () => {
      const A = spec.runtime_defaults.nominal_mA;
      const B = spec.runtime_defaults.setpoint_mA;
      const step = { ...spec.step, ...(tc.step_override ?? {}), id: 'charge_ok' };

      const bindings = { required_duration_s: 'time_s', setpoint_mA: 'current_mA' };
      const logEntry = {
        time_s:     tc.runtime?.required_duration_s ?? spec.runtime_defaults.required_duration_s,
        current_mA: B,
        default_current_mA: A,
      };
      const ctx = {
        accumulateStart_s: (tc.accumulate_start_ms ?? 0) / 1000,
        rampDeadline_s:    0,
        completedAt_s:     null,
      };

      const handler = IntegralHandler(step, A, B, bindings, logEntry);
      const { lastSample } = runSamples(handler, tc.samples, ctx);
      const { violations, meta } = finalizeHandler(handler, lastSample, ctx);

      if (tc.expect.completedAt_ms !== undefined) {
        if (tc.expect.completedAt_ms === null) {
          expect(ctx.completedAt_s).toBeNull();
        } else {
          expect(ctx.completedAt_s * 1000).toBeCloseTo(tc.expect.completedAt_ms, 0);
        }
      }

      if (tc.expect.integral_mAs_approx !== undefined) {
        expect(meta.integral_mAs).toBeCloseTo(tc.expect.integral_mAs_approx, -1);
      }

      const expViol = tc.expect.violations ?? [];
      for (const ev of expViol) {
        const found = violations.find(v => v.messageKey === ev.messageKey);
        expect(found, `violation ${ev.messageKey}`).toBeTruthy();
        if (ev.severity) expect(found.severity).toBe(ev.severity);
      }
      if (expViol.length === 0) {
        expect(violations.filter(v => v.severity === 'error').length).toBe(0);
      }
    });
  }
});

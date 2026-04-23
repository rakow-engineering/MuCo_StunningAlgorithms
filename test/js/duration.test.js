import { describe, it, expect } from 'vitest';
import { DurationHandler } from '../../StunningEvaluationEngine.js';
import { runSamples, finalizeHandler } from './_helpers.js';
import spec from '../specs/duration.json' with { type: 'json' };

describe(spec.suite, () => {
  for (const tc of spec.cases) {
    it(tc.id, () => {
      const A = spec.runtime_defaults.nominal_mA;
      const B = spec.runtime_defaults.setpoint_mA;
      const step = { ...spec.step, ...(tc.step_override ?? {}), id: 'duration' };

      const bindings = { required_duration_s: 'time_s' };
      const logEntry = {
        time_s:    tc.runtime?.required_duration_s ?? spec.runtime_defaults.required_duration_s,
        current_mA: B,
        default_current_mA: A,
      };
      const ctx = {
        accumulateStart_s: (tc.accumulate_start_ms ?? 0) / 1000,
        rampDeadline_s:    0,
        completedAt_s:     null,
      };

      const handler = DurationHandler(step, A, B, bindings, logEntry);
      const { lastSample } = runSamples(handler, tc.samples, ctx);
      const { violations } = finalizeHandler(handler, lastSample, ctx);

      // Completion check
      if (tc.expect.completedAt_ms !== undefined) {
        if (tc.expect.completedAt_ms === null) {
          expect(ctx.completedAt_s, 'completedAt_s should be null').toBeNull();
        } else {
          expect(ctx.completedAt_s * 1000, 'completedAt_ms').toBeCloseTo(tc.expect.completedAt_ms, 0);
        }
      }

      // Violation check
      const expViol = tc.expect.violations ?? [];
      for (const ev of expViol) {
        const found = violations.find(v => v.messageKey === ev.messageKey);
        expect(found, `violation ${ev.messageKey}`).toBeTruthy();
        if (ev.severity)  expect(found.severity).toBe(ev.severity);
        if (ev.isSummary) expect(found.isSummary).toBe(true);
      }
      if (expViol.length === 0) {
        const errors = violations.filter(v => v.severity === 'error');
        expect(errors.length, 'no error violations').toBe(0);
      }
    });
  }
});

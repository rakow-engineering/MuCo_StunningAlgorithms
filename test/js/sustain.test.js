import { describe, it, expect } from 'vitest';
import { SustainHandler } from '../../StunningEvaluationEngine.js';
import { runSamples, finalizeHandler } from './_helpers.js';
import spec from '../specs/sustain.json' with { type: 'json' };

describe(spec.suite, () => {
  for (const tc of spec.cases) {
    it(tc.id, () => {
      const A = spec.runtime_defaults.nominal_mA;
      const B = spec.runtime_defaults.setpoint_mA;
      const step = { ...spec.step, ...(tc.step_override ?? {}), id: 'sustain' };

      const ctx = {
        rampDeadline_s:    (tc.ramp_deadline_ms ?? 0) / 1000,
        rampReachedAt_s:   (tc.ramp_reached_ms  ?? 0) / 1000 || null,
        hasRampStep:       (tc.ramp_deadline_ms  ?? 0) > 0,
        effectiveI:        null,
        completedAt_s:     null,
      };

      const handler = SustainHandler(step, A, B);
      const { lastSample } = runSamples(handler, tc.samples, ctx);
      const { violations, meta } = finalizeHandler(handler, lastSample, ctx);

      // Violation check
      const expViol = tc.expect.violations ?? [];
      expect(violations.length, 'violation count').toBe(expViol.length);
      for (const ev of expViol) {
        const found = violations.find(v => v.messageKey === ev.messageKey);
        expect(found, `violation ${ev.messageKey}`).toBeTruthy();
        if (ev.severity) expect(found.severity).toBe(ev.severity);
      }

      // Zone time checks
      const exp = tc.expect.ctx_after_last ?? {};
      if ('ok_ms_min'      in exp) expect(meta.ok_s      * 1000).toBeGreaterThanOrEqual(exp.ok_ms_min);
      if ('warn_ms'        in exp) expect(meta.warn_s    * 1000).toBeCloseTo(exp.warn_ms,    -1);
      if ('warn_ms_min'    in exp) expect(meta.warn_s    * 1000).toBeGreaterThanOrEqual(exp.warn_ms_min);
      if ('invalid_ms'     in exp) expect(meta.invalid_s * 1000).toBeCloseTo(exp.invalid_ms, -1);
      if ('invalid_ms_min' in exp) expect(meta.invalid_s * 1000).toBeGreaterThanOrEqual(exp.invalid_ms_min);
    });
  }
});

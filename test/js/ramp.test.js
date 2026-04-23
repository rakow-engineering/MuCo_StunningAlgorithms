import { describe, it, expect } from 'vitest';
import { RampHandler } from '../../StunningEvaluationEngine.js';
import { runSamples, finalizeHandler } from './_helpers.js';
import spec from '../specs/ramp.json' with { type: 'json' };

describe(spec.suite, () => {
  for (const tc of spec.cases) {
    it(tc.id, () => {
      const A = spec.runtime_defaults.nominal_mA;
      const B = spec.runtime_defaults.setpoint_mA;
      const step = { ...spec.step, ...(tc.step_override ?? {}), id: 'ramp' };

      // Pre-seed ctx as the coordinator does for ramp-present algorithms
      const ctx = { hasRampStep: true, accumulateStart_s: null };
      const handler = RampHandler(step, A, B);
      const { lastSample } = runSamples(handler, tc.samples, ctx);
      const { violations } = finalizeHandler(handler, lastSample, ctx);

      // Violation check
      const expViol = tc.expect.violations ?? [];
      expect(violations.length, 'violation count').toBe(expViol.length);
      for (const ev of expViol) {
        const found = violations.find(v => v.messageKey === ev.messageKey);
        expect(found, `violation ${ev.messageKey}`).toBeTruthy();
        if (ev.severity) expect(found.severity).toBe(ev.severity);
      }

      // ctx fields (converted to _s in JS)
      const expCtx = tc.expect.ctx_after_last ?? {};
      if ('rampDeadline_ms' in expCtx)
        expect(ctx.rampDeadline_s * 1000).toBeCloseTo(expCtx.rampDeadline_ms, 0);
      if ('rampReachedAt_ms' in expCtx) {
        if (expCtx.rampReachedAt_ms === 0) {
          expect(ctx.rampReachedAt_s ?? null).toBeNull();
        } else {
          expect(ctx.rampReachedAt_s * 1000).toBeCloseTo(expCtx.rampReachedAt_ms, 0);
        }
      }
      if ('accumulateStart_ms' in expCtx)
        expect(ctx.accumulateStart_s * 1000).toBeCloseTo(expCtx.accumulateStart_ms, 0);
    });
  }
});

import { describe, it, expect } from 'vitest';
import { InvalidTimeoutHandler, TotalTimeoutHandler } from '../../StunningEvaluationEngine.js';
import { toSample, finalizeHandler } from './_helpers.js';
import spec from '../specs/timeouts.json' with { type: 'json' };

describe(spec.suite, () => {
  for (const tc of spec.cases) {
    it(tc.id, () => {
      const expViol = tc.expect.violations ?? [];

      if (tc.handler === 'InvalidTimeoutHandler') {
        const step = { ...tc.step, id: tc.step.op };
        const handler = InvalidTimeoutHandler(step);
        const ctx = { invalid_s: (tc.invalid_ms_injected ?? 0) / 1000 };
        const { violations } = finalizeHandler(handler, null, ctx);
        expect(violations.length).toBe(expViol.length);
        for (const ev of expViol) {
          const found = violations.find(v => v.messageKey === ev.messageKey);
          expect(found, `violation ${ev.messageKey}`).toBeTruthy();
        }
      }

      if (tc.handler === 'TotalTimeoutHandler') {
        const bindings = { required_duration_s: 'time_s' };
        const logEntry = {
          time_s:     spec.runtime_defaults.required_duration_s,
          current_mA: spec.runtime_defaults.setpoint_mA,
        };
        const step = { ...tc.step, id: tc.step.op };
        const handler = TotalTimeoutHandler(step, bindings, logEntry);
        const ctx = {};
        let lastSample = null;
        for (const s of (tc.samples ?? [])) {
          const sample = toSample(s);
          handler.update(sample, lastSample, ctx);
          lastSample = sample;
        }
        const { violations } = finalizeHandler(handler, lastSample, ctx);
        expect(violations.length).toBe(expViol.length);
        for (const ev of expViol) {
          const found = violations.find(v => v.messageKey === ev.messageKey);
          expect(found, `violation ${ev.messageKey}`).toBeTruthy();
        }
      }
    });
  }
});

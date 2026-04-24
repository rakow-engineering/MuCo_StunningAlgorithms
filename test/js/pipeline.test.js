import { describe, it, expect } from 'vitest';
import { evaluate } from '../../StunningEvaluationEngine.js';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSpec(relPath) {
  return JSON.parse(readFileSync(resolve(__dirname, relPath), 'utf8'));
}

function resolveRuntime(spec, tc) {
  const s = spec.runtime ?? {};
  return {
    nominal_mA:          tc.I_nominal_mA  ?? s.I_nominal_mA  ?? s.nominal_mA,
    setpoint_mA:         tc.I_setpoint_mA ?? s.I_setpoint_mA ?? s.setpoint_mA,
    required_duration_s: tc.t_duration_ms != null ? tc.t_duration_ms / 1000
                       : s.t_duration_ms  != null ? s.t_duration_ms  / 1000
                       : s.required_duration_s,
  };
}

function runPipelineSpec(specFile) {
  const spec = loadSpec(specFile);
  const algo = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'specs', spec.algorithm ?? ''), 'utf8')
  );

  describe(spec.suite, () => {
    for (const tc of spec.cases) {
      it(tc.id, () => {
        const rt = resolveRuntime(spec, tc);
        const logEntry = {
          default_current_mA: rt.nominal_mA,
          current_mA:         rt.setpoint_mA,
          time_s:             rt.required_duration_s,
          measurements: {
            names: ['Time_ms', 'Current_mA'],
            values: tc.samples.map(s => [s.t_ms, s.I_mA]),
          },
        };

        const result = evaluate(logEntry, algo);

        if (tc.expect.ok !== undefined) {
          expect(result.ok, 'ok').toBe(tc.expect.ok);
        }

        if (tc.expect.violations !== undefined) {
          const errors = result.violations.filter(v => v.severity === 'error');
          expect(errors.length, 'error violation count').toBe(tc.expect.violations.length);
        }

        if (tc.expect.violation_message_keys) {
          for (const key of tc.expect.violation_message_keys) {
            const found = result.violations.find(v => v.messageKey === key);
            expect(found, `violation with messageKey=${key}`).toBeTruthy();
          }
        }
      });
    }
  });
}

runPipelineSpec('../specs/pipeline_standard.json');
runPipelineSpec('../specs/pipeline_integral.json');

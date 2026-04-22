/**
 * StunningEvaluationEngine
 *
 * Interprets an algorithm spec (JSON-DSL) and evaluates a log entry's
 * measurement data against the rules defined in that spec.
 *
 * The same spec JSON can also be consumed by a C code generator for the
 * embedded target — this JS implementation is the reference interpreter.
 *
 * Processing model: sample-by-sample, mirroring StunningAlgoHandler.c.
 * Each step is a stateful handler whose update() is called once per sample
 * (in step order), followed by a finalize() pass to collect violations.
 * No step ever buffers the full sample array.
 *
 * Usage:
 *   import { evaluate } from './StunningEvaluationEngine';
 *   const result = evaluate(logEntry, spec);
 *   // result = { ok, violations, meta, overlayHints, thresholds }
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a threshold ref from the JSON-DSL to an mA value.
 * Preferred: "nominal_mA" / "setpoint_mA" (readable, aligned with bindings keys).
 * Legacy aliases: "A" / "B" / "minAB".
 */
function resolveThreshold(name, nominal_mA, setpoint_mA) {
  switch (name) {
    case 'nominal_mA':
    case 'A':
      return nominal_mA;
    case 'setpoint_mA':
    case 'B':
      return setpoint_mA;
    case 'min_nominal_setpoint':
    case 'minAB':
      return Math.min(nominal_mA, setpoint_mA);
    default:
      if (typeof name === 'number') return name;
      throw new Error(`Unknown threshold reference: ${name}`);
  }
}

/**
 * Normalise measurement data from a log entry into a simple
 * array of { t, I } (time in seconds, current in mA).
 *
 * Handles both column-oriented (names/values) and array-of-objects formats.
 */
export function normalizeMeasurements(logEntry) {
  const m = logEntry?.measurements;
  if (!m) return [];

  if (m.names && m.values) {
    const timeIdx = m.names.indexOf('Time_ms');
    const curIdx = m.names.indexOf('Current_mA');
    if (timeIdx === -1 || curIdx === -1) return [];

    const firstTime = m.values[0]?.[timeIdx] ?? 0;
    return m.values.map(row => ({
      t: (row[timeIdx] - firstTime) / 1000,
      I: row[curIdx]
    }));
  }

  if (Array.isArray(m)) {
    return m.map(pt => ({
      t: parseFloat(pt.time_s ?? 0),
      I: parseFloat(pt.current_mA ?? 0)
    }));
  }

  return [];
}

// ---------------------------------------------------------------------------
// Step handlers — sample-by-sample
//
// Each factory returns { update(sample, prevSample, runtimeCtx), finalize(lastSample, runtimeCtx) }.
// runtimeCtx is the shared mutable bus through which steps communicate timing
// and accumulator state. Steps update it inside update() so that downstream
// steps see the result in the same sample iteration.
// ---------------------------------------------------------------------------

/**
 * glitch_ignore — forgive sub-nominal dips shorter than max_gap_ms.
 *
 * Sets runtimeCtx.effectiveI for each sample:
 *   - If a dip is shorter than max_gap_ms: effectiveI = pre-dip hold value.
 *   - Otherwise: effectiveI = actual sample current.
 *
 * sustain_thresholds reads effectiveI for zone classification.
 * completion steps (duration, integral) always use raw sample.I.
 */
function createGlitchIgnoreHandler(step, A, B) {
  const threshold = resolveThreshold(step.ref, A, B);
  const maxGapS   = (step.max_gap_ms ?? 100) / 1000;

  let glitchActive = false;
  let glitchStartT = null;
  let glitchHoldI  = 0;

  return {
    update(sample, prevSample, runtimeCtx) {
      if (sample.I < threshold) {
        if (!glitchActive) {
          glitchActive = true;
          glitchStartT = sample.t;
          glitchHoldI  = prevSample != null ? prevSample.I : threshold;
        }
        const gap = sample.t - glitchStartT;
        runtimeCtx.effectiveI = gap < maxGapS ? glitchHoldI : sample.I;
      } else {
        glitchActive = false;
        glitchStartT = null;
        runtimeCtx.effectiveI = sample.I;
      }
    },
    finalize() { return { violations: [], meta: {} }; }
  };
}

/**
 * ramp_to_threshold — verify current reaches setpoint within timeout_ms.
 *
 * Sets in runtimeCtx once the ramp clock starts:
 *   rampStart_s      — time of first sample above ramp_start_mA
 *   rampDeadline_s   — rampStart_s + timeout_ms/1000
 *   rampReachedAt_s  — first time current >= threshold (early success)
 *   accumulateStart_s— when completion steps should begin accumulating
 *
 * rampDeadline_s is the monitor guard: sustain_thresholds waits for it.
 * accumulateStart_s: = rampReachedAt_s if !count_during_ramp (early start),
 *                    = rampStart_s     if count_during_ramp,
 *                    = rampDeadline_s  if deadline reached without success.
 */
function createRampHandler(step, A, B) {
  const windowS        = step.timeout_ms != null ? step.timeout_ms / 1000 : null;
  const baseThreshold  = resolveThreshold(step.threshold, A, B);
  const pct            = step.current_threshold_percent ?? 100;
  const threshold      = baseThreshold * pct / 100;
  const rampStartMa    = step.ramp_start_mA ?? 10;
  const countDuringRamp = step.count_during_ramp === true;

  let rampStarted      = false;
  let rampComplete     = false;
  let rampStart_s      = null;
  let rampDeadline_s   = null;
  let rampReachedAt_s  = null;
  let maxInWindow      = 0;

  return {
    update(sample, _prev, runtimeCtx) {
      if (windowS == null) return;

      // Detect ramp start: first sample above ramp_start_mA
      if (!rampStarted && sample.I > rampStartMa) {
        rampStarted      = true;
        rampStart_s      = sample.t;
        rampDeadline_s   = rampStart_s + windowS;
        runtimeCtx.rampStart_s    = rampStart_s;
        runtimeCtx.rampDeadline_s = rampDeadline_s;
        runtimeCtx.count_during_ramp = countDuringRamp;
        if (countDuringRamp) {
          runtimeCtx.accumulateStart_s = rampStart_s;
        }
      }

      if (rampStarted && !rampComplete) {
        // Track max current within the ramp window
        if (sample.t <= rampDeadline_s) {
          maxInWindow = Math.max(maxInWindow, sample.I);
        }

        // Early success: threshold reached before deadline
        if (rampReachedAt_s == null && sample.I >= threshold) {
          rampReachedAt_s = sample.t;
          runtimeCtx.rampReachedAt_s = rampReachedAt_s;
          if (!countDuringRamp && runtimeCtx.accumulateStart_s == null) {
            runtimeCtx.accumulateStart_s = rampReachedAt_s;
          }
        }

        // Deadline reached: ramp phase ends
        if (sample.t >= rampDeadline_s) {
          rampComplete = true;
          if (runtimeCtx.accumulateStart_s == null) {
            runtimeCtx.accumulateStart_s = rampDeadline_s;
          }
        }
      }
    },

    finalize(_last, _ctx) {
      if (windowS == null) return { violations: [], meta: {} };

      const violations = [];
      if (rampStarted && maxInWindow < threshold) {
        violations.push({
          ruleId:     step.id,
          severity:   'error',
          tStart_s:   rampStart_s,
          tEnd_s:     rampDeadline_s,
          messageKey: 'ramp_not_reached',
          details: {
            required_mA: Math.round(threshold   * 10) / 10,
            reached_mA:  Math.round(maxInWindow * 10) / 10,
            timeout_ms:  step.timeout_ms
          }
        });
      }

      return {
        violations,
        meta: {
          ...(rampStart_s     != null ? { rampStart_s }     : {}),
          ...(rampDeadline_s  != null ? { rampDeadline_s }  : {}),
          ...(rampReachedAt_s != null ? { rampReachedAt_s } : {}),
        }
      };
    }
  };
}

/**
 * sustain_thresholds — continuous zone classification using effectiveI.
 *
 * Does not start until after the ramp deadline (or immediately when no
 * ramp step is configured). Uses runtimeCtx.effectiveI (set by glitch_ignore)
 * so short dips are forgiven for zone and violation purposes.
 *
 * Updates runtimeCtx.ok_s / warn_s / invalid_s each sample for
 * invalid_timeout to read.
 */
function createSustainHandler(step, A, B) {
  const warnPct  = step.warn_below_threshold_percent;
  const failPct  = step.fail_below_threshold_percent;
  const warnBelow = warnPct != null
    ? resolveThreshold(step.warn_below, A, B) * warnPct / 100 : null;
  const failBelow = failPct != null
    ? resolveThreshold(step.fail_below, A, B) * failPct / 100 : null;

  let started   = false;
  let prevT     = null;
  let warnStart = null;
  let failStart = null;
  let ok_s = 0, warn_s = 0, invalid_s = 0;
  const violations = [];

  function canStart(sample, runtimeCtx) {
    if (step.after === 'after_ramp') {
      const deadline = runtimeCtx.rampDeadline_s;
      // If a ramp step is present (hasRampStep) but deadline not set yet, wait.
      if (runtimeCtx.hasRampStep && deadline == null) return false;
      if (deadline != null && sample.t < deadline) return false;
    } else if (step.after === 'first_above_A') {
      if (sample.I < A) return false;
    }
    return true;
  }

  return {
    update(sample, _prev, runtimeCtx) {
      if (warnBelow === null && failBelow === null) return;

      if (!started) {
        if (!canStart(sample, runtimeCtx)) return;
        started = true;
        prevT   = sample.t;
        // Fall through: first sample contributes dt=0 but can open a violation.
      }

      if (runtimeCtx.completedAt_s != null && sample.t > runtimeCtx.completedAt_s) return;

      const effectiveI = runtimeCtx.effectiveI ?? sample.I;
      const dt = sample.t - prevT;
      prevT = sample.t;

      // Zone time accumulation
      if (dt > 0) {
        if (failBelow !== null && effectiveI < failBelow) {
          invalid_s += dt;
        } else if (warnBelow !== null && effectiveI < warnBelow) {
          warn_s += dt;
        } else {
          ok_s += dt;
        }
      }

      // Fail-zone violation
      if (failBelow !== null) {
        if (effectiveI < failBelow) {
          if (failStart === null) failStart = sample.t;
        } else if (failStart !== null) {
          violations.push({
            ruleId: step.id, severity: 'error',
            tStart_s: failStart, tEnd_s: sample.t,
            messageKey: 'below_A',
            details: { threshold_mA: Math.round(failBelow * 10) / 10 }
          });
          failStart = null;
        }
      }

      // Warn-zone violation (only while above fail threshold)
      if (warnBelow !== null) {
        const aboveFail = failBelow === null || effectiveI >= failBelow;
        if (effectiveI < warnBelow && aboveFail) {
          if (warnStart === null) warnStart = sample.t;
        } else if (warnStart !== null) {
          violations.push({
            ruleId: step.id, severity: 'warn',
            tStart_s: warnStart, tEnd_s: sample.t,
            messageKey: 'below_B',
            details: { threshold_mA: Math.round(warnBelow * 10) / 10 }
          });
          warnStart = null;
        }
      }

      runtimeCtx.ok_s      = ok_s;
      runtimeCtx.warn_s    = warn_s;
      runtimeCtx.invalid_s = invalid_s;
    },

    finalize(lastSample, runtimeCtx) {
      const tEnd = runtimeCtx.completedAt_s ?? (lastSample?.t ?? 0);

      if (failStart !== null) {
        violations.push({
          ruleId: step.id, severity: 'error',
          tStart_s: failStart, tEnd_s: tEnd,
          messageKey: 'below_A',
          details: { threshold_mA: Math.round(failBelow * 10) / 10 }
        });
      }
      if (warnStart !== null) {
        violations.push({
          ruleId: step.id, severity: 'warn',
          tStart_s: warnStart, tEnd_s: tEnd,
          messageKey: 'below_B',
          details: { threshold_mA: Math.round(warnBelow * 10) / 10 }
        });
      }

      // Monitoring window had no samples (e.g. data ends before ramp deadline)
      if (!started && failBelow !== null) {
        violations.push({
          ruleId: step.id, severity: 'error',
          tStart_s: 0, tEnd_s: lastSample?.t ?? 0,
          messageKey: 'never_reached_A',
          isSummary: true,
          details: { required_mA: Math.round(failBelow * 10) / 10 }
        });
      }

      return { violations, meta: { ok_s, warn_s, invalid_s } };
    }
  };
}

/**
 * min_duration_above — accumulate time where both this and prev sample
 * are above threshold, until the required duration is met.
 *
 * Gap violations open at the first failing sample (not the preceding OK one).
 * Sets runtimeCtx.completedAt_s when goal is reached.
 */
function createDurationHandler(step, A, B, bindings, logEntry) {
  const threshold    = resolveThreshold(step.threshold, A, B);
  const requiredField = step.duration_from;
  const requiredS    = logEntry[bindings[requiredField]] ?? logEntry.time_s ?? 0;

  let totalAbove    = 0;
  let gapStart      = null;
  let completedAt_s = null;
  const durationSeries = [];
  const violations     = [];

  return {
    update(sample, prevSample, runtimeCtx) {
      if (prevSample == null) return;

      const accumulateStart    = runtimeCtx.accumulateStart_s;
      if (accumulateStart == null || sample.t <= accumulateStart) return;
      if (completedAt_s !== null) return;

      const violationGuardStart = runtimeCtx.rampDeadline_s ?? 0;
      const bothAbove = sample.I >= threshold && prevSample.I >= threshold;

      if (bothAbove) {
        const dtStart = Math.max(prevSample.t, accumulateStart);
        totalAbove += sample.t - dtStart;

        if (completedAt_s === null && totalAbove >= requiredS) {
          completedAt_s = sample.t;
          runtimeCtx.completedAt_s = completedAt_s;
        }

        if (gapStart !== null) {
          if (completedAt_s === null) {
            violations.push({
              ruleId: step.id, severity: 'warn',
              tStart_s: gapStart, tEnd_s: prevSample.t,
              messageKey: 'below_threshold_gap',
              details: { threshold_mA: threshold }
            });
          }
          gapStart = null;
        }
      } else if (sample.I < threshold && completedAt_s === null) {
        if (gapStart === null && sample.t > violationGuardStart) {
          gapStart = Math.max(sample.t, violationGuardStart);
        }
      }

      if (durationSeries.length === 0) {
        durationSeries.push({ t: accumulateStart, pct: 0 });
      }
      durationSeries.push({
        t:   sample.t,
        pct: requiredS > 0 ? Math.min(totalAbove / requiredS, 1) * 100 : 0
      });
    },

    finalize(lastSample, runtimeCtx) {
      if (gapStart !== null && completedAt_s === null && lastSample) {
        violations.push({
          ruleId: step.id, severity: 'warn',
          tStart_s: gapStart, tEnd_s: lastSample.t,
          messageKey: 'below_threshold_gap',
          details: { threshold_mA: threshold }
        });
      }

      if (totalAbove < requiredS) {
        violations.push({
          ruleId: step.id, severity: 'error',
          tStart_s: 0, tEnd_s: lastSample?.t ?? 0,
          messageKey: 'duration_not_reached',
          isSummary: true,
          details: {
            required_s:   requiredS,
            actual_s:     Math.round(totalAbove * 100) / 100,
            threshold_mA: threshold
          }
        });
      }

      const accumulateStart = runtimeCtx.accumulateStart_s ?? 0;
      return {
        violations,
        meta: {
          totalAbove_s: totalAbove,
          required_s:   requiredS,
          completedAt_s,
          durationSeries,
          stunning_accumulate_start_s: accumulateStart
        }
      };
    }
  };
}

/**
 * charge_integral — accumulate mA·s charge (trapezoidal, clamped at limit_to,
 * cutoff samples contribute 0) until the required charge is met.
 *
 * Cutoff-zone violations open at the first failing sample.
 * Sets runtimeCtx.completedAt_s when goal is reached.
 * Populates integralSeries for the overlay progress line.
 */
function createIntegralHandler(step, A, B, bindings, logEntry) {
  const limitValue    = resolveThreshold(step.limit_to ?? 'setpoint_mA', A, B);
  const cutoffPercent = step.current_threshold_percent ?? 70;
  const cutoff        = (cutoffPercent / 100) * limitValue;

  const target       = step.target || {};
  const requiredS    = logEntry[bindings[target.duration_from]] ?? logEntry.time_s ?? 0;
  const requiredI    = logEntry[bindings[target.current_from]]  ?? logEntry.current_mA ?? 0;
  const targetIntegral = requiredS * requiredI;

  let integral      = 0;
  let deadStart     = null;
  let completedAt_s = null;
  const integralSeries = [];
  const violations     = [];

  return {
    update(sample, prevSample, runtimeCtx) {
      if (prevSample == null) return;

      const accumulateStart = runtimeCtx.accumulateStart_s;
      if (accumulateStart == null || sample.t <= accumulateStart) return;
      if (completedAt_s !== null) return;

      const violationGuardStart = runtimeCtx.rampDeadline_s ?? 0;
      const dtStart = Math.max(prevSample.t, accumulateStart);
      const dt  = sample.t - dtStart;
      const I0  = prevSample.I;
      const I1  = sample.I;
      const eff0 = I0 >= cutoff ? Math.min(I0, limitValue) : 0;
      const eff1 = I1 >= cutoff ? Math.min(I1, limitValue) : 0;

      integral += ((eff0 + eff1) / 2) * dt;

      if (integralSeries.length === 0) {
        integralSeries.push({ t: accumulateStart, pct: 0 });
      }
      integralSeries.push({
        t:   sample.t,
        pct: targetIntegral > 0 ? Math.min(integral / targetIntegral, 1) * 100 : 0
      });

      if (completedAt_s === null && integral >= targetIntegral) {
        completedAt_s = sample.t;
        runtimeCtx.completedAt_s = completedAt_s;
      }

      // Cutoff-zone violation tracking
      const isBelowCutoff = I1 < cutoff;
      if (isBelowCutoff && completedAt_s === null) {
        if (deadStart === null && sample.t > violationGuardStart) {
          deadStart = Math.max(sample.t, violationGuardStart);
        }
      } else if (deadStart !== null) {
        if (completedAt_s === null) {
          violations.push({
            ruleId: step.id, severity: 'warn',
            tStart_s: deadStart, tEnd_s: sample.t,
            messageKey: 'below_cutoff_zone',
            details: { cutoff_mA: Math.round(cutoff * 10) / 10 }
          });
        }
        deadStart = null;
      }
    },

    finalize(lastSample, runtimeCtx) {
      if (deadStart !== null && completedAt_s === null && lastSample) {
        violations.push({
          ruleId: step.id, severity: 'warn',
          tStart_s: deadStart, tEnd_s: lastSample.t,
          messageKey: 'below_cutoff_zone',
          details: { cutoff_mA: Math.round(cutoff * 10) / 10 }
        });
      }

      if (integral < targetIntegral) {
        violations.push({
          ruleId: step.id, severity: 'error',
          tStart_s: 0, tEnd_s: lastSample?.t ?? 0,
          messageKey: 'integral_not_reached',
          isSummary: true,
          details: {
            target_mAs:    Math.round(targetIntegral * 10) / 10,
            actual_mAs:    Math.round(integral       * 10) / 10,
            limitTo:       step.limit_to ?? 'setpoint_mA',
            cutoff_percent: cutoffPercent
          }
        });
      }

      const accumulateStart = runtimeCtx.accumulateStart_s ?? 0;
      return {
        violations,
        meta: {
          integral_mAs:  integral,
          target_mAs:    targetIntegral,
          integralSeries,
          completedAt_s,
          stunning_accumulate_start_s: accumulateStart
        }
      };
    }
  };
}

/**
 * invalid_timeout — summary error when total INVALID zone time exceeds limit.
 * Reads runtimeCtx.invalid_s accumulated by sustain_thresholds.
 */
function createInvalidTimeoutHandler(step) {
  return {
    update() {},
    finalize(_last, runtimeCtx) {
      const maxInvalidS = step.max_invalid_s ?? 0;
      const invalidS    = runtimeCtx?.invalid_s ?? 0;
      if (invalidS > maxInvalidS) {
        return {
          violations: [{
            ruleId: step.id, severity: 'error',
            tStart_s: 0, tEnd_s: 0,
            messageKey: 'invalid_timeout',
            isSummary: true,
            details: {
              max_invalid_s:    maxInvalidS,
              actual_invalid_s: Math.round(invalidS * 1000) / 1000
            }
          }],
          meta: {}
        };
      }
      return { violations: [], meta: {} };
    }
  };
}

/**
 * total_timeout — summary error when the recording duration exceeds
 * factor × required_duration_s.
 */
function createTotalTimeoutHandler(step, bindings, logEntry) {
  const factor        = step.factor ?? 3.0;
  const requiredField = step.duration_from ?? 'required_duration_s';
  const requiredS     = logEntry[bindings[requiredField]] ?? logEntry.time_s ?? 0;
  let firstT = null;

  return {
    update(sample) {
      if (firstT === null) firstT = sample.t;
    },
    finalize(lastSample) {
      if (firstT === null || lastSample == null) return { violations: [], meta: {} };
      const totalS   = lastSample.t - firstT;
      const timeoutS = factor * requiredS;
      if (requiredS > 0 && totalS > timeoutS) {
        return {
          violations: [{
            ruleId: step.id, severity: 'error',
            tStart_s: 0, tEnd_s: totalS,
            messageKey: 'total_timeout',
            isSummary: true,
            details: {
              factor,
              required_s: requiredS,
              timeout_s:  Math.round(timeoutS * 100) / 100,
              actual_s:   Math.round(totalS   * 100) / 100
            }
          }],
          meta: {}
        };
      }
      return { violations: [], meta: {} };
    }
  };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

const OP_MAP = {
  glitch_ignore:      'glitch_ignore',
  ramp_to_threshold:  'ramp',
  sustain_thresholds: 'sustain',
  min_duration_above: 'duration',
  charge_integral:    'integral',
  invalid_timeout:    'invalid_timeout',
  total_timeout:      'total_timeout'
};

function createHandler(step, A, B, bindings, logEntry) {
  switch (OP_MAP[step.op]) {
    case 'glitch_ignore':   return createGlitchIgnoreHandler(step, A, B);
    case 'ramp':            return createRampHandler(step, A, B);
    case 'sustain':         return createSustainHandler(step, A, B);
    case 'duration':        return createDurationHandler(step, A, B, bindings, logEntry);
    case 'integral':        return createIntegralHandler(step, A, B, bindings, logEntry);
    case 'invalid_timeout': return createInvalidTimeoutHandler(step);
    case 'total_timeout':   return createTotalTimeoutHandler(step, bindings, logEntry);
    default:
      console.warn(`[EvaluationEngine] Unknown op: ${step.op}`);
      return { update() {}, finalize() { return { violations: [], meta: {} }; } };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a log entry against an algorithm spec.
 *
 * @param {Object} logEntry - A single log record (with measurements, current_mA, etc.)
 * @param {Object} spec     - Algorithm spec JSON (from the registry)
 * @returns {{ ok: boolean, violations: Array, meta: Object, thresholds: { A: number, B: number } }}
 */
export function evaluate(logEntry, spec) {
  if (!logEntry || !spec) {
    return { ok: false, violations: [], meta: {}, thresholds: { A: 0, B: 0 } };
  }

  const bindings = spec.bindings || {};
  const A = logEntry[bindings.nominal_mA]  ?? logEntry.default_current_mA ?? 0;
  const B = logEntry[bindings.setpoint_mA] ?? logEntry.current_mA         ?? 0;

  const points = normalizeMeasurements(logEntry);
  if (points.length === 0) {
    return { ok: false, violations: [], meta: { error: 'no_measurements' }, thresholds: { A, B } };
  }

  // Pre-scan: initialise timing defaults for algorithms without a ramp step,
  // and flag the ramp step's presence so sustain_thresholds knows to wait.
  const runtimeCtx = {};
  let hasRampStep = false;
  for (const step of (spec.steps || [])) {
    if (step.op === 'ramp_to_threshold') { hasRampStep = true; break; }
  }
  if (!hasRampStep) {
    // No ramp — monitoring and accumulation start from the first sample.
    runtimeCtx.rampDeadline_s   = 0;
    runtimeCtx.accumulateStart_s = 0;
  } else {
    runtimeCtx.hasRampStep = true;
  }

  // Create one handler per step
  const handlers = (spec.steps || []).map(step => ({
    step,
    handler: createHandler(step, A, B, bindings, logEntry)
  }));

  // ---- Sample-by-sample processing ----------------------------------------
  // Every sample is fed through all handlers in step order before the next
  // sample is processed. Steps communicate via runtimeCtx (e.g. glitch sets
  // effectiveI, ramp sets rampDeadline_s, duration/integral set completedAt_s).
  let prevSample = null;
  for (const sample of points) {
    for (const { handler } of handlers) {
      handler.update(sample, prevSample, runtimeCtx);
    }
    prevSample = sample;
  }

  // ---- Finalise: collect violations and meta ------------------------------
  const allViolations = [];
  const allMeta       = {};

  for (const { step, handler } of handlers) {
    const violationsBefore = allViolations.length;
    const { violations, meta } = handler.finalize(prevSample, runtimeCtx);
    allViolations.push(...violations);
    Object.assign(allMeta, meta);

    if (step.type) {
      for (let i = violationsBefore; i < allViolations.length; i++) {
        allViolations[i] = { ...allViolations[i], stepType: step.type };
      }
    }
  }

  // ---- Post-processing: truncate violations after completion ---------------
  const completedAt = allMeta.completedAt_s;
  if (completedAt != null) {
    for (let i = allViolations.length - 1; i >= 0; i--) {
      const v = allViolations[i];
      if (v.isSummary) continue;
      if (v.tStart_s >= completedAt) {
        allViolations.splice(i, 1);
      } else if (v.tEnd_s > completedAt) {
        v.tEnd_s = completedAt;
      }
    }
  }

  // ---- Post-processing: suppress warn fully covered by an error -----------
  const errorViolations = allViolations.filter(v => !v.isSummary && v.severity === 'error');
  for (let i = allViolations.length - 1; i >= 0; i--) {
    const v = allViolations[i];
    if (v.isSummary || v.severity !== 'warn') continue;
    const covered = errorViolations.some(e => e.tStart_s <= v.tStart_s && e.tEnd_s >= v.tEnd_s);
    if (covered) allViolations.splice(i, 1);
  }

  // ---- Overlay hints -------------------------------------------------------
  const overlayHints = {};
  if (allMeta.rampStart_s != null) {
    overlayHints.rampStart_s      = allMeta.rampStart_s;
    overlayHints.rampDeadline_s   = allMeta.rampDeadline_s;
    overlayHints.rampReachedAt_s  = allMeta.rampReachedAt_s ?? null;
  }
  if (allMeta.completedAt_s != null) {
    overlayHints.completedAt_s = allMeta.completedAt_s;
  }
  for (const step of (spec.steps || [])) {
    if (step.op === 'sustain_thresholds') {
      const warnPct = step.warn_below_threshold_percent;
      const failPct = step.fail_below_threshold_percent;
      overlayHints.effectiveWarnBelow_mA = warnPct != null
        ? resolveThreshold(step.warn_below, A, B) * warnPct / 100 : null;
      overlayHints.effectiveFailBelow_mA = failPct != null
        ? resolveThreshold(step.fail_below, A, B) * failPct / 100 : null;
      overlayHints.failBelowName    = step.fail_below;
      overlayHints.warnBelowName    = step.warn_below;
      overlayHints.failBelowPercent = failPct;
      overlayHints.warnBelowPercent = warnPct;
    }
    if (step.op === 'min_duration_above') {
      overlayHints.durationSeries = allMeta.durationSeries ?? null;
    }
    if (step.op === 'charge_integral') {
      const limitVal = resolveThreshold(step.limit_to ?? 'setpoint_mA', A, B);
      const cutPct   = step.current_threshold_percent ?? 70;
      overlayHints.integralCutoff_mA = (cutPct / 100) * limitVal;
      overlayHints.integralSeries    = allMeta.integralSeries ?? null;
    }
  }

  const hasError = allViolations.some(v => v.severity === 'error');
  const hasWarn  = allViolations.some(v => v.severity === 'warn');

  return {
    ok: !hasError,
    hasWarn,
    violations:   allViolations,
    meta:         allMeta,
    thresholds:   { A, B },
    overlayHints
  };
}

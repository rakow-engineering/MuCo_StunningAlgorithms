/**
 * StunningEvaluationEngine
 *
 * Interprets an algorithm spec (JSON-DSL) and evaluates a log entry's
 * measurement data against the rules defined in that spec.
 *
 * The same spec JSON can also be consumed by a C code generator for the
 * embedded target — this JS implementation is the reference interpreter.
 *
 * Usage:
 *   import { evaluate } from './StunningEvaluationEngine';
 *   const result = evaluate(logEntry, spec);
 *   // result = { ok, violations, meta }
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
// Step implementations (primitives)
// ---------------------------------------------------------------------------

/**
 * glitch_ignore — mark glitch gaps shorter than max_gap_ms as "ignored".
 * Returns a copy of the points array where short dips below `ref` are held
 * at the last good value so they do not trigger violation checks.
 *
 * The original points array is NOT mutated. Raw current values are preserved
 * for steps that must see actual signal (charge_integral, min_duration_above).
 */
function stepGlitchIgnore(points, step, A, B) {
  const threshold = resolveThreshold(step.ref, A, B);
  const maxGapS = (step.max_gap_ms ?? 100) / 1000;

  const result = points.map(p => ({ ...p }));
  let dipStart = -1;

  for (let i = 0; i < result.length; i++) {
    if (result[i].I < threshold) {
      if (dipStart === -1) dipStart = i;
    } else {
      if (dipStart !== -1) {
        const gapDuration = result[i].t - result[dipStart].t;
        if (gapDuration < maxGapS) {
          const holdValue = dipStart > 0 ? result[dipStart - 1].I : threshold;
          for (let j = dipStart; j < i; j++) {
            result[j].I = holdValue;
            result[j]._glitchIgnored = true;
          }
        }
        dipStart = -1;
      }
    }
  }
  return result;
}

/**
 * Returns when monitor violation counting may start (sustain_thresholds).
 *
 * Always waits for the full ramp deadline — the entire timeout_ms window is
 * protected regardless of whether the setpoint was reached early. This prevents
 * false warnings during normal current rise.
 */
function getMonitorStart(runtimeCtx) {
  return runtimeCtx?.rampDeadline_s ?? 0;
}

/**
 * Returns when duration/integral accumulation starts (completion steps).
 *
 * If count_during_ramp is true, counting begins when the ramp timer starts.
 * Otherwise it begins when the setpoint is first reached (rampReachedAt_s),
 * or at the ramp deadline if the setpoint was never reached.
 */
function getStunningAccumulateStart(runtimeCtx) {
  if (runtimeCtx?.count_during_ramp === true) {
    return runtimeCtx?.rampStart_s ?? 0;
  }
  return runtimeCtx?.rampReachedAt_s ?? runtimeCtx?.rampDeadline_s ?? 0;
}

/**
 * ramp_to_threshold — check that current reaches threshold within timeout_ms.
 *
 * The ramp window starts when current first exceeds ramp_start_mA (default 10 mA),
 * not at t=0. The deadline is rampStart + timeout_ms/1000.
 * If timeout_ms is null, the ramp check is disabled.
 *
 * Returns { violations, rampMeta } where rampMeta contains timing info
 * for the overlay (rampStart_s, rampDeadline_s, rampReachedAt_s).
 */
function stepRampToThreshold(points, step, A, B) {
  const windowS = step.timeout_ms != null ? step.timeout_ms / 1000 : null;
  const rampMeta = {};

  if (windowS == null) return { violations: [], rampMeta };

  const baseThreshold = resolveThreshold(step.threshold, A, B);
  const pct = step.current_threshold_percent ?? 100;
  const threshold = baseThreshold * pct / 100;
  const violations = [];

  const rampStartMa = step.ramp_start_mA ?? 10;
  const startIdx = points.findIndex(p => p.I > rampStartMa);
  const rampStart = startIdx !== -1 ? points[startIdx].t : 0;
  const rampDeadline = rampStart + windowS;

  rampMeta.rampStart_s = rampStart;
  rampMeta.rampDeadline_s = rampDeadline;

  // Find the time when threshold was actually reached
  const reachedIdx = points.findIndex(p => p.t >= rampStart && p.I >= threshold);
  if (reachedIdx !== -1) {
    rampMeta.rampReachedAt_s = points[reachedIdx].t;
  }

  // Check: was threshold reached within the window?
  const windowPoints = points.filter(p => p.t >= rampStart && p.t <= rampDeadline);
  const maxInWindow = windowPoints.reduce((mx, p) => Math.max(mx, p.I), 0);

  if (maxInWindow < threshold) {
    violations.push({
      ruleId: step.id,
      severity: 'error',
      tStart_s: rampStart,
      tEnd_s: rampDeadline,
      messageKey: 'ramp_not_reached',
      details: {
        required_mA: Math.round(threshold * 10) / 10,
        reached_mA: Math.round(maxInWindow * 10) / 10,
        timeout_ms: step.timeout_ms
      }
    });
  }

  return { violations, rampMeta };
}

/**
 * sustain_thresholds — state-based threshold monitoring.
 *
 * Violation counting starts when the ramp phase ends — whichever comes first:
 *   - rampReachedAt_s : setpoint reached early → monitoring starts immediately
 *   - rampDeadline_s  : timeout_ms elapsed without reaching setpoint → monitoring starts anyway
 *
 * Zones (after monitor start):
 *   - >= warnBelow (B) * warn_below_threshold_percent → OK (green)
 *   - >= failBelow (A) * fail_below_threshold_percent → warning (yellow)
 *   - below that → error (red)
 *
 * Both _percent values are nullable: null = that check is disabled entirely.
 * Default: 100 (percent).
 */
function stepSustainThresholds(points, step, A, B, runtimeCtx) {
  const warnPct = step.warn_below_threshold_percent;
  const failPct = step.fail_below_threshold_percent;

  const warnBelow = warnPct != null
    ? resolveThreshold(step.warn_below, A, B) * warnPct / 100
    : null;
  const failBelow = failPct != null
    ? resolveThreshold(step.fail_below, A, B) * failPct / 100
    : null;

  const violations = [];
  let ok_s = 0, warn_s = 0, invalid_s = 0;

  // If both checks are disabled, nothing to do
  if (warnBelow === null && failBelow === null) {
    return { violations, meta: { ok_s, warn_s, invalid_s } };
  }

  // Violations only start after the full ramp deadline — the entire timeout_ms window is protected.
  const monitorStart = getMonitorStart(runtimeCtx);
  const completedAt = runtimeCtx?.completedAt_s ?? null;

  let refIdx = 0;
  if (step.after === 'after_ramp' || step.after === 'first_above_A') {
    if (step.after === 'after_ramp') {
      refIdx = points.findIndex(p => p.t >= monitorStart);
    } else {
      refIdx = points.findIndex(p => p.I >= A);
    }

    if (refIdx === -1) {
      if (failBelow !== null) {
        violations.push({
          ruleId: step.id,
          severity: 'error',
          tStart_s: 0,
          tEnd_s: points.length > 0 ? points[points.length - 1].t : 0,
          messageKey: 'never_reached_A',
          isSummary: true,
          details: { required_mA: Math.round(failBelow * 10) / 10 }
        });
      }
      return { violations, meta: { ok_s, warn_s, invalid_s } };
    }
  }

  let warnStart = null;
  let failStart = null;
  let prevT = points[refIdx]?.t ?? 0;

  for (let i = refIdx; i < points.length; i++) {
    const p = points[i];

    // Stop accounting after stunning is complete
    if (completedAt !== null && p.t > completedAt) break;

    const dt = p.t - prevT;
    prevT = p.t;

    if (dt > 0) {
      if (failBelow !== null && p.I < failBelow) {
        invalid_s += dt;
      } else if (warnBelow !== null && p.I < warnBelow) {
        warn_s += dt;
      } else {
        ok_s += dt;
      }
    }

    // --- fail (below effective A threshold) ---
    if (failBelow !== null) {
      if (p.I < failBelow) {
        if (failStart === null) failStart = p.t;
      } else if (failStart !== null) {
        violations.push({
          ruleId: step.id,
          severity: 'error',
          tStart_s: failStart,
          tEnd_s: p.t,
          messageKey: 'below_A',
          details: { threshold_mA: Math.round(failBelow * 10) / 10 }
        });
        failStart = null;
      }
    }

    // --- warn (below effective B threshold but above fail threshold) ---
    if (warnBelow !== null) {
      const aboveFail = failBelow === null || p.I >= failBelow;
      if (p.I < warnBelow && aboveFail) {
        if (warnStart === null) warnStart = p.t;
      } else if (warnStart !== null) {
        violations.push({
          ruleId: step.id,
          severity: 'warn',
          tStart_s: warnStart,
          tEnd_s: p.t,
          messageKey: 'below_B',
          details: { threshold_mA: Math.round(warnBelow * 10) / 10 }
        });
        warnStart = null;
      }
    }
  }

  // Close open intervals at end of data (or at completedAt)
  const tEnd = completedAt ?? (points.length > 0 ? points[points.length - 1].t : 0);
  if (failStart !== null) {
    violations.push({
      ruleId: step.id,
      severity: 'error',
      tStart_s: failStart,
      tEnd_s: tEnd,
      messageKey: 'below_A',
      details: { threshold_mA: Math.round(failBelow * 10) / 10 }
    });
  }
  if (warnStart !== null) {
    violations.push({
      ruleId: step.id,
      severity: 'warn',
      tStart_s: warnStart,
      tEnd_s: tEnd,
      messageKey: 'below_B',
      details: { threshold_mA: Math.round(warnBelow * 10) / 10 }
    });
  }

  return { violations, meta: { ok_s, warn_s, invalid_s } };
}

/**
 * invalid_timeout — fails if total time below fail threshold exceeded max_invalid_s.
 * Must run after sustain_thresholds so that runtimeCtx.invalid_s is populated.
 */
function stepInvalidTimeout(step, runtimeCtx) {
  const maxInvalidS = step.max_invalid_s ?? 0;
  const invalidS = runtimeCtx?.invalid_s ?? 0;
  if (invalidS > maxInvalidS) {
    return [{
      ruleId: step.id,
      severity: 'error',
      tStart_s: 0,
      tEnd_s: 0,
      messageKey: 'invalid_timeout',
      isSummary: true,
      details: {
        max_invalid_s: maxInvalidS,
        actual_invalid_s: Math.round(invalidS * 1000) / 1000
      }
    }];
  }
  return [];
}

/**
 * total_timeout — fails if the total recording duration exceeds
 * factor × required_duration_s.
 */
function stepTotalTimeout(step, points, bindings, logEntry) {
  const factor = step.factor ?? 3.0;
  const requiredField = step.duration_from ?? 'required_duration_s';
  const requiredS = logEntry[bindings[requiredField]] ?? logEntry.time_s ?? 0;
  const totalS = points.length > 1
    ? points[points.length - 1].t - points[0].t
    : 0;
  const timeoutS = factor * requiredS;
  if (requiredS > 0 && totalS > timeoutS) {
    return [{
      ruleId: step.id,
      severity: 'error',
      tStart_s: 0,
      tEnd_s: totalS,
      messageKey: 'total_timeout',
      isSummary: true,
      details: {
        factor,
        required_s: requiredS,
        timeout_s: Math.round(timeoutS * 100) / 100,
        actual_s: Math.round(totalS * 100) / 100
      }
    }];
  }
  return [];
}

/**
 * min_duration_above — state-based duration check.
 *
 * Evaluation begins after the ramp phase (derived from rampDeadline_s, or
 * falls back to step.ramp_window_s if no ramp step ran). Gaps during ramp are ignored.
 * Once totalAbove >= required, the stunning is "complete" — subsequent drops
 * are normal shutdown, not errors.
 */
function stepMinDurationAbove(points, step, A, B, bindings, logEntry, runtimeCtx) {
  const threshold = resolveThreshold(step.threshold, A, B);
  const requiredField = step.duration_from;
  const requiredS = logEntry[bindings[requiredField]] ?? logEntry.time_s ?? 0;
  const accumulateStart = getStunningAccumulateStart(runtimeCtx);
  // Violations (gap warnings) are only opened after the ramp phase ends.
  // When count_during_ramp=false both values are equal; when true, accumulateStart is earlier.
  const violationGuardStart = getMonitorStart(runtimeCtx);
  const violations = [];

  let totalAbove = 0;
  let gapStart = null;
  let completedAt_s = null;

  for (let i = 1; i < points.length; i++) {
    if (points[i].t <= accumulateStart) continue;

    const bothAbove = points[i].I >= threshold && points[i - 1].I >= threshold;

    if (bothAbove) {
      const dtStart = Math.max(points[i - 1].t, accumulateStart);
      totalAbove += points[i].t - dtStart;

      if (completedAt_s === null && totalAbove >= requiredS) {
        completedAt_s = points[i].t;
      }

      if (gapStart !== null) {
        if (completedAt_s === null) {
          violations.push({
            ruleId: step.id,
            severity: 'warn',
            tStart_s: gapStart,
            tEnd_s: points[i - 1].t,
            messageKey: 'below_threshold_gap',
            details: { threshold_mA: threshold }
          });
        }
        gapStart = null;
      }
    } else if (points[i].I < threshold && completedAt_s === null) {
      if (gapStart === null && points[i].t > violationGuardStart) {
        gapStart = Math.max(points[i].t, violationGuardStart);
      }
    }
  }

  if (gapStart !== null && completedAt_s === null && points.length > 0) {
    violations.push({
      ruleId: step.id,
      severity: 'warn',
      tStart_s: gapStart,
      tEnd_s: points[points.length - 1].t,
      messageKey: 'below_threshold_gap',
      details: { threshold_mA: threshold }
    });
  }

  if (totalAbove < requiredS) {
    violations.push({
      ruleId: step.id,
      severity: 'error',
      tStart_s: 0,
      tEnd_s: points.length > 0 ? points[points.length - 1].t : 0,
      messageKey: 'duration_not_reached',
      isSummary: true,
      details: {
        required_s: requiredS,
        actual_s: Math.round(totalAbove * 100) / 100,
        threshold_mA: threshold
      }
    });
  }

  return {
    violations,
    meta: {
      totalAbove_s: totalAbove,
      required_s: requiredS,
      completedAt_s,
      stunning_accumulate_start_s: accumulateStart
    }
  };
}

/**
 * charge_integral — state-based integral check.
 *
 * Integration starts after the ramp phase (derived from rampDeadline_s, or
 * falls back to step.ramp_window_s if no ramp step ran). Once the integral target is met, the stunning is "complete" —
 * subsequent dead zones are normal shutdown, not warnings.
 */
function stepChargeIntegral(points, step, A, B, bindings, logEntry, runtimeCtx) {
  const limitValue = resolveThreshold(step.limit_to ?? 'setpoint_mA', A, B);
  const cutoffPercent = step.current_threshold_percent ?? 70;
  const cutoff = (cutoffPercent / 100) * limitValue;
  const accumulateStart = getStunningAccumulateStart(runtimeCtx);
  // Violations (cutoff warnings) are only opened after the ramp phase ends.
  // When count_during_ramp=false both values are equal; when true, accumulateStart is earlier.
  const violationGuardStart = getMonitorStart(runtimeCtx);

  const target = step.target || {};
  const requiredS = logEntry[bindings[target.duration_from]] ?? logEntry.time_s ?? 0;
  const requiredI = logEntry[bindings[target.current_from]] ?? logEntry.current_mA ?? 0;
  const targetIntegral = requiredS * requiredI;

  let integral = 0;
  const violations = [];
  const integralSeries = [];
  let deadStart = null;
  let completedAt_s = null;

  for (let i = 1; i < points.length; i++) {
    if (points[i].t <= accumulateStart) continue;

    const dtStart = Math.max(points[i - 1].t, accumulateStart);
    const dt = points[i].t - dtStart;
    const I0 = points[i - 1].I;
    const I1 = points[i].I;

    const eff0 = I0 >= cutoff ? Math.min(I0, limitValue) : 0;
    const eff1 = I1 >= cutoff ? Math.min(I1, limitValue) : 0;

    integral += ((eff0 + eff1) / 2) * dt;

    integralSeries.push({
      t: points[i].t,
      pct: targetIntegral > 0 ? Math.min(integral / targetIntegral, 1) * 100 : 0
    });

    if (completedAt_s === null && integral >= targetIntegral) {
      completedAt_s = points[i].t;
    }

    const isBelowCutoff = I1 < cutoff;
    if (isBelowCutoff && completedAt_s === null) {
      if (deadStart === null && points[i].t > violationGuardStart) {
        deadStart = Math.max(points[i].t, violationGuardStart);
      }
    } else if (deadStart !== null) {
      if (completedAt_s === null) {
        violations.push({
          ruleId: step.id,
          severity: 'warn',
          tStart_s: deadStart,
          tEnd_s: points[i].t,
          messageKey: 'below_cutoff_zone',
          details: { cutoff_mA: Math.round(cutoff * 10) / 10 }
        });
      }
      deadStart = null;
    }
  }

  if (deadStart !== null && completedAt_s === null && points.length > 0) {
    violations.push({
      ruleId: step.id,
      severity: 'warn',
      tStart_s: deadStart,
      tEnd_s: points[points.length - 1].t,
      messageKey: 'below_cutoff_zone',
      details: { cutoff_mA: Math.round(cutoff * 10) / 10 }
    });
  }

  if (integral < targetIntegral) {
    violations.push({
      ruleId: step.id,
      severity: 'error',
      tStart_s: 0,
      tEnd_s: points.length > 0 ? points[points.length - 1].t : 0,
      messageKey: 'integral_not_reached',
      isSummary: true,
      details: {
        target_mAs: Math.round(targetIntegral * 10) / 10,
        actual_mAs: Math.round(integral * 10) / 10,
        limitTo: step.limit_to ?? 'setpoint_mA',
        cutoff_percent: cutoffPercent
      }
    });
  }

  return {
    violations,
    meta: {
      integral_mAs: integral,
      target_mAs: targetIntegral,
      integralSeries,
      completedAt_s,
      stunning_accumulate_start_s: accumulateStart
    }
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
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
  // Resolved currents for threshold refs nominal_mA / setpoint_mA (aliases A / B)
  const A = logEntry[bindings.nominal_mA] ?? logEntry.default_current_mA ?? 0;
  const B = logEntry[bindings.setpoint_mA] ?? logEntry.current_mA ?? 0;

  let points = normalizeMeasurements(logEntry);
  if (points.length === 0) {
    return { ok: false, violations: [], meta: { error: 'no_measurements' }, thresholds: { A, B } };
  }

  const allViolations = [];
  const allMeta = {};
  const runtimeCtx = {};

  for (const step of (spec.steps || [])) {
    const opKey = OP_MAP[step.op];
    if (!opKey) {
      console.warn(`[EvaluationEngine] Unknown op: ${step.op}`);
      continue;
    }

    const violationsBefore = allViolations.length;

    switch (opKey) {
      case 'glitch_ignore':
        // Glitch-ignored values are only used by sustain_thresholds (violation detection).
        // charge_integral and min_duration_above must see actual current so that
        // real dips below nominal correctly reduce the integral / extend stunning time.
        runtimeCtx.mergedPoints = stepGlitchIgnore(points, step, A, B);
        break;

      case 'ramp': {
        const { violations: v, rampMeta } = stepRampToThreshold(points, step, A, B);
        allViolations.push(...v);
        Object.assign(allMeta, rampMeta);
        runtimeCtx.rampStart_s = rampMeta.rampStart_s;
        runtimeCtx.rampDeadline_s = rampMeta.rampDeadline_s;
        runtimeCtx.rampReachedAt_s = rampMeta.rampReachedAt_s;
        runtimeCtx.count_during_ramp = step.count_during_ramp === true;
        break;
      }

      case 'sustain': {
        // Use glitch-merged points for violation detection if a merge step ran.
        // Actual current (raw points) is intentionally NOT used here — the merged
        // version suppresses sub-nominal glitches so they don't trigger zone violations.
        const sustainPoints = runtimeCtx.mergedPoints ?? points;
        const { violations: v, meta: sustainMeta } = stepSustainThresholds(sustainPoints, step, A, B, runtimeCtx);
        allViolations.push(...v);
        // Accumulate zone durations so invalid_timeout can read them
        runtimeCtx.ok_s     = (runtimeCtx.ok_s     ?? 0) + sustainMeta.ok_s;
        runtimeCtx.warn_s   = (runtimeCtx.warn_s   ?? 0) + sustainMeta.warn_s;
        runtimeCtx.invalid_s = (runtimeCtx.invalid_s ?? 0) + sustainMeta.invalid_s;
        allMeta.ok_s     = runtimeCtx.ok_s;
        allMeta.warn_s   = runtimeCtx.warn_s;
        allMeta.invalid_s = runtimeCtx.invalid_s;
        break;
      }

      case 'duration': {
        const { violations, meta } = stepMinDurationAbove(points, step, A, B, bindings, logEntry, runtimeCtx);
        allViolations.push(...violations);
        Object.assign(allMeta, meta);
        if (meta.completedAt_s != null) runtimeCtx.completedAt_s = meta.completedAt_s;
        break;
      }

      case 'integral': {
        const { violations, meta } = stepChargeIntegral(points, step, A, B, bindings, logEntry, runtimeCtx);
        allViolations.push(...violations);
        Object.assign(allMeta, meta);
        if (meta.completedAt_s != null) runtimeCtx.completedAt_s = meta.completedAt_s;
        break;
      }

      case 'invalid_timeout': {
        const v = stepInvalidTimeout(step, runtimeCtx);
        allViolations.push(...v);
        break;
      }

      case 'total_timeout': {
        const v = stepTotalTimeout(step, points, bindings, logEntry);
        allViolations.push(...v);
        break;
      }

      default:
        break;
    }

    if (step.type) {
      for (let i = violationsBefore; i < allViolations.length; i++) {
        allViolations[i] = { ...allViolations[i], stepType: step.type };
      }
    }
  }

  // State-based post-processing: once stunning is "complete" (required
  // duration/integral met), subsequent current drops are normal shutdown.
  // Remove or truncate violations that fall after the completion point.
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

  // Suppress warn violations whose interval is fully covered by an error violation.
  // When an error already flags the same period, the warning is redundant.
  const errorViolations = allViolations.filter(v => !v.isSummary && v.severity === 'error');
  for (let i = allViolations.length - 1; i >= 0; i--) {
    const v = allViolations[i];
    if (v.isSummary || v.severity !== 'warn') continue;
    const covered = errorViolations.some(e => e.tStart_s <= v.tStart_s && e.tEnd_s >= v.tEnd_s);
    if (covered) allViolations.splice(i, 1);
  }

  // Compute overlay hints from the spec + computed ramp meta
  const overlayHints = {};

  // Ramp timing from rampMeta (computed during step execution)
  if (allMeta.rampStart_s != null) {
    overlayHints.rampStart_s = allMeta.rampStart_s;
    overlayHints.rampDeadline_s = allMeta.rampDeadline_s;
    overlayHints.rampReachedAt_s = allMeta.rampReachedAt_s ?? null;
  }

  // Completion time — when required duration/integral was fully met
  if (allMeta.completedAt_s != null) {
    overlayHints.completedAt_s = allMeta.completedAt_s;
  }

  for (const step of (spec.steps || [])) {
    if (step.op === 'sustain_thresholds') {
      const warnPct = step.warn_below_threshold_percent;
      const failPct = step.fail_below_threshold_percent;
      overlayHints.effectiveWarnBelow_mA = warnPct != null
        ? resolveThreshold(step.warn_below, A, B) * warnPct / 100
        : null;
      overlayHints.effectiveFailBelow_mA = failPct != null
        ? resolveThreshold(step.fail_below, A, B) * failPct / 100
        : null;
    }
    if (step.op === 'charge_integral') {
      const limitVal = resolveThreshold(step.limit_to ?? 'setpoint_mA', A, B);
      const cutPct = step.current_threshold_percent ?? 70;
      overlayHints.integralCutoff_mA = (cutPct / 100) * limitVal;
      overlayHints.integralSeries = allMeta.integralSeries ?? null;
    }
  }

  const hasError = allViolations.some(v => v.severity === 'error');
  const hasWarn = allViolations.some(v => v.severity === 'warn');

  return {
    ok: !hasError,
    hasWarn,
    violations: allViolations,
    meta: allMeta,
    thresholds: { A, B },
    overlayHints
  };
}

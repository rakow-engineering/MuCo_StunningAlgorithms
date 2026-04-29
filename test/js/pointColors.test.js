/**
 * Unit tests for computePointColors.
 *
 * Architecture recap
 * ------------------
 * computePointColors(samples, result) maps chart points to CSS colour strings.
 *
 * `result` comes from evaluate() in StunningEvaluationEngine and has two
 * relevant parts:
 *
 *   result.violations  — array of { severity, tStart_s, tEnd_s, isSummary }
 *     Produced by step handlers:
 *       • createSustainHandler   → 'error' (below_A) / 'warn' (below_B)
 *       • createDurationHandler  → 'warn'  (below_threshold_gap)
 *       • createIntegralHandler  → 'warn'  (below_cutoff_zone)
 *     tEnd_s is the timestamp of the FIRST CLEAN sample after the violation —
 *     so the recovery sample itself must NOT be coloured red/yellow.
 *
 *   result.overlayHints — set by handlers via runtimeCtx and _finalizeHandlers:
 *     rampStart_s          → createRampHandler  (first sample above ramp_start_mA)
 *     rampReachedAt_s      → createRampHandler  (first sample to reach threshold)
 *     rampDeadline_s       → createRampHandler  (rampStart + timeout)
 *     completedAt_s        → createDurationHandler / createIntegralHandler
 *     glitchForgivenIntervals  → createGlitchIgnoreHandler.preprocess()
 *       Each entry { tStart_s, tEnd_s } covers a run of violating samples
 *       whose total duration < max_gap_ms.  tEnd_s is the first clean sample —
 *       same convention as violations, so the recovery sample is NOT cyan.
 *
 * Colour priority (first match wins):
 *   blue  → ramp-start or ramp-success marker (±1 ms)
 *   gray  → after completedAt_s, or before/during ramp (t ≤ rampEnd)
 *   cyan  → glitch-forgiven:  tStart_s ≤ t < tEnd_s   (strict upper bound)
 *   red   → error violation:  tStart_s ≤ t < tEnd_s
 *   yellow→ warn violation:   tStart_s ≤ t < tEnd_s
 *   green → OK (default)
 */

import { describe, it, expect } from 'vitest';
import { computePointColors } from '../../dev-app/src/computePointColors.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal result object with only the fields computePointColors reads. */
function makeResult({ violations = [], hints = {} } = {}) {
  return { violations, overlayHints: hints };
}

/** pt(t) — chart point at time t seconds, current irrelevant for colouring. */
const pt = (t) => ({ x: t, y: 300 });

const GREEN  = 'rgba(76, 175, 80, 0.9)';
const RED    = 'rgba(220, 53, 69, 0.9)';
const YELLOW = 'rgba(255, 193, 7, 0.9)';
const CYAN   = 'rgba(0, 188, 212, 0.85)';
const BLUE   = 'rgba(33, 150, 243, 0.9)';
const GRAY   = 'rgba(160, 160, 160, 0.75)';

// ── OK / default ─────────────────────────────────────────────────────────────

describe('computePointColors — OK zone', () => {
  it('returns green for a plain OK sample with no hints', () => {
    const [color] = computePointColors([pt(1.0)], makeResult());
    expect(color).toBe(GREEN);
  });
});

// ── Ramp markers ─────────────────────────────────────────────────────────────

describe('computePointColors — ramp markers', () => {
  it('colors rampStart_s sample blue', () => {
    const result = makeResult({ hints: { rampStart_s: 0.2 } });
    const [color] = computePointColors([pt(0.2)], result);
    expect(color).toBe(BLUE);
  });

  it('colors rampReachedAt_s sample blue', () => {
    const result = makeResult({ hints: { rampReachedAt_s: 0.8 } });
    const [color] = computePointColors([pt(0.8)], result);
    expect(color).toBe(BLUE);
  });

  it('tolerates sub-ms rounding for ramp marker matching (same ms → same tMs)', () => {
    // Both pt.x and rampReachedAt_s are at 1-ms precision after buildLogEntry rounding.
    // A pt dragged to 0.8004 rounds to tMs=0.800 and still matches.
    const result = makeResult({ hints: { rampReachedAt_s: 0.800 } });
    const colors = computePointColors(
      [{ x: 0.800, y: 0 }, { x: 0.8004, y: 0 }, { x: 0.7995, y: 0 }],
      result
    );
    expect(colors[0]).toBe(BLUE);   // exact match
    expect(colors[1]).toBe(BLUE);   // 0.8004 → tMs=0.800, diff=0 → matches
    expect(colors[2]).toBe(BLUE);   // 0.7995 → tMs=0.800, diff=0 → matches
  });

  it('does not color a sample blue when it is clearly past both ramp markers', () => {
    // Sample at 0.9 is after rampReachedAt=0.8, so rampEnd=0.8.
    // 0.9 > 0.8, not a marker (diff=0.1 >> 0.001), and not in ramp phase → green.
    const result = makeResult({ hints: { rampStart_s: 0.2, rampReachedAt_s: 0.8 } });
    const [color] = computePointColors([pt(0.9)], result);
    expect(color).toBe(GREEN);
  });
});

// ── Gray zones ───────────────────────────────────────────────────────────────

describe('computePointColors — gray zones', () => {
  it('grays samples at or before rampDeadline_s', () => {
    const result = makeResult({ hints: { rampDeadline_s: 1.0 } });
    const colors = computePointColors([pt(0.5), pt(1.0)], result);
    expect(colors[0]).toBe(GRAY);
    expect(colors[1]).toBe(GRAY);
  });

  it('does not gray sample just after rampDeadline_s', () => {
    const result = makeResult({ hints: { rampDeadline_s: 1.0 } });
    const [color] = computePointColors([pt(1.001)], result);
    expect(color).toBe(GREEN);
  });

  it('prefers rampReachedAt_s over rampDeadline_s for the rampEnd boundary', () => {
    // rampReachedAt_s = 0.7, rampDeadline_s = 1.0
    // sample at 0.9 is between them → should be gray (before rampEnd = 0.7? No — 0.9 > 0.7)
    const result = makeResult({ hints: { rampReachedAt_s: 0.7, rampDeadline_s: 1.0 } });
    const colors = computePointColors([pt(0.5), pt(0.7), pt(0.9)], result);
    expect(colors[0]).toBe(GRAY);   // 0.5 ≤ 0.7 → gray
    expect(colors[1]).toBe(BLUE);   // exact rampReachedAt_s → blue (higher priority)
    expect(colors[2]).toBe(GREEN);  // 0.9 > 0.7 (= rampEnd) → no longer in ramp
  });

  it('grays samples at or after completedAt_s', () => {
    const result = makeResult({ hints: { completedAt_s: 3.0 } });
    const colors = computePointColors([pt(2.999), pt(3.0), pt(3.5)], result);
    expect(colors[0]).toBe(GREEN);
    expect(colors[1]).toBe(GRAY);
    expect(colors[2]).toBe(GRAY);
  });
});

// ── Violation colours ─────────────────────────────────────────────────────────

describe('computePointColors — violations', () => {
  const vio = (severity, tStart_s, tEnd_s) => ({ severity, tStart_s, tEnd_s, isSummary: false });

  it('colors samples inside an error violation red', () => {
    const result = makeResult({ violations: [vio('error', 1.0, 1.5)] });
    const colors = computePointColors([pt(1.0), pt(1.2), pt(1.499)], result);
    expect(colors[0]).toBe(RED);
    expect(colors[1]).toBe(RED);
    expect(colors[2]).toBe(RED);
  });

  it('does NOT color the closing (tEnd_s) sample red — it is the first OK sample', () => {
    const result = makeResult({ violations: [vio('error', 1.0, 1.5)] });
    const [color] = computePointColors([pt(1.5)], result);
    expect(color).toBe(GREEN);
  });

  it('colors samples inside a warn violation yellow', () => {
    const result = makeResult({ violations: [vio('warn', 2.0, 2.3)] });
    const colors = computePointColors([pt(2.0), pt(2.1)], result);
    expect(colors[0]).toBe(YELLOW);
    expect(colors[1]).toBe(YELLOW);
  });

  it('does NOT color the closing (tEnd_s) warn sample yellow', () => {
    const result = makeResult({ violations: [vio('warn', 2.0, 2.3)] });
    const [color] = computePointColors([pt(2.3)], result);
    expect(color).toBe(GREEN);
  });

  it('ignores summary violations (they have no meaningful tStart/tEnd)', () => {
    const summary = { severity: 'error', tStart_s: 0, tEnd_s: 5, isSummary: true };
    const result  = makeResult({ violations: [summary] });
    const [color] = computePointColors([pt(2.0)], result);
    expect(color).toBe(GREEN);
  });

  it('error takes priority over warn when both intervals overlap', () => {
    const result = makeResult({
      violations: [vio('warn', 1.0, 2.0), vio('error', 1.2, 1.8)]
    });
    const [color] = computePointColors([pt(1.5)], result);
    expect(color).toBe(RED);
  });
});

// ── Glitch-forgiven colour ────────────────────────────────────────────────────

describe('computePointColors — glitch-forgiven intervals', () => {
  it('colors samples inside a forgiven interval cyan', () => {
    const result = makeResult({
      hints: { glitchForgivenIntervals: [{ tStart_s: 1.0, tEnd_s: 1.1 }] }
    });
    const colors = computePointColors([pt(1.0), pt(1.05)], result);
    expect(colors[0]).toBe(CYAN);
    expect(colors[1]).toBe(CYAN);
  });

  it('does NOT color the recovery sample (tEnd_s) cyan — it is the first OK sample', () => {
    const result = makeResult({
      hints: { glitchForgivenIntervals: [{ tStart_s: 1.0, tEnd_s: 1.1 }] }
    });
    const [color] = computePointColors([pt(1.1)], result);
    expect(color).toBe(GREEN);
  });

  it('colors sample before forgiven interval green', () => {
    const result = makeResult({
      hints: { glitchForgivenIntervals: [{ tStart_s: 1.0, tEnd_s: 1.1 }] }
    });
    const [color] = computePointColors([pt(0.99)], result);
    expect(color).toBe(GREEN);
  });

  it('handles sub-ms chart x via rounding: pt.x=1.0005 rounds to tMs=1.001, interval [1.001, 1.100)', () => {
    // buildLogEntry does Math.round(x * 1000) / 1000, so 1.0005 → 1.001
    const result = makeResult({
      hints: { glitchForgivenIntervals: [{ tStart_s: 1.001, tEnd_s: 1.100 }] }
    });
    const [color] = computePointColors([{ x: 1.0005, y: 50 }], result);
    expect(color).toBe(CYAN);  // without rounding this would be GREEN (0.9005 < 1.001 fails)
  });

  it('cyan takes priority over violation coloring (forgiven dip is not also red)', () => {
    // A forgiven glitch might coincide with a short violation interval — cyan wins.
    const result = makeResult({
      violations: [{ severity: 'error', tStart_s: 1.0, tEnd_s: 1.1, isSummary: false }],
      hints:      { glitchForgivenIntervals: [{ tStart_s: 1.0, tEnd_s: 1.1 }] }
    });
    const [color] = computePointColors([pt(1.05)], result);
    expect(color).toBe(CYAN);
  });
});

// ── Combined scenario ─────────────────────────────────────────────────────────

describe('computePointColors — full waveform scenario', () => {
  it('assigns correct colors across a complete stunning waveform', () => {
    //   t=0.0  gray  (before ramp start — rampEnd = rampReachedAt = 0.8)
    //   t=0.2  blue  (ramp start marker)
    //   t=0.5  gray  (during ramp)
    //   t=0.8  blue  (ramp success)
    //   t=1.0  green (OK after ramp)
    //   t=1.5  red   (error violation [1.5, 1.8))
    //   t=1.7  red
    //   t=1.8  green (recovery — first OK, tEnd_s of violation)
    //   t=2.0  cyan  (glitch forgiven [2.0, 2.1))
    //   t=2.1  green (recovery — tEnd_s of forgiven interval)
    //   t=3.0  gray  (after completedAt_s = 3.0)

    const samples = [0.0, 0.2, 0.5, 0.8, 1.0, 1.5, 1.7, 1.8, 2.0, 2.1, 3.0].map(pt);

    const result = makeResult({
      violations: [{ severity: 'error', tStart_s: 1.5, tEnd_s: 1.8, isSummary: false }],
      hints: {
        rampStart_s:            0.2,
        rampReachedAt_s:        0.8,
        completedAt_s:          3.0,
        glitchForgivenIntervals: [{ tStart_s: 2.0, tEnd_s: 2.1 }],
      }
    });

    const colors = computePointColors(samples, result);
    expect(colors[0],  't=0.0').toBe(GRAY);
    expect(colors[1],  't=0.2').toBe(BLUE);
    expect(colors[2],  't=0.5').toBe(GRAY);
    expect(colors[3],  't=0.8').toBe(BLUE);
    expect(colors[4],  't=1.0').toBe(GREEN);
    expect(colors[5],  't=1.5').toBe(RED);
    expect(colors[6],  't=1.7').toBe(RED);
    expect(colors[7],  't=1.8').toBe(GREEN);  // tEnd_s of violation → first OK
    expect(colors[8],  't=2.0').toBe(CYAN);
    expect(colors[9],  't=2.1').toBe(GREEN);  // tEnd_s of forgiven → first OK
    expect(colors[10], 't=3.0').toBe(GRAY);
  });
});

/**
 * EvaluationOverlayPlugin — Chart.js plugin that draws:
 *   - Horizontal dashed lines for threshold A (red) and B (orange)
 *   - Colored semi-transparent bands for non-summary violation intervals
 *   - Small triangular markers at violation interval boundaries
 *   - A clickable summary badge (OK / WARN / FAIL) in the top-right corner
 *
 * Data is injected per chart via setEvaluationData(chartId, data).
 * A badge-click callback is registered via onBadgeClick(chartId, callback).
 */

const evaluationDataByChartId = {};
const badgeHitBoxByChartId = {};
const badgeClickCallbacks = {};

const COLORS = {
  lineA: 'rgba(220, 53, 69, 0.85)',
  lineB: 'rgba(255, 152, 0, 0.85)',
  lineARef: 'rgba(220, 53, 69, 0.35)',
  lineBRef: 'rgba(255, 152, 0, 0.35)',
  bandError: 'rgba(220, 53, 69, 0.22)',
  bandWarn: 'rgba(255, 193, 7, 0.25)',
  bandCompletion: 'rgba(160, 160, 160, 0.18)',
  markerError: 'rgba(220, 53, 69, 0.9)',
  markerWarn: 'rgba(255, 152, 0, 0.9)',
  markerCompletion: 'rgba(160, 160, 160, 0.75)',
  rampLine: 'rgba(33, 150, 243, 0.7)',
  rampBand: 'rgba(33, 150, 243, 0.06)',
  rampReached: 'rgba(76, 175, 80, 0.7)',
  integralCutoff: 'rgba(156, 39, 176, 0.7)',
  integralBand: 'rgba(33, 150, 243, 0.10)',
  integralLine: 'rgba(156, 39, 176, 0.85)',
  integralAxis: 'rgba(156, 39, 176, 0.55)',
  durationLine: 'rgba(0, 188, 212, 0.85)',
  durationAxis: 'rgba(0, 188, 212, 0.55)',
  completionLine: 'rgba(76, 175, 80, 0.8)',
  completionBand: 'rgba(76, 175, 80, 0.08)',
  badgeOk: 'rgba(76, 175, 80, 0.9)',
  badgeWarn: 'rgba(255, 152, 0, 0.9)',
  badgeFail: 'rgba(220, 53, 69, 0.9)'
};

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function drawDashedLine(ctx, y, left, right, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  ctx.restore();
}

function drawLabel(ctx, text, x, y, color) {
  ctx.save();
  ctx.font = '10px sans-serif';
  ctx.fillStyle = color;
  ctx.textBaseline = 'bottom';
  ctx.fillText(text, x + 4, y - 2);
  ctx.restore();
}

function drawVerticalDashedLine(ctx, tVal, chartArea, xScale, color, label) {
  const x = xScale.getPixelForValue(tVal);
  if (x < chartArea.left || x > chartArea.right) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.beginPath();
  ctx.moveTo(x, chartArea.top);
  ctx.lineTo(x, chartArea.bottom);
  ctx.stroke();
  ctx.restore();

  if (label) {
    ctx.save();
    ctx.font = '10px sans-serif';
    ctx.fillStyle = color;
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x + 3, chartArea.bottom - 3);
    ctx.restore();
  }
}

function drawBand(ctx, tStart, tEnd, chartArea, xScale, color) {
  const x1 = Math.max(xScale.getPixelForValue(tStart), chartArea.left);
  const x2 = Math.min(xScale.getPixelForValue(tEnd), chartArea.right);
  if (x2 - x1 < 1) return;

  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);

  // Left/right edge lines for emphasis
  ctx.strokeStyle = color.replace(/[\d.]+\)$/, '0.6)');
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x1, chartArea.top);
  ctx.lineTo(x1, chartArea.bottom);
  ctx.moveTo(x2, chartArea.top);
  ctx.lineTo(x2, chartArea.bottom);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw a small downward-pointing triangle at the top of the chart area
 * to mark a violation boundary time.
 */
function drawMarker(ctx, tVal, chartArea, xScale, color) {
  const x = xScale.getPixelForValue(tVal);
  if (x < chartArea.left || x > chartArea.right) return;

  const sz = 5;
  const y = chartArea.top;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - sz, y);
  ctx.lineTo(x + sz, y);
  ctx.lineTo(x, y + sz * 1.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBadge(ctx, text, chartArea, bgColor) {
  ctx.save();
  ctx.font = 'bold 11px sans-serif';
  const metrics = ctx.measureText(text);
  const pad = 6;
  const w = metrics.width + pad * 2;
  const h = 20;
  const x = chartArea.right - w - 6;
  const y = chartArea.top + 6;

  ctx.fillStyle = bgColor;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, 4);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fill();

  // Pointer cursor hint: subtle border
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + pad, y + h / 2);
  ctx.restore();

  return { x, y, w, h };
}

// ---------------------------------------------------------------------------
// Human-readable message table (German)
// ---------------------------------------------------------------------------

const MESSAGE_TEXT = {
  ramp_not_reached: (d) =>
    `Anstieg nicht erreicht: max ${d.reached_mA} mA in ${d.window_s}s (Soll ≥ ${d.required_mA} mA)`,
  never_reached_A: (d) =>
    `Strom hat Schwelle A (${d.required_mA} mA) nie erreicht`,
  below_A: (d) =>
    `Strom unter Schwelle A (${d.threshold_mA} mA)`,
  below_B: (d) =>
    `Strom unter Sollwert B (${d.threshold_mA} mA)`,
  duration_not_reached: (d) =>
    `Betäubungszeit nicht erreicht: ${d.actual_s}s von ${d.required_s}s (Schwelle ${d.threshold_mA} mA)`,
  below_threshold_gap: (d) =>
    `Strom unter Schwelle (${d.threshold_mA} mA)`,
  integral_not_reached: (d) =>
    `Strom-Zeit-Integral nicht erreicht: ${d.actual_mAs} mA·s von ${d.target_mAs} mA·s`,
  below_cutoff_zone: (d) =>
    `Strom unter Integrations-Schwelle (${d.cutoff_mA} mA)`
};

function formatViolation(v) {
  const formatter = MESSAGE_TEXT[v.messageKey];
  const text = formatter ? formatter(v.details || {}) : v.messageKey;
  const timeRange = v.isSummary
    ? ''
    : ` [${v.tStart_s.toFixed(2)}s – ${v.tEnd_s.toFixed(2)}s]`;
  const severity = v.severity === 'error' ? 'FEHLER' : 'WARNUNG';
  return `${severity}${timeRange}: ${text}`;
}

// ---------------------------------------------------------------------------
// Threshold label helpers
// ---------------------------------------------------------------------------

function friendlyThresholdName(bindingName) {
  switch (bindingName) {
    case 'nominal_mA':           return 'Nominal';
    case 'setpoint_mA':          return 'Setpoint';
    case 'min_nominal_setpoint': return 'Min(N,S)';
    default: return bindingName ?? '';
  }
}

// ---------------------------------------------------------------------------
// Integral progress line + right-side % axis
// ---------------------------------------------------------------------------

function drawIntegralProgress(ctx, series, chartArea, xScale, thresholdPct = 100) {
  if (!series || series.length === 0) return;

  const chartH = chartArea.bottom - chartArea.top;
  const axisX = chartArea.right + 1;
  const tickLen = 4;
  const pctToY = pct => chartArea.bottom - (pct / 100) * chartH;

  // Right axis line + ticks + labels
  ctx.save();
  ctx.strokeStyle = COLORS.integralAxis;
  ctx.fillStyle = COLORS.integralAxis;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  ctx.beginPath();
  ctx.moveTo(axisX, chartArea.top);
  ctx.lineTo(axisX, chartArea.bottom);
  ctx.stroke();

  for (const pct of [0, 25, 50, 75, 100]) {
    const y = pctToY(pct);
    ctx.beginPath();
    ctx.moveTo(axisX, y);
    ctx.lineTo(axisX + tickLen, y);
    ctx.stroke();
    ctx.fillText(`${pct}%`, axisX + tickLen + 2, y);
  }

  // Threshold tick (when not 100%)
  if (thresholdPct !== 100) {
    const yTh = pctToY(thresholdPct);
    ctx.strokeStyle = 'rgba(160,160,160,0.85)';
    ctx.fillStyle   = 'rgba(160,160,160,0.85)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, yTh);
    ctx.lineTo(chartArea.right, yTh);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(`${thresholdPct}%✓`, axisX + tickLen + 2, yTh);
  }
  ctx.restore();

  // Progress line (clipped to chart area)
  ctx.save();
  ctx.beginPath();
  ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
  ctx.clip();

  ctx.strokeStyle = COLORS.integralLine;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  let started = false;
  for (const pt of series) {
    const x = xScale.getPixelForValue(pt.t);
    const y = pctToY(pt.pct);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawDurationProgress(ctx, series, chartArea, xScale, thresholdPct = 100) {
  if (!series || series.length === 0) return;

  const chartH = chartArea.bottom - chartArea.top;
  const axisX  = chartArea.right + 1;
  const tickLen = 4;
  const pctToY  = pct => chartArea.bottom - (pct / 100) * chartH;

  // Right axis line + ticks + labels
  ctx.save();
  ctx.strokeStyle = COLORS.durationAxis;
  ctx.fillStyle   = COLORS.durationAxis;
  ctx.lineWidth   = 1;
  ctx.setLineDash([]);
  ctx.font         = '9px sans-serif';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';

  ctx.beginPath();
  ctx.moveTo(axisX, chartArea.top);
  ctx.lineTo(axisX, chartArea.bottom);
  ctx.stroke();

  for (const pct of [0, 25, 50, 75, 100]) {
    const y = pctToY(pct);
    ctx.beginPath();
    ctx.moveTo(axisX, y);
    ctx.lineTo(axisX + tickLen, y);
    ctx.stroke();
    ctx.fillText(`${pct}%`, axisX + tickLen + 2, y);
  }

  // Threshold tick (when not 100%)
  if (thresholdPct !== 100) {
    const yTh = pctToY(thresholdPct);
    ctx.strokeStyle = 'rgba(160,160,160,0.85)';
    ctx.fillStyle   = 'rgba(160,160,160,0.85)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, yTh);
    ctx.lineTo(chartArea.right, yTh);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(`${thresholdPct}%✓`, axisX + tickLen + 2, yTh);
  }
  ctx.restore();

  // Progress line (clipped to chart area)
  ctx.save();
  ctx.beginPath();
  ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
  ctx.clip();

  ctx.strokeStyle = COLORS.durationLine;
  ctx.lineWidth   = 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  let started = false;
  for (const pt of series) {
    const x = xScale.getPixelForValue(pt.t);
    const y = pctToY(pt.pct);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const evaluationOverlayPlugin = {
  id: 'evaluationOverlay',

  afterDatasetsDraw(chart) {
    const chartId = chart.canvas?.id;
    const evalData = evaluationDataByChartId[chartId];
    if (!evalData) {
      delete badgeHitBoxByChartId[chartId];
      return;
    }

    const { thresholds, violations, ok, hasWarn, meta, overlayHints } = evalData;
    const ctx = chart.ctx;
    const chartArea = chart.chartArea;
    const yScale = chart.scales.y;
    const xScale = chart.scales.x;
    if (!chartArea || !yScale || !xScale) return;

    const hints = overlayHints || {};

    // 0. Integral band: horizontal blue area spanning full width (like range-areas)
    //    from integralCutoff_mA to A — drawn BEFORE datasets so it's behind the line
    if (hints.integralCutoff_mA != null && thresholds?.A > 0) {
      const yCutPx = yScale.getPixelForValue(hints.integralCutoff_mA);
      const yAPx = yScale.getPixelForValue(thresholds.A);
      const top = Math.max(Math.min(yAPx, yCutPx), chartArea.top);
      const bottom = Math.min(Math.max(yAPx, yCutPx), chartArea.bottom);
      if (bottom > top) {
        ctx.save();
        ctx.fillStyle = COLORS.integralBand;
        ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, bottom - top);
        ctx.restore();
      }
    }

    // 1. Ramp phase visualization
    //    - Subtle band from rampStart to rampDeadline
    //    - Vertical line at rampStart (current > 10 mA detected)
    //    - Vertical line at rampDeadline (timeout)
    //    - Vertical line at rampReachedAt (threshold reached — green)
    if (hints.rampStart_s != null && hints.rampDeadline_s != null) {
      const xStart = xScale.getPixelForValue(hints.rampStart_s);
      const xDeadline = xScale.getPixelForValue(hints.rampDeadline_s);

      // Ramp band
      const bandLeft = Math.max(xStart, chartArea.left);
      const bandRight = Math.min(xDeadline, chartArea.right);
      if (bandRight > bandLeft) {
        ctx.save();
        ctx.fillStyle = COLORS.rampBand;
        ctx.fillRect(bandLeft, chartArea.top, bandRight - bandLeft, chartArea.bottom - chartArea.top);
        ctx.restore();
      }

      drawVerticalDashedLine(ctx, hints.rampStart_s, chartArea, xScale,
        COLORS.rampLine, 'Start');
      drawVerticalDashedLine(ctx, hints.rampDeadline_s, chartArea, xScale,
        COLORS.rampLine, `Timeout ${(hints.rampDeadline_s - hints.rampStart_s).toFixed(1)}s`);

      if (hints.rampReachedAt_s != null) {
        drawVerticalDashedLine(ctx, hints.rampReachedAt_s, chartArea, xScale,
          COLORS.rampReached, `Ramp ✓`);
      }
    }

    // 2. Progress lines + right % axis
    if (hints.integralSeries?.length > 0) {
      drawIntegralProgress(ctx, hints.integralSeries, chartArea, xScale, hints.integralThresholdPct ?? 100);
    }
    if (hints.durationSeries?.length > 0) {
      drawDurationProgress(ctx, hints.durationSeries, chartArea, xScale, hints.durationThresholdPct ?? 100);
    }

    // 3. Violation bands + markers (skip isSummary)
    for (const v of (violations || [])) {
      if (v.isSummary) continue;

      const isCompletion = v.stepType === 'completion';
      const color       = isCompletion ? COLORS.bandCompletion
                        : v.severity === 'error' ? COLORS.bandError : COLORS.bandWarn;
      const markerColor = isCompletion ? COLORS.markerCompletion
                        : v.severity === 'error' ? COLORS.markerError : COLORS.markerWarn;
      drawBand(ctx, v.tStart_s, v.tEnd_s, chartArea, xScale, color);
      drawMarker(ctx, v.tStart_s, chartArea, xScale, markerColor);
      drawMarker(ctx, v.tEnd_s, chartArea, xScale, markerColor);
    }

    // 3. Completion — green band from completedAt to end + vertical marker (same style as Ramp ✓)
    if (hints.completedAt_s != null) {
      const xC = xScale.getPixelForValue(hints.completedAt_s);
      if (xC >= chartArea.left && xC <= chartArea.right) {
        ctx.save();
        ctx.fillStyle = COLORS.completionBand;
        ctx.fillRect(xC, chartArea.top, chartArea.right - xC, chartArea.bottom - chartArea.top);
        ctx.restore();
      }
      drawVerticalDashedLine(ctx, hints.completedAt_s, chartArea, xScale,
        COLORS.completionLine, '✓ Ziel');
    }

    // 4. Threshold lines
    if (thresholds) {
      const { A, B } = thresholds;
      const effFail = hints.effectiveFailBelow_mA;
      const effWarn = hints.effectiveWarnBelow_mA;
      const failDiffers = effFail != null && Math.abs(effFail - A) > 0.5;
      const warnDiffers = effWarn != null && Math.abs(effWarn - B) > 0.5;

      const aName = friendlyThresholdName(hints.failBelowName) || 'A';
      const bName = friendlyThresholdName(hints.warnBelowName) || 'B';
      const aPct  = hints.failBelowPercent;
      const bPct  = hints.warnBelowPercent;

      // Raw A — always draw as reference (lighter if effective differs)
      if (A > 0) {
        const yA = yScale.getPixelForValue(A);
        if (yA >= chartArea.top && yA <= chartArea.bottom) {
          const color = failDiffers ? COLORS.lineARef : COLORS.lineA;
          drawDashedLine(ctx, yA, chartArea.left, chartArea.right, color);
          drawLabel(ctx, `${aName} = ${A} mA`, chartArea.left, yA, color);
        }
      }

      // Raw B — always draw as reference (lighter if effective differs)
      if (B > 0 && B !== A) {
        const yB = yScale.getPixelForValue(B);
        if (yB >= chartArea.top && yB <= chartArea.bottom) {
          const color = warnDiffers ? COLORS.lineBRef : COLORS.lineB;
          drawDashedLine(ctx, yB, chartArea.left, chartArea.right, color);
          drawLabel(ctx, `${bName} = ${B} mA`, chartArea.left, yB, color);
        }
      }

      // Effective fail threshold — shown when percent is set and not 100
      if (effFail != null && aPct != null && aPct !== 100) {
        const yEF = yScale.getPixelForValue(effFail);
        if (yEF >= chartArea.top && yEF <= chartArea.bottom) {
          drawDashedLine(ctx, yEF, chartArea.left, chartArea.right, COLORS.lineA);
          drawLabel(ctx, `${aName} × ${aPct}% = ${Math.round(effFail)} mA`, chartArea.left, yEF, COLORS.lineA);
        }
      }

      // Effective warn threshold — shown when percent is set and not 100
      if (effWarn != null && bPct != null && bPct !== 100) {
        const yEW = yScale.getPixelForValue(effWarn);
        if (yEW >= chartArea.top && yEW <= chartArea.bottom) {
          drawDashedLine(ctx, yEW, chartArea.left, chartArea.right, COLORS.lineB);
          drawLabel(ctx, `${bName} × ${bPct}% = ${Math.round(effWarn)} mA`, chartArea.left, yEW, COLORS.lineB);
        }
      }

      // Integral cutoff line (purple dashed) at the lower edge of the integral band
      if (hints.integralCutoff_mA != null) {
        const yCut = yScale.getPixelForValue(hints.integralCutoff_mA);
        if (yCut >= chartArea.top && yCut <= chartArea.bottom) {
          drawDashedLine(ctx, yCut, chartArea.left, chartArea.right, COLORS.integralCutoff);
          drawLabel(ctx, `∫ Cutoff ${Math.round(hints.integralCutoff_mA)} mA`, chartArea.left, yCut, COLORS.integralCutoff);
        }
      }
    }

    // 3. Summary badge (clickable)
    let badgeText, badgeColor;
    if (ok && !hasWarn) {
      badgeText = 'OK'; badgeColor = COLORS.badgeOk;
    } else if (ok && hasWarn) {
      badgeText = 'WARN'; badgeColor = COLORS.badgeWarn;
    } else {
      badgeText = 'FAIL'; badgeColor = COLORS.badgeFail;
    }

    const hitBox = drawBadge(ctx, badgeText, chartArea, badgeColor);
    badgeHitBoxByChartId[chartId] = hitBox;
  },

  afterEvent(chart, args) {
    const chartId = chart.canvas?.id;
    const hitBox = badgeHitBoxByChartId[chartId];
    if (!hitBox) return;

    const { x: mx, y: my } = args.event;
    const isOver = mx >= hitBox.x && mx <= hitBox.x + hitBox.w &&
                   my >= hitBox.y && my <= hitBox.y + hitBox.h;

    if (args.event.type === 'mousemove') {
      chart.canvas.style.cursor = isOver ? 'pointer' : '';
    }

    if (args.event.type === 'click' && isOver) {
      const cb = badgeClickCallbacks[chartId];
      const evalData = evaluationDataByChartId[chartId];
      if (cb && evalData) {
        cb(evalData);
      }
    }
  },

  // --- Public API ---

  setEvaluationData(chartId, data) {
    if (data) {
      evaluationDataByChartId[chartId] = data;
    } else {
      delete evaluationDataByChartId[chartId];
      delete badgeHitBoxByChartId[chartId];
    }
  },

  /** Last drawn OK/WARN/FAIL badge rect in canvas/CSS pixel space (chart top-left origin), or null. */
  getBadgeHitBox(chartId) {
    return badgeHitBoxByChartId[chartId] ?? null;
  },

  onBadgeClick(chartId, callback) {
    if (callback) {
      badgeClickCallbacks[chartId] = callback;
    } else {
      delete badgeClickCallbacks[chartId];
    }
  },

  clearAll() {
    for (const key of Object.keys(evaluationDataByChartId)) {
      delete evaluationDataByChartId[key];
    }
    for (const key of Object.keys(badgeHitBoxByChartId)) {
      delete badgeHitBoxByChartId[key];
    }
  },

  formatViolation
};

export default evaluationOverlayPlugin;

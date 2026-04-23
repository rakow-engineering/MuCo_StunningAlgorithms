/**
 * sampleEditorPlugin — Chart.js plugin for interactive sample editing.
 *
 * Uses Pointer Events + setPointerCapture so drag works on touch and pen.
 *
 * Interactions:
 *   Primary tap/click on empty chart  →  add sample
 *   Primary drag on point              →  move (x = time, y = current)
 *   Primary tap on point               →  select (toggle)
 *   Tap red × circle (NW of selected point) →  delete that sample
 *   Right-click on point               →  delete (desktop)
 *
 * onChanged(samples) after every edit; samples sorted by x.
 * options.onSelectionChange(index | null) when the selected point changes.
 */

const SNAP_RADIUS_FINE    = 14;
const SNAP_RADIUS_COARSE  = 26;
const DRAG_THRESHOLD_FINE   = 4;
const DRAG_THRESHOLD_COARSE = 10;

/** Delete handle: circle at top-left of selected point (canvas px). */
const DELETE_HANDLE_R_FINE   = 11;
const DELETE_HANDLE_R_COARSE = 15;
const DELETE_HANDLE_EDGE_FINE   = 17;
const DELETE_HANDLE_EDGE_COARSE = 24;

function isCoarsePointer() {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

export function createSampleEditorPlugin(onChanged, options = {}) {
  const { onSelectionChange } = options;

  let chartRef         = null;
  let activePointerId  = null;
  let dragIdx          = null;
  let hoverIdx         = -1;
  let downPos          = null;
  let downIdx          = null;
  let downPointRef     = null;
  let isDragging       = false;
  /** @type {{ x: number, y: number } | null} */
  let selectedRef      = null;

  const listeners = [];

  function addListener(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  function snapRadius() {
    return isCoarsePointer() ? SNAP_RADIUS_COARSE : SNAP_RADIUS_FINE;
  }

  function dragThreshold() {
    return isCoarsePointer() ? DRAG_THRESHOLD_COARSE : DRAG_THRESHOLD_FINE;
  }

  function canvasPos(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function inChartArea(chart, cx, cy) {
    const { left, right, top, bottom } = chart.chartArea;
    return cx >= left && cx <= right && cy >= top && cy <= bottom;
  }

  function nearestIdx(chart, cx, cy) {
    const data   = chart.data.datasets[0].data;
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    const R      = snapRadius();
    let best = -1;
    let best_d = R;
    for (let i = 0; i < data.length; i++) {
      const px = xScale.getPixelForValue(data[i].x);
      const py = yScale.getPixelForValue(data[i].y);
      const d  = Math.hypot(cx - px, cy - py);
      if (d < best_d) { best_d = d; best = i; }
    }
    return best;
  }

  function dataFromPixel(chart, cx, cy) {
    const { left, right, top, bottom } = chart.chartArea;
    const x = Math.max(0, chart.scales.x.getValueForPixel(Math.max(left, Math.min(right, cx))));
    const y = Math.max(0, chart.scales.y.getValueForPixel(Math.max(top,  Math.min(bottom, cy))));
    return { x, y };
  }

  function sortedCopy(data) {
    return [...data].sort((a, b) => a.x - b.x);
  }

  function selectedIndex() {
    if (!chartRef || !selectedRef) return -1;
    return chartRef.data.datasets[0].data.indexOf(selectedRef);
  }

  function emitSelection() {
    const i = selectedIndex();
    onSelectionChange?.(i >= 0 ? i : null);
  }

  function applyPointRadii() {
    if (!chartRef) return;
    const coarse = isCoarsePointer();
    const ds     = chartRef.data.datasets[0];
    ds.pointRadius      = coarse ? 9 : 5;
    ds.pointHoverRadius = coarse ? 13 : 7;
  }

  function activeDrawIdx(chart) {
    const data = chart.data.datasets[0].data;
    if (isDragging && dragIdx !== null && dragIdx >= 0 && dragIdx < data.length) return dragIdx;
    if (hoverIdx >= 0) return hoverIdx;
    const si = selectedIndex();
    return si;
  }

  /** Geometry of the red × delete control for the current selection (or null). */
  function deleteHandleGeom(chart) {
    const si = selectedIndex();
    if (si < 0 || !selectedRef) return null;
    const data = chart.data.datasets[0].data;
    if (si >= data.length) return null;
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    const px = xScale.getPixelForValue(data[si].x);
    const py = yScale.getPixelForValue(data[si].y);
    const coarse = isCoarsePointer();
    const r    = coarse ? DELETE_HANDLE_R_COARSE : DELETE_HANDLE_R_FINE;
    const edge = coarse ? DELETE_HANDLE_EDGE_COARSE : DELETE_HANDLE_EDGE_FINE;
    const { left, right, top, bottom } = chart.chartArea;
    let cx = px - edge;
    let cy = py - edge;
    cx = Math.max(left + r + 1, Math.min(right - r - 1, cx));
    cy = Math.max(top + r + 1, Math.min(bottom - r - 1, cy));
    const hitExtra = coarse ? 8 : 4;
    return { cx, cy, r, hitExtra };
  }

  function hitDeleteHandle(chart, x, y) {
    const g = deleteHandleGeom(chart);
    if (!g) return false;
    return Math.hypot(x - g.cx, y - g.cy) <= g.r + g.hitExtra;
  }

  function drawDeleteHandle(chart) {
    const g = deleteHandleGeom(chart);
    if (!g) return;
    const ctx = chart.ctx;
    const { cx, cy, r } = g;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(211, 47, 47, 0.96)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth   = 1;
    ctx.fill();
    ctx.stroke();
    const inset = r * 0.42;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - inset, cy - inset);
    ctx.lineTo(cx + inset, cy + inset);
    ctx.moveTo(cx + inset, cy - inset);
    ctx.lineTo(cx - inset, cy + inset);
    ctx.stroke();
    ctx.restore();
  }

  function deleteSelectedSample() {
    if (!chartRef) return;
    const idx = selectedIndex();
    if (idx < 0) return;
    const data = chartRef.data.datasets[0].data;
    data.splice(idx, 1);
    selectedRef = null;
    hoverIdx = -1;
    chartRef.update('none');
    onChanged([...data]);
    emitSelection();
  }

  function clearSelection() {
    if (selectedRef === null) return;
    selectedRef = null;
    emitSelection();
    chartRef?.update('none');
  }

  const plugin = {
    id: 'sampleEditor',

    afterInit(chart) {
      chartRef = chart;
      const canvas = chart.canvas;
      canvas.classList.add('chart-sample-editor');

      applyPointRadii();
      const mq = window.matchMedia('(pointer: coarse)');
      const onMq = () => {
        applyPointRadii();
        chart.update('none');
      };
      addListener(mq, 'change', onMq);

      addListener(canvas, 'pointerdown', (e) => {
        if (e.button !== 0) return;
        if (activePointerId !== null) return;

        const pos = canvasPos(canvas, e);
        if (hitDeleteHandle(chart, pos.x, pos.y)) {
          deleteSelectedSample();
          e.preventDefault();
          return;
        }

        if (!inChartArea(chart, pos.x, pos.y)) return;

        activePointerId = e.pointerId;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch (_) { /* already captured or unsupported */ }

        downPos      = pos;
        downIdx      = nearestIdx(chart, pos.x, pos.y);
        const data   = chart.data.datasets[0].data;
        downPointRef = downIdx >= 0 ? data[downIdx] : null;
        dragIdx      = downIdx;
        isDragging   = false;
      });

      addListener(canvas, 'pointermove', (e) => {
        const pos  = canvasPos(canvas, e);
        const data = chart.data.datasets[0].data;
        const th   = dragThreshold();

        if (activePointerId !== null && e.pointerId !== activePointerId) return;

        const newHover = inChartArea(chart, pos.x, pos.y)
          ? nearestIdx(chart, pos.x, pos.y)
          : -1;
        if (newHover !== hoverIdx) {
          hoverIdx = newHover;
          chart.update('none');
        }

        if (hitDeleteHandle(chart, pos.x, pos.y)) {
          canvas.style.cursor = 'pointer';
        } else if (inChartArea(chart, pos.x, pos.y)) {
          canvas.style.cursor = (hoverIdx >= 0)
            ? (isDragging ? 'grabbing' : 'grab')
            : 'crosshair';
        } else {
          canvas.style.cursor = '';
        }

        if (activePointerId === null) return;

        if (dragIdx !== null && dragIdx >= 0 && downPos) {
          const dx = Math.abs(pos.x - downPos.x);
          const dy = Math.abs(pos.y - downPos.y);
          if (dx > th || dy > th) isDragging = true;
          if (isDragging) {
            canvas.style.cursor = 'grabbing';
            const pt = dataFromPixel(chart, pos.x, pos.y);
            data[dragIdx].x = pt.x;
            data[dragIdx].y = pt.y;
            chart.update('none');
            onChanged(sortedCopy(data));
          }
        }
      });

      const endPointer = (e) => {
        if (e.pointerId !== activePointerId) return;

        const hadDown = !!downPos;
        const pos     = canvasPos(canvas, e);
        const data    = chart.data.datasets[0].data;
        const th      = dragThreshold();
        const pid     = e.pointerId;

        if (hadDown) {
          if (isDragging && dragIdx !== null && dragIdx >= 0) {
            data.sort((a, b) => a.x - b.x);
            if (downPointRef) selectedRef = downPointRef;
            chart.update('none');
            onChanged([...data]);
            emitSelection();
          } else {
            const dx = Math.abs(pos.x - downPos.x);
            const dy = Math.abs(pos.y - downPos.y);
            if (dx <= th && dy <= th) {
              if (downIdx >= 0 && downPointRef) {
                if (selectedRef === downPointRef) selectedRef = null;
                else selectedRef = downPointRef;
                emitSelection();
                chart.update('none');
              } else if (downIdx < 0 && inChartArea(chart, pos.x, pos.y)) {
                selectedRef = null;
                emitSelection();
                const pt = dataFromPixel(chart, pos.x, pos.y);
                data.push(pt);
                data.sort((a, b) => a.x - b.x);
                chart.update('none');
                onChanged([...data]);
              }
            }
          }
        }

        dragIdx         = null;
        downPos         = null;
        downIdx         = null;
        downPointRef    = null;
        isDragging      = false;
        activePointerId = null;

        if (canvas.hasPointerCapture(pid)) {
          try { canvas.releasePointerCapture(pid); } catch (_) {}
        }
      };

      addListener(canvas, 'pointerup', endPointer);
      addListener(canvas, 'pointercancel', endPointer);

      addListener(canvas, 'lostpointercapture', () => {
        if (!chartRef) return;
        if (isDragging && dragIdx !== null && dragIdx >= 0) {
          chartRef.data.datasets[0].data.sort((a, b) => a.x - b.x);
          chartRef.update('none');
          onChanged([...chartRef.data.datasets[0].data]);
        }
        hoverIdx         = -1;
        canvas.style.cursor = '';
        dragIdx          = null;
        downPos          = null;
        downIdx          = null;
        downPointRef     = null;
        isDragging       = false;
        activePointerId  = null;
      });

      addListener(canvas, 'contextmenu', (e) => {
        e.preventDefault();
        const pos = canvasPos(canvas, e);
        const idx = nearestIdx(chart, pos.x, pos.y);
        if (idx >= 0) {
          const removed = chart.data.datasets[0].data[idx];
          chart.data.datasets[0].data.splice(idx, 1);
          if (selectedRef === removed) selectedRef = null;
          hoverIdx = -1;
          chart.update('none');
          onChanged([...chart.data.datasets[0].data]);
          emitSelection();
        }
      });

      addListener(canvas, 'pointerleave', () => {
        if (activePointerId !== null) return;
        if (hoverIdx !== -1) {
          hoverIdx = -1;
          chart.update('none');
        }
        canvas.style.cursor = '';
      });
    },

    afterDatasetsDraw(chart) {
      const idx = activeDrawIdx(chart);
      if (idx < 0) return;

      const ctx    = chart.ctx;
      const data   = chart.data.datasets[0].data;
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;

      if (idx >= data.length) return;

      const px = xScale.getPixelForValue(data[idx].x);
      const py = yScale.getPixelForValue(data[idx].y);
      const selOnly = !isDragging && hoverIdx < 0 && selectedIndex() === idx;

      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.strokeStyle = isDragging
        ? 'rgba(33,150,243,0.9)'
        : (selOnly ? 'rgba(255,193,7,0.95)' : 'rgba(33,150,243,0.6)');
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    },

    /** Draw delete control above overlay lines so it stays visible. */
    afterDraw(chart) {
      drawDeleteHandle(chart);
    },

    afterDestroy() {
      for (const [target, type, fn, opts] of listeners) {
        target.removeEventListener(type, fn, opts);
      }
      listeners.length = 0;
      chartRef = null;
    }
  };

  return {
    plugin: plugin,
    deleteSelectedSample,
    clearSelection
  };
}

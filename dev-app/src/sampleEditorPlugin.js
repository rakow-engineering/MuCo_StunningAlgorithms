/**
 * sampleEditorPlugin — Chart.js plugin for interactive sample editing.
 *
 * Interactions:
 *   Left-click on empty area  →  add a new sample point
 *   Left-drag on existing pt  →  move the point (x = time, y = current)
 *   Right-click on point      →  delete the point
 *
 * The plugin calls onChanged(samples) after every edit where
 * samples = [{x, y}, ...] sorted by x (time).
 */

const SNAP_RADIUS    = 14;   // px — how close the cursor must be to "hit" a point
const DRAG_THRESHOLD =  4;   // px — movement before a click becomes a drag

export function createSampleEditorPlugin(onChanged) {
  let dragIdx      = null;   // dataset index of the point being dragged
  let hoverIdx     = -1;     // dataset index under the cursor
  let mouseDownPos = null;   // {x, y} in canvas pixels at mousedown
  let mouseDownIdx = null;   // hit-tested index at mousedown (-1 = miss)
  let isDragging   = false;

  // ---- Coordinate helpers ------------------------------------------------

  function canvasPos(canvas, event) {
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top)  * scaleY
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
    let best = -1;
    let best_d = SNAP_RADIUS;
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

  // ---- Plugin definition -------------------------------------------------

  return {
    id: 'sampleEditor',

    afterInit(chart) {
      const canvas = chart.canvas;

      // ---- mousedown: hit-test, prepare drag or click ----
      canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const pos = canvasPos(canvas, e);
        if (!inChartArea(chart, pos.x, pos.y)) return;
        mouseDownPos = pos;
        mouseDownIdx = nearestIdx(chart, pos.x, pos.y);
        dragIdx      = mouseDownIdx;
        isDragging   = false;
      });

      // ---- mousemove: drag existing point or just update hover ----
      canvas.addEventListener('mousemove', (e) => {
        const pos  = canvasPos(canvas, e);
        const data = chart.data.datasets[0].data;

        // Update hover index (for visual feedback)
        const newHover = inChartArea(chart, pos.x, pos.y)
          ? nearestIdx(chart, pos.x, pos.y)
          : -1;
        if (newHover !== hoverIdx) {
          hoverIdx = newHover;
          chart.update('none');
        }

        // Cursor shape
        if (inChartArea(chart, pos.x, pos.y)) {
          canvas.style.cursor = (hoverIdx >= 0)
            ? (isDragging ? 'grabbing' : 'grab')
            : 'crosshair';
        } else {
          canvas.style.cursor = '';
        }

        // Active drag
        if (dragIdx !== null && dragIdx >= 0 && mouseDownPos) {
          const dx = Math.abs(pos.x - mouseDownPos.x);
          const dy = Math.abs(pos.y - mouseDownPos.y);
          if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
            isDragging = true;
          }
          if (isDragging) {
            canvas.style.cursor = 'grabbing';
            const pt = dataFromPixel(chart, pos.x, pos.y);
            data[dragIdx].x = pt.x;
            data[dragIdx].y = pt.y;
            // Redraw without sorting so dragIdx stays valid during motion.
            // Pass sorted copy to evaluator so results are always correct.
            chart.update('none');
            onChanged(sortedCopy(data));
          }
        }
      });

      // ---- mouseup: finalise drag or add point on clean click ----
      canvas.addEventListener('mouseup', (e) => {
        if (!mouseDownPos) return;

        const pos  = canvasPos(canvas, e);
        const data = chart.data.datasets[0].data;

        if (isDragging && dragIdx >= 0) {
          // Sort dataset in-place after drag so line renders correctly
          data.sort((a, b) => a.x - b.x);
          chart.update('none');
          onChanged([...data]);
        } else {
          // Clean click (no significant movement)
          const dx = Math.abs(pos.x - mouseDownPos.x);
          const dy = Math.abs(pos.y - mouseDownPos.y);
          if (dx <= DRAG_THRESHOLD && dy <= DRAG_THRESHOLD && mouseDownIdx < 0) {
            if (inChartArea(chart, pos.x, pos.y)) {
              const pt = dataFromPixel(chart, pos.x, pos.y);
              data.push(pt);
              data.sort((a, b) => a.x - b.x);
              chart.update('none');
              onChanged([...data]);
            }
          }
        }

        dragIdx      = null;
        mouseDownPos = null;
        mouseDownIdx = null;
        isDragging   = false;
      });

      // ---- contextmenu (right-click): delete point ----
      canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const pos = canvasPos(canvas, e);
        const idx = nearestIdx(chart, pos.x, pos.y);
        if (idx >= 0) {
          chart.data.datasets[0].data.splice(idx, 1);
          hoverIdx = -1;
          chart.update('none');
          onChanged([...chart.data.datasets[0].data]);
        }
      });

      // ---- mouseleave: clear hover ----
      canvas.addEventListener('mouseleave', () => {
        if (hoverIdx !== -1) {
          hoverIdx = -1;
          chart.update('none');
        }
        canvas.style.cursor = '';
        // Cancel any in-progress drag
        if (isDragging && dragIdx >= 0) {
          chart.data.datasets[0].data.sort((a, b) => a.x - b.x);
          chart.update('none');
          onChanged([...chart.data.datasets[0].data]);
        }
        dragIdx = null; mouseDownPos = null; mouseDownIdx = null; isDragging = false;
      });
    },

    // ---- Draw hover / drag highlights over the dataset ----
    afterDatasetsDraw(chart) {
      if (hoverIdx < 0 && !isDragging) return;

      const ctx    = chart.ctx;
      const data   = chart.data.datasets[0].data;
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;
      const active = isDragging ? dragIdx : hoverIdx;

      if (active < 0 || active >= data.length) return;

      const px = xScale.getPixelForValue(data[active].x);
      const py = yScale.getPixelForValue(data[active].y);

      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.strokeStyle = isDragging ? 'rgba(33,150,243,0.9)' : 'rgba(33,150,243,0.6)';
      ctx.lineWidth   = 2;
      ctx.stroke();
      ctx.restore();
    }
  };
}

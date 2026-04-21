# Stunning Algorithm Steps — Reference

Each algorithm is defined as an ordered sequence of **steps**.
Every step carries:

| Property | Description |
|---|---|
| `id` | Unique name within the algorithm (used in violation reports and overlay rendering). |
| `op` | Operation type — selects the evaluation function. |
| `type` | Step category — controls execution order and parallelism. See categories below. |
| `stepType` | Set automatically on each violation at evaluation time — mirrors the step's `type`. Used by the UI to label violations by category. |

---

## Step Categories

Steps are grouped into four categories. An executor can use the `type` field to decide which steps run first, which can run in parallel, and which depend on earlier results.

| `type` | Role | Execution |
|---|---|---|
| `startup` | Initial ramp-up phase. `monitor` steps run throughout, but violation counting only begins once the setpoint is reached — or the `timeout_ms` expires, whichever comes first. | Runs first, sequentially. |
| `filter` | Pre-processing. Masks short signal glitches so they do not trigger false violations in downstream steps. | Runs after `startup`, before `monitor` and `completion`. |
| `monitor` | Continuous threshold surveillance. Classifies each sample into OK / warn / invalid zones and records violations. | Runs after filtering; can run in parallel with `completion`. |
| `completion` | End-of-process goals and safety timeouts. Determine whether the stunning has succeeded and enforce overall limits. | Runs in parallel with `monitor`; aggregated at the end. |

### Cross-step violation suppression

After all steps have run, warning violations whose time interval is fully covered by an error violation are removed. This prevents redundant double-reporting when a `completion` gap warning and a `monitor` zone error describe the same current drop. The error is the more specific and severe signal, so it takes precedence.

---

## `ramp_to_threshold` — type: `startup`

### Purpose

Verifies that the current rises from a low start level up to the configured **setpoint** (the target current) within a defined time budget. The ramp phase gives the power supply time to establish the correct current before sustained evaluation begins.

### Fields

| Field | Type | Description |
|---|---|---|
| `threshold` | binding | Reference current to reach. Usually `"setpoint_mA"`. |
| `current_threshold_percent` | integer (%) | Fraction of `threshold` that counts as "reached". `100` = exactly at threshold; `70` = 70 % of it. |
| `timeout_ms` | integer (ms) | Maximum time allowed to reach the threshold, measured from the moment current first exceeds `ramp_start_mA`. If the threshold is not reached within this window, a ramp violation is recorded. |
| `ramp_start_mA` | float (mA) | Current level that **starts the ramp timer**. The clock begins when the signal first crosses this value. `0` starts the clock immediately on the first sample. |
| `count_during_ramp` | boolean | Controls when the downstream completion step begins accumulating. See below. |

### Timeout behaviour

`timeout_ms` is the **maximum time reserved for the ramp-up**. During this window, `monitor` steps (e.g. `sustain_thresholds`) continue to run, but their violation counting does not start yet — the device is allowed to bring the current up without incurring threshold faults.

Violation counting begins as soon as the setpoint is reached, even if `timeout_ms` has not yet elapsed. The window does **not** have to run to completion.

| Ramp outcome | When monitor violations start counting |
|---|---|
| Setpoint reached before `timeout_ms` | At `timeout_ms` expiry — the full window is always protected |
| `timeout_ms` elapsed, setpoint not reached | At `timeout_ms` expiry (ramp violation also recorded) |

Note: `completion` steps (`min_duration_above`, `charge_integral`) do start accumulating from the moment the setpoint is reached, even if `timeout_ms` has not elapsed yet. Only violation reporting in `monitor` steps waits for the full window.

### `count_during_ramp`

Controls when the **downstream completion step** (`min_duration_above` or `charge_integral`) starts accumulating:

- **`false`** — accumulation starts only after the ramp succeeds (setpoint reached). Ramp time does not count toward the required stunning duration or charge.
- **`true`** — accumulation starts at the same moment as the ramp timer. Time or charge during the ramp phase already contributes to the goal. Useful for integral-based algorithms where a partial rise delivers meaningful charge.

### Example

```json
{
  "id":   "ramp",
  "op":   "ramp_to_threshold",
  "type": "startup",
  "threshold":                 "setpoint_mA",
  "current_threshold_percent": 100,
  "timeout_ms":                1000,
  "ramp_start_mA":             10,
  "count_during_ramp":         false
}
```

---

## `glitch_ignore` — type: `filter`

### Purpose

Short current dips below a reference level (e.g. caused by measurement noise or switching transients) should not cause false warnings or errors. The `glitch_ignore` step marks these short gaps as ignored, so that `sustain_thresholds` does not classify them as violations.

**The underlying measurement data is never modified.** Steps that must see the actual current (`min_duration_above`, `charge_integral`) always operate on the raw signal. Only violation-detection steps use the filtered view.

### Fields

| Field | Type | Description |
|---|---|---|
| `ref` | binding | Reference level below which a dip counts as a potential glitch. Usually `"nominal_mA"`. |
| `max_gap_ms` | integer (ms) | Maximum dip duration that is silently ignored. Dips longer than this are treated as real signal drops. |

### Example

```json
{
  "id":         "glitch_ignore",
  "op":         "glitch_ignore",
  "type":       "filter",
  "ref":        "nominal_mA",
  "max_gap_ms": 100
}
```

---

## `sustain_thresholds` — type: `monitor`

### Purpose

Continuously classifies each sample into one of three zones based on two configurable current thresholds and records violations whenever the current drops into the warn or error zone.

Both thresholds are expressed as a percentage of a reference binding, so they can track the profile setpoint or nominal current rather than being hard-coded values.

### Zones

| Zone | Condition | Severity |
|---|---|---|
| OK | `current ≥ warn_below × warn_below_threshold_percent` | — |
| Warn | `current < warn_below × %` but `≥ fail_below × %` | warning |
| Error (invalid) | `current < fail_below × fail_below_threshold_percent` | error |

Warn and error zones are mutually exclusive: a sample is either in one zone or the other. If a sample drops directly from OK into the error zone, no warning is generated for that interval — only an error.

### Violation timing

Violation intervals open at the **first sample that falls into the zone** and close at the **first sample that leaves it**. No interpolation is performed between sample points.

Violation counting does not begin until after the full `timeout_ms` ramp window has expired (see `ramp_to_threshold`). Samples inside the ramp window are classified for zone-time accounting but do not produce violation records.

### Fields

| Field | Type | Description |
|---|---|---|
| `after` | string | When monitoring starts. `"after_ramp"` waits for the ramp deadline; `"first_above_A"` starts at the first sample above `fail_below`. |
| `warn_below` | binding | Upper reference for the warn threshold. Usually `"setpoint_mA"`. |
| `warn_below_threshold_percent` | integer (%) \| null | Fraction of `warn_below` that is the effective warn limit. `null` disables the warn check. |
| `fail_below` | binding | Upper reference for the error threshold. Usually `"nominal_mA"`. |
| `fail_below_threshold_percent` | integer (%) \| null | Fraction of `fail_below` that is the effective error limit. `null` disables the error check. |

### Example

```json
{
  "id":   "sustain",
  "op":   "sustain_thresholds",
  "type": "monitor",
  "after": "after_ramp",
  "warn_below":                   "setpoint_mA",
  "warn_below_threshold_percent": 100,
  "fail_below":                   "nominal_mA",
  "fail_below_threshold_percent": 100
}
```

---

## `min_duration_above` — type: `completion`

### Purpose

Accumulates the total time during which the current is continuously above a threshold and checks that this time meets the required stunning duration. Any gap where the current drops below the threshold is recorded as a warning.

### Violation timing

A gap violation opens at the **first sample that falls below the threshold** and closes at the first pair of consecutive samples that are both above the threshold (the recovery point). The gap start is always the failing sample itself — not the preceding OK sample.

Accumulation only starts after the ramp phase ends (`ramp_to_threshold` deadline). If `count_during_ramp` is `false` (the default), the ramp period does not count toward the required duration.

### Fields

| Field | Type | Description |
|---|---|---|
| `threshold` | binding | Current level that must be sustained. Usually `"nominal_mA"`. |
| `duration_from` | binding | Binding name for the required duration (e.g. `"required_duration_s"`). |

### Example

```json
{
  "id":       "duration",
  "op":       "min_duration_above",
  "type":     "completion",
  "threshold":     "nominal_mA",
  "duration_from": "required_duration_s"
}
```

---

## `charge_integral` — type: `completion`

### Purpose

Instead of simply measuring time above a threshold (like `min_duration_above`), `charge_integral` accumulates the **mA·s charge** delivered over the course of the process. This is the completion criterion for integral-based algorithms.

The current is clamped at `setpoint_mA` so that excess current above the setpoint does not reduce the required time. Samples where the current is below `current_threshold_percent` of setpoint (the **cutoff**) do not contribute to the integral.

**Goal:** accumulated charge ≥ `required_duration_s × setpoint_mA`

At exactly the setpoint, the required charge equals the required duration. If the current runs slightly below setpoint (but above the cutoff), the process must run longer to accumulate the same charge.

### Violation timing

A cutoff-zone warning opens at the **first sample that falls below the cutoff** and closes at the first sample that returns above it. As with `min_duration_above`, the violation starts at the failing sample — not at the preceding OK sample.

Accumulation only starts after the ramp phase ends. When `count_during_ramp` is `true`, the ramp period also contributes to the integral.

### Fields

| Field | Type | Description |
|---|---|---|
| `limit_to` | binding | Upper clamp for integration. Usually `"setpoint_mA"`. |
| `current_threshold_percent` | integer (%) | Minimum current fraction of `limit_to` below which no charge is accumulated. |
| `target.duration_from` | binding | Binding name for the required duration (e.g. `"required_duration_s"`). |
| `target.current_from` | binding | Binding name for the target current used to compute the charge goal (e.g. `"setpoint_mA"`). |

### Example

```json
{
  "id":   "charge_ok",
  "op":   "charge_integral",
  "type": "completion",
  "limit_to":                  "setpoint_mA",
  "current_threshold_percent": 70,
  "target": {
    "duration_from": "required_duration_s",
    "current_from":  "setpoint_mA"
  }
}
```

---

## `invalid_timeout` — type: `completion`

*Documentation to be added.*

---

## `total_timeout` — type: `completion`

*Documentation to be added.*

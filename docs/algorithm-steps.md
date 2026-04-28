# Stunning Algorithm Steps

A stunning algorithm is defined as a JSON document (the **spec**). The spec lists
a set of **steps** that the evaluation engine processes against a measurement
recording to decide whether a stunning attempt was successful.

---

## Spec structure

```json
{
  "schema_version": "1.0",
  "algorithm_id": 2,
  "display_name": "Standard",
  "description": "...",
  "bindings": { ... },
  "steps": [ ... ]
}
```

### Bindings

Bindings translate logical names used by the algorithm into field names of the
log entry that is being evaluated.

| Binding key          | Meaning                                      |
|----------------------|----------------------------------------------|
| `nominal_mA`         | Minimum acceptable current (threshold A)     |
| `setpoint_mA`        | Target / ideal current (threshold B)         |
| `required_duration_s`| Required stunning duration from the log entry|

```json
"bindings": {
  "nominal_mA":          "default_current_mA",
  "setpoint_mA":         "current_mA",
  "required_duration_s": "time_s"
}
```

### Threshold references

Steps that reference a current level use one of these symbolic names:

| Reference name           | Resolves to                        |
|--------------------------|------------------------------------|
| `nominal_mA`             | Threshold A (minimum current)      |
| `setpoint_mA`            | Threshold B (target current)       |
| `min_nominal_setpoint`   | `min(nominal_mA, setpoint_mA)`     |

TODO --> `min(nominal_mA, setpoint_mA)` hast to be removed, setpoint must never be below nominal, so the min value is always nominal if this if this info is needed!!1
An integer can also be used directly (fixed mA value, rarely needed).

---

## Step categories and execution order

Each step has a `type` field that determines when it runs:

| Type         | Runs during        | Typical ops                          |
|--------------|--------------------|--------------------------------------|
| `filter`     | Post-processing    | `glitch_ignore`                      |
| `startup`    | Sample loop first  | `ramp_to_threshold`                  |
| `monitor`    | Sample loop second | `sustain_thresholds`                 |
| `completion` | Sample loop third  | `min_duration_above`, `charge_integral`, `invalid_timeout`, `total_timeout` |

Steps with `"enabled": false` are ignored completely.

---

## Steps reference

---

### `glitch_ignore` 

**Category:** `filter`

TODO: This filter works on sample-level, not on evaluation result processing level
if a value is below the setpoint, and the next sample is above within the  max_gap_ms time, the value is regared as if it was not under the setpoint. 

So the glitch filter thread short undercuts if the are short enough as if the not were present. 
the level where it is regarded as undercut ist the setpoint level.

If we receive values every 100ms, and the max_gap is also 100ms, how should this work. 
If a value is below setpoint, its timestamp is taken. 
If the next value is above the setpoint, with a timestamp diff <= max_gab, the first value is handled (end internally forwarded, as if it was on level of the setpoint. 

This can be viualized with a no-filled grad dot in the chart-overly.

#### Parameters

| Parameter    | Type | Default | Description                                                       |
|--------------|------|---------|-------------------------------------------------------------------|
| `max_gap_ms` | int  | `100`   | Violations shorter than this (in ms) are silently removed         |

#### Example

```json
{
  "id": "glitch_ignore",
  "op": "glitch_ignore",
  "type": "filter",
  "enabled": true,
  "max_gap_ms": 100
}
```

#### Effect on values for other algorithm-steps: 

- Setpoint violations shorter than `max_gap_ms` are handled as if the were = setpoint 

### `ramp_to_threshold` — startup current ramp check

**Category:** `startup`

Verifies that the current rises to the required level within a time window.
The ramp window opens at the first sample above `ramp_start_mA` and closes after
`timeout_ms`. Downstream completion steps do not start accumulating until the
ramp phase is over.

#### Parameters

| Parameter                    | Type  | Default | Description                                                             |
|------------------------------|-------|---------|-------------------------------------------------------------------------|
| `threshold`                  | ref   | —       | Target current reference (`setpoint_mA`, `nominal_mA`, …)               |
| `current_threshold_percent`  | int   | `100`   | Fraction of threshold that must be reached, e.g. `98` → 98 %           |
| `timeout_ms`                 | int   | —       | Time window for reaching the threshold (ms); omit to disable ramp check |
| `ramp_start_mA`              | float | `10`    | Current above which the ramp clock starts (mA)                          |
| `count_during_ramp`          | bool  | `false` | If `true`, completion steps begin accumulating from ramp start, not ramp end |

#### How it works

1. The ramp clock starts at the first sample where `I > ramp_start_mA`.
2. The engine tracks the maximum current seen within the window.
3. If `I ≥ threshold × current_threshold_percent / 100` is reached before
   `timeout_ms` expires → ramp success (`rampReachedAt_s` recorded).
4. If the deadline is reached without success → **error** violation
   (`ramp_not_reached`), but evaluation continues.
5. `accumulateStart_s` is set so completion steps begin counting only after the
   ramp phase (or from ramp start if `count_during_ramp: true`).

#### Violations generated

| Message key        | Severity | Condition                                           |
|--------------------|----------|-----------------------------------------------------|
| `ramp_not_reached` | error    | Max current in window < required threshold          |

#### Chart overlay

- Blue dashed vertical line at ramp start.
- Blue dashed vertical line at ramp deadline (timeout).
- Green dashed vertical line at `rampReachedAt_s` (early success).
- Subtle blue band covering the ramp window.

---

### `sustain_thresholds` — continuous current level monitoring

**Category:** `monitor`

Classifies each sample after the ramp phase into one of three zones and generates
violations when the current drops below the configured thresholds. Monitoring can
optionally start at a different trigger than ramp completion.

#### Parameters

| Parameter                        | Type   | Default      | Description                                                                          |
|----------------------------------|--------|--------------|--------------------------------------------------------------------------------------|
| `after`                          | select | `after_ramp` | When monitoring starts: `after_ramp` or `first_above_A` (first sample above nominal) |
| `warn_below`                     | ref    | —            | Reference current for the warn threshold                                             |
| `warn_below_threshold_percent`   | int    | `100`        | Current below `warn_below × pct / 100` → warn zone; `null` disables warn            |
| `fail_below`                     | ref    | —            | Reference current for the fail threshold                                             |
| `fail_below_threshold_percent`   | int    | `100`        | Current below `fail_below × pct / 100` → fail zone; `null` disables fail            |

#### Zone classification

```
I ≥ warnBelow              → OK zone      (green)
warnBelow > I ≥ failBelow  → WARN zone    (yellow)
I < failBelow              → FAIL zone    (red)
```

A violation interval opens when the current enters the WARN or FAIL zone and
closes when it exits. The WARN zone violation is only tracked while the current
is **above** the fail threshold — a dip into the FAIL zone generates only an
error, not a simultaneous warn.

Zone time totals (`ok_s`, `warn_s`, `invalid_s`) are accumulated on `runtimeCtx`
for the `invalid_timeout` step to read.

#### Violations generated

| Message key | Severity | Condition                                           |
|-------------|----------|-----------------------------------------------------|
| `below_A`   | error    | `I < fail_below × percent` during the monitor window|
| `below_B`   | warn     | `I < warn_below × percent` (and above fail threshold)|

#### Note on `after` trigger

- `after_ramp`: monitoring starts at the ramp deadline. Samples during the ramp
  window are never checked.
- `first_above_A`: monitoring starts on the first sample where `I ≥ nominal_mA`.

---

### `min_duration_above` — required stunning duration

**Category:** `completion`

Accumulates the time during which the current is simultaneously above threshold
in both the current **and** the previous sample (trapezoidal criterion: the full
inter-sample interval is only counted when both endpoints are above threshold).
Goal is reached when accumulated time ≥ required duration.

#### Parameters

| Parameter                        | Type    | Default               | Description                                                                         |
|----------------------------------|---------|-----------------------|-------------------------------------------------------------------------------------|
| `threshold`                      | ref     | —                     | Current reference that must be sustained (`nominal_mA`, `setpoint_mA`, …)           |
| `current_threshold_percent`      | int     | `100`                 | Effective threshold = `reference × pct / 100`                                       |
| `duration_from`                  | binding | `required_duration_s` | Binding key whose value gives the required duration (s) from the log entry          |
| `completion_threshold_percent`   | int     | `100`                 | Only this fraction of the required duration must be reached, e.g. `90` → 90 %      |

#### How it works

1. Accumulation starts at `accumulateStart_s` (set by `ramp_to_threshold`; zero if no ramp step).
2. For each consecutive sample pair where `prev.I ≥ threshold` AND `curr.I ≥ threshold`,
   the inter-sample interval is added to `totalAbove`.
3. When `totalAbove ≥ required_s × completion_threshold_percent / 100`,
   `completedAt_s` is recorded and all subsequent steps stop accumulating.
4. Each time the current drops below threshold, a `below_threshold_gap` warn interval
   is opened. It closes (and becomes a violation) when the current recovers.

#### Violations generated

| Message key            | Severity | Condition                                                      |
|------------------------|----------|----------------------------------------------------------------|
| `below_threshold_gap`  | warn     | Gap below threshold during accumulation (before goal reached)  |
| `duration_not_reached` | error    | Total accumulated time < required at end of recording (summary)|

#### Chart overlay

- Duration progress line (cyan, right %-axis) shows accumulated time as a percentage of required.
- A threshold tick at `completion_threshold_percent` is drawn when < 100 %.
- Green vertical line + band from `completedAt_s` to end of recording.

---

### `charge_integral` — current–time charge check

**Category:** `completion`

Accumulates the charge (mA·s) delivered above a cutoff current, clamped at an
upper limit, using the trapezoidal rule. Goal is met when the accumulated charge
reaches a target derived from the required duration and the setpoint current.

Use this step instead of (or alongside) `min_duration_above` when the
current waveform is not flat and total delivered charge matters more than
pure time.

#### Parameters

| Parameter                        | Type    | Default               | Description                                                                                |
|----------------------------------|---------|-----------------------|--------------------------------------------------------------------------------------------|
| `limit_to`                       | ref     | `setpoint_mA`         | Upper clamp — current above this is treated as equal to this value for integration         |
| `current_threshold_percent`      | int     | `70`                  | Cutoff: samples below `limit_to × pct / 100` contribute **zero** charge                   |
| `target.duration_from`           | binding | `required_duration_s` | Binding key for target duration (s)                                                        |
| `target.current_from`            | binding | `setpoint_mA`         | Binding key for target current (mA); target charge = `duration × current`                 |
| `completion_threshold_percent`   | int     | `100`                 | Only this fraction of the target charge must be reached                                    |

#### How it works

1. Accumulation starts at `accumulateStart_s`.
2. For each sample pair, the clamped average current is integrated over the
   inter-sample interval: `Δcharge = ((clamp(I₀) + clamp(I₁)) / 2) × Δt`.
   Samples below the cutoff contribute 0.
3. Target charge = `required_s × setpoint_mA × completion_threshold_percent / 100`.
4. When accumulated charge ≥ target, `completedAt_s` is recorded.
5. Any interval where `I < cutoff` opens a `below_cutoff_zone` warn.

#### Violations generated

| Message key          | Severity | Condition                                                          |
|----------------------|----------|--------------------------------------------------------------------|
| `below_cutoff_zone`  | warn     | Current below cutoff during accumulation (before goal reached)     |
| `integral_not_reached`| error   | Accumulated charge < target at end of recording (summary)          |

#### Chart overlay

- Integral progress line (purple, right %-axis).
- Purple horizontal cutoff line at the cutoff current level.
- Blue band between cutoff and `limit_to` showing the effective integration zone.

---

### `invalid_timeout` — cumulative invalid-zone time limit

**Category:** `completion`

Guards against recordings where the current spends too long in the FAIL zone
(below `fail_below` of `sustain_thresholds`). Requires `sustain_thresholds` to
be present and running, as it reads the `invalid_s` accumulator from `runtimeCtx`.

#### Parameters

| Parameter       | Type  | Default | Description                                                |
|-----------------|-------|---------|------------------------------------------------------------|
| `max_invalid_s` | float | `0`     | Maximum cumulative FAIL-zone time allowed (s)              |

#### How it works

Each sample, the handler checks whether `runtimeCtx.invalid_s` (accumulated by
`sustain_thresholds`) exceeds `max_invalid_s`. On first crossing, it flags
`runtimeCtx.invalidTimedOut = true` so that streaming callers can stop early.
A summary error is generated in `finalize` if the limit was exceeded.

#### Violations generated

| Message key       | Severity | Condition                                          |
|-------------------|----------|----------------------------------------------------|
| `invalid_timeout` | error    | Cumulative FAIL-zone time > `max_invalid_s` (summary)|

---

### `total_timeout` — maximum recording length

**Category:** `completion`

Catches runaway recordings by failing if the total recording duration exceeds
a multiple of the required stunning duration.

#### Parameters

| Parameter       | Type    | Default               | Description                                                    |
|-----------------|---------|-----------------------|----------------------------------------------------------------|
| `duration_from` | binding | `required_duration_s` | Binding key for the required duration (s)                      |
| `factor`        | float   | `3.0`                 | Timeout = `required_duration × factor`                         |

#### How it works

The clock starts at the first sample. If `elapsed > required_s × factor`, the
step flags `runtimeCtx.totalTimedOut_s` and generates a summary error. The
streaming API uses this flag to stop early.

#### Violations generated

| Message key     | Severity | Condition                                                        |
|-----------------|----------|------------------------------------------------------------------|
| `total_timeout` | error    | Recording length > `required_s × factor` (summary)              |

---

## Post-processing order

After all step handlers finalize, `_finalizeHandlers` applies these passes in
order before returning the result:

1. **Completion truncation** — non-summary violations that start at or after
   `completedAt_s` are removed or clipped to end at `completedAt_s`.
2. **Warn suppression** — warn violations fully covered by an error violation
   interval are removed (the error already represents the worst-case condition).
3. **Glitch filter** — if a `glitch_ignore` step is enabled, any remaining
   non-summary violation shorter than `max_gap_ms` is removed and its interval
   is stored in `glitchForgivenIntervals` for overlay visualization.

---

## Evaluation result

`evaluate(logEntry, spec)` returns:

```js
{
  ok:           boolean,      // true if no error violations remain
  hasWarn:      boolean,      // true if any warn violations remain
  violations:   Violation[],  // surviving violations after all post-processing
  meta:         Object,       // step-level aggregates (accumulated times, series data, …)
  thresholds:   { A, B },     // resolved nominal_mA and setpoint_mA in mA
  overlayHints: Object        // chart overlay data (see below)
}
```

### Violation object

```js
{
  ruleId:     string,   // step id from the spec
  severity:   'error' | 'warn',
  tStart_s:   number,   // interval start (s, relative to recording start)
  tEnd_s:     number,   // interval end (s)
  messageKey: string,   // human-readable key (see message table)
  isSummary:  boolean,  // true = summary violation, no meaningful tStart/tEnd
  details:    Object,   // message-specific fields
  stepType:   string    // category of the originating step
}
```

### overlayHints fields

| Field                          | Set by step         | Content                                                     |
|--------------------------------|---------------------|-------------------------------------------------------------|
| `rampStart_s`                  | `ramp_to_threshold` | Time when ramp window opened (s)                            |
| `rampDeadline_s`               | `ramp_to_threshold` | Time when ramp window closed (s)                            |
| `rampReachedAt_s`              | `ramp_to_threshold` | Time threshold was first reached; `null` if not             |
| `completedAt_s`                | completion steps    | Time goal was achieved; `null` if not                       |
| `effectiveFailBelow_mA`        | `sustain_thresholds`| Resolved fail threshold in mA (after percent scaling)       |
| `effectiveWarnBelow_mA`        | `sustain_thresholds`| Resolved warn threshold in mA                               |
| `durationSeries`               | `min_duration_above`| Progress series `[{t, pct}]` for overlay line               |
| `durationThresholdPct`         | `min_duration_above`| `completion_threshold_percent` value                        |
| `durationEffectiveThreshold_mA`| `min_duration_above`| Effective current threshold in mA                           |
| `integralSeries`               | `charge_integral`   | Progress series `[{t, pct}]` for overlay line               |
| `integralCutoff_mA`            | `charge_integral`   | Cutoff current in mA                                        |
| `integralLimit_mA`             | `charge_integral`   | Upper clamp current in mA                                   |
| `glitchForgivenIntervals`      | `glitch_ignore`     | `[{tStart_s, tEnd_s}]` of suppressed short violations       |

---

## Typical algorithm configurations

### Standard (ramp + glitch filter + zone monitor + duration)

```json
"steps": [
  { "op": "glitch_ignore",      "type": "filter",     "max_gap_ms": 100 },
  { "op": "ramp_to_threshold",  "type": "startup",    "threshold": "setpoint_mA",
    "timeout_ms": 1000, "ramp_start_mA": 10 },
  { "op": "sustain_thresholds", "type": "monitor",    "after": "after_ramp",
    "warn_below": "setpoint_mA", "warn_below_threshold_percent": 100,
    "fail_below": "nominal_mA",  "fail_below_threshold_percent": 100 },
  { "op": "min_duration_above", "type": "completion", "threshold": "nominal_mA",
    "duration_from": "required_duration_s" },
  { "op": "invalid_timeout",    "type": "completion", "max_invalid_s": 0.5 },
  { "op": "total_timeout",      "type": "completion", "factor": 3.0 }
]
```

### Charge-integral variant (replaces duration step)

Replace `min_duration_above` with `charge_integral` to measure delivered charge
instead of pure time above threshold. Useful when the current waveform shows a
ramp-down towards the end of the stun:

```json
{ "op": "charge_integral", "type": "completion",
  "limit_to": "setpoint_mA", "current_threshold_percent": 70,
  "target": { "duration_from": "required_duration_s", "current_from": "setpoint_mA" },
  "completion_threshold_percent": 90 }
```

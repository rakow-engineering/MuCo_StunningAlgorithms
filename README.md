# stunning-algo

Portable C library for per-sample stunning current evaluation, plus a
Python code generator that produces algorithm configuration constants from
JSON DSL specs.

Designed for embedded targets (C99, no heap allocation, constant memory
footprint regardless of stunning duration).  Also usable from unit tests
and PC-side analysis tools.

---

## Repository contents

```
stunning-algo/
├── StunningAlgoConfig.h       # StunningAlgoConfig_t typedef (generated configs plug in here)
├── StunningAlgoHandler.h      # StunningAlgoState_t + function declarations
├── StunningAlgoHandler.c      # Per-sample stateful evaluation logic
├── StunningResult.h           # V10.x public API header (init/setup/stop/get/update)
├── emitStunningEvalC.py       # Code generator: JSON spec -> C config constants
├── algorithms/
│   ├── stunning_embedded_v10.json   # algorithm_id 1 -- V10.x compatible
│   ├── stunning_current_v1.json     # algorithm_id 2 -- standard current
│   └── stunning_current_integral_v1.json  # algorithm_id 3 -- current-time integral
└── generated/
    ├── stunning_algo_1.h/c          # Pre-generated config for algorithm 1
    ├── stunning_algo_2.h/c          # Pre-generated config for algorithm 2
    ├── stunning_algo_3.h/c          # Pre-generated config for algorithm 3
    ├── stunning_algo_registry.h     # Includes all, declares STUNNING_ALGO_REGISTRY[]
    └── stunning_algo_registry.c     # Defines the registry array + count
```

**`StunningResult.c` is NOT in this repo** — it contains platform-specific
integration code (`Tick.h`, `Settings.h`, `Buzzer.h`, etc.) and lives in the
embedding project alongside `StunningResult.h`.

---

## Algorithm IDs

| ID | display_name | Description |
|----|-------------|-------------|
| 1 | Embedded V10: Rampe 1s, Mindestdauer >= nominal | Matches existing StunningResult.c V10.x behaviour |
| 2 | Standard: Rampe, Schwellen nominal/setpoint, Mindestdauer | Classic evaluation with glitch filter |
| 3 | Integral: Rampe, Schwellen nominal/setpoint, Strom-Zeit-Integral | Charge integral instead of minimum duration |

---

## How to use in an embedded project

### Option A -- pre-generated (simplest)

Copy these files to your project:

```
StunningAlgoConfig.h
StunningAlgoHandler.h
StunningAlgoHandler.c
StunningResult.h
generated/stunning_algo_1.h      (or whichever algorithms you need)
generated/stunning_algo_1.c
generated/stunning_algo_registry.h
generated/stunning_algo_registry.c
```

Add `stunning_algo_registry.c` and `StunningAlgoHandler.c` (plus any
`stunning_algo_N.c` files you need) to your build.

### Option B -- regenerate from spec

Run the generator whenever an algorithm spec changes:

```bash
python emitStunningEvalC.py  algorithms/stunning_embedded_v10.json \
                              algorithms/stunning_current_v1.json   \
                              algorithms/stunning_current_integral_v1.json \
                              generated/
```

The last argument is the output directory.  All per-algorithm files and the
registry are written there.

---

## API

### Initialise before each stunning event

```c
#include "StunningAlgoHandler.h"
#include "generated/stunning_algo_registry.h"

StunningAlgoState_t state;
StunningAlgo_init(&state);
```

### Select an algorithm

```c
/* By registry index: */
const StunningAlgoConfig_t *cfg = STUNNING_ALGO_REGISTRY[0];

/* Or directly by constant: */
const StunningAlgoConfig_t *cfg = &STUNNING_ALGO_1;
```

### Feed samples (call once per measurement sample)

```c
STUNNING_RESULT_t result = StunningAlgo_update(
    &state,
    cfg,
    current_mA,          /* float -- measured current                   */
    timestamp_ms,        /* uint32_t -- monotonically increasing tick   */
    nominal_mA,          /* float -- equipment nominal current          */
    setpoint_mA,         /* float -- operator setpoint current          */
    required_duration_s  /* float -- required stunning duration         */
);
```

Returns one of:

| Value | Meaning |
|-------|---------|
| `STUNNING_RESULT_IDLE` | Evaluation in progress |
| `STUNNING_RESULT_OK` | Goal reached, current always >= setpoint |
| `STUNNING_RESULT_UNSHURE` | Goal reached, but current dipped into TOLERATED zone |
| `STUNNING_RESULT_FAIL` | Timeout (INVALID or total) |

### Read extended detail

```c
STUNNING_RESULT_detail_t detail;
StunningAlgo_getDetail(&state, timestamp_ms, &detail);
/* detail.OK_elapsed_ms, detail.UNSHURE_elapsed_ms, detail.INVALID_elapsed_ms,
   detail.charge_integral_mAs, detail.total_elapsed_ms ...                    */
```

### V10.x wrapper API (StunningResult.h)

If you integrate via the existing `StunningResult.c` platform wrapper, the
public API is unchanged from V10.x:

```c
StunningResult_init();
StunningResult_setup(timeout_ms);
// ... settings observer calls StunningResult_update(current_mA, timestamp_ms)
STUNNING_RESULT_t r = StunningResult_get();
StunningResult_stop();
```

Runtime algorithm selection:

```c
StunningResult_setAlgorithm(&STUNNING_ALGO_2);
StunningResult_setup(timeout_ms);
```

---

## Adding a new algorithm

1. Create `algorithms/stunning_<name>.json` with a unique `algorithm_id` integer.
2. Run the generator (see above).
3. Commit both the spec and the regenerated `generated/` files.

---

## Zone classification

```
setpoint_mA  ─────────────────────────  AREA OK        (warn_use_nominal=false, >= setpoint)
nominal_mA   ─────────────────────────  AREA TOLERATED (>= nominal, < setpoint)
             ─────────────────────────  AREA INVALID   (< nominal)
```

Zone thresholds are configurable per algorithm via `sustain.warn_use_nominal`
and `sustain.fail_use_nominal` — each threshold can independently reference
either `nominal_mA` or `setpoint_mA`.

---

## Memory footprint

`StunningAlgoState_t` is approximately 64 bytes on a 32-bit target.
No dynamic allocation.  No sample buffer — each call to
`StunningAlgo_update()` advances running counters in place.

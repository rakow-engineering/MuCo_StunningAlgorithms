/* StunningAlgoHandler.c
 * Static file -- tracked in version control, NOT generated.
 *
 * Per-sample stateful evaluation.  No sample buffer.
 * Memory footprint is constant regardless of stunning duration.
 *
 * Glitch filter semantics:
 *   A sub-nominal dip shorter than cfg->glitch.max_gap_ms is "forgiven" for
 *   zone-violation purposes: the deferred zone time is credited to the
 *   hold value (pre-dip current) instead of INVALID.
 *   Duration and integral accumulators always see actual current, so a
 *   forgiven glitch still pauses accumulation and correctly extends the
 *   required stunning time.
 */
#include "StunningAlgoHandler.h"
#include <string.h>

#ifndef MINF
#  define MINF(a, b)  ((a) < (b) ? (a) : (b))
#endif

/* ---- Internal helper: classify a time interval into a zone counter ---- */
static void _classify_zone(
    StunningAlgoState_t        *s,
    uint32_t                    dt_ms,
    float                       I,
    float                       nominal_mA,
    float                       setpoint_mA,
    const StunningAlgoConfig_t *cfg)
{
    float warn_ref   = cfg->sustain.warn_use_nominal ? nominal_mA  : setpoint_mA;
    float fail_ref   = cfg->sustain.fail_use_nominal ? nominal_mA  : setpoint_mA;
    float warn_below = warn_ref * ((float)cfg->sustain.warn_percent / 100.0f);
    float fail_below = fail_ref * ((float)cfg->sustain.fail_percent / 100.0f);

    if (cfg->sustain.fail_percent > 0u && I < fail_below)
    {
        s->INVALID_elapsed_ms += dt_ms;
    }
    else if (cfg->sustain.warn_percent > 0u && I < warn_below)
    {
        s->UNSHURE_elapsed_ms += dt_ms;
    }
    else
    {
        s->OK_elapsed_ms += dt_ms;
    }
}

/* ======================================================================== */

void StunningAlgo_init(StunningAlgoState_t *state)
{
    memset(state, 0, sizeof(*state));
    state->first_sample        = true;
    state->accumulate_start_ms = (uint32_t)-1;  /* not yet set */
    state->result              = STUNNING_RESULT_IDLE;
}

/* ======================================================================== */

STUNNING_RESULT_t StunningAlgo_update(
    StunningAlgoState_t        *state,
    const StunningAlgoConfig_t *cfg,
    float                       current_mA,
    uint32_t                    time_ms,
    float                       nominal_mA,
    float                       setpoint_mA,
    float                       required_duration_s)
{
    uint32_t dt;

    /* ------------------------------------------------------------------ */
    /* First sample: record baseline, nothing to evaluate yet              */
    /* ------------------------------------------------------------------ */
    if (state->first_sample)
    {
        state->first_sample = false;
        state->setup_ms     = time_ms;
        state->prev_ms      = time_ms;
        state->prev_I       = current_mA;

        if (!cfg->ramp.enabled)
        {
            state->ramp_complete       = true;
            state->accumulate_start_ms = time_ms;
        }
        return STUNNING_RESULT_IDLE;
    }

    dt = time_ms - state->prev_ms;

    /* ------------------------------------------------------------------ */
    /* Ramp detection                                                       */
    /* ------------------------------------------------------------------ */
    if (cfg->ramp.enabled && !state->ramp_complete)
    {
        float    ramp_thr;
        uint32_t deadline;

        if (!state->ramp_started && current_mA > cfg->ramp.start_mA)
        {
            state->ramp_started  = true;
            state->ramp_start_ms = time_ms;
            if (cfg->ramp.count_during)
            {
                state->accumulate_start_ms = time_ms;
            }
        }

        if (state->ramp_started)
        {
            deadline = state->ramp_start_ms + (uint32_t)cfg->ramp.within_ms;
            ramp_thr = setpoint_mA * ((float)cfg->ramp.threshold_percent / 100.0f);

            if (current_mA >= ramp_thr)
            {
                state->ramp_complete = true;
                state->ramp_end_ms   = time_ms;
            }
            else if (time_ms >= deadline)
            {
                state->ramp_complete = true;
                state->ramp_end_ms   = deadline;
                state->ramp_failed   = true;
            }

            if (state->ramp_complete && !cfg->ramp.count_during)
            {
                state->accumulate_start_ms = state->ramp_end_ms;
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Zone classification (sustain_thresholds) -- only after ramp ends    */
    /* Uses effective current: glitch-forgiven dips appear as hold value.  */
    /* ------------------------------------------------------------------ */
    if (state->ramp_complete && time_ms > state->ramp_end_ms && !state->goal_reached)
    {
        if (cfg->glitch.enabled && cfg->glitch.max_gap_ms > 0u)
        {
            if (current_mA < nominal_mA)
            {
                /* Start or continue a potential glitch */
                if (!state->glitch_active)
                {
                    state->glitch_active   = true;
                    state->glitch_start_ms = time_ms;
                    state->glitch_hold_mA  = state->prev_I;
                }
                /* Defer zone classification */
            }
            else
            {
                if (state->glitch_active)
                {
                    /* Glitch just ended: resolve the deferred interval */
                    uint32_t gap_ms = time_ms - state->glitch_start_ms;
                    if (gap_ms < (uint32_t)cfg->glitch.max_gap_ms)
                    {
                        /* Forgiven: credit gap as hold_mA zone */
                        _classify_zone(state, gap_ms, state->glitch_hold_mA,
                                       nominal_mA, setpoint_mA, cfg);
                    }
                    else
                    {
                        /* Committed: gap was a real INVALID event */
                        _classify_zone(state, gap_ms, 0.0f,
                                       nominal_mA, setpoint_mA, cfg);
                    }
                    state->glitch_active = false;
                    /* gap_ms already covers [glitch_start, time_ms] -- skip dt */
                }
                else
                {
                    /* Normal sample */
                    _classify_zone(state, dt, current_mA,
                                   nominal_mA, setpoint_mA, cfg);
                }
            }
        }
        else
        {
            /* No glitch filter */
            _classify_zone(state, dt, current_mA,
                           nominal_mA, setpoint_mA, cfg);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Completion accumulators -- always use ACTUAL current, never eff_mA  */
    /* ------------------------------------------------------------------ */
    if (state->accumulate_start_ms != (uint32_t)-1 &&
        time_ms > state->accumulate_start_ms &&
        !state->goal_reached)
    {
        uint32_t acc_dt = (state->prev_ms < state->accumulate_start_ms)
                          ? (time_ms - state->accumulate_start_ms)
                          : dt;

        if (cfg->completion.use_duration)
        {
            uint32_t required_ms = (uint32_t)(required_duration_s * 1000.0f);
            if (current_mA >= nominal_mA && state->prev_I >= nominal_mA)
            {
                state->stunning_elapsed_ms += acc_dt;
            }
            if (state->stunning_elapsed_ms >= required_ms)
            {
                state->goal_reached = true;
            }
        }

        if (cfg->completion.use_integral && !state->goal_reached)
        {
            float limit_val = cfg->completion.integral.limit_to_nominal
                              ? nominal_mA : setpoint_mA;
            float cutoff    = limit_val
                              * ((float)cfg->completion.integral.cutoff_percent / 100.0f);
            float target    = required_duration_s * limit_val;
            float dt_s      = (float)acc_dt / 1000.0f;
            float I0        = state->prev_I;
            float I1        = current_mA;
            float e0        = (I0 >= cutoff) ? MINF(I0, limit_val) : 0.0f;
            float e1        = (I1 >= cutoff) ? MINF(I1, limit_val) : 0.0f;
            state->charge_integral_mAs += ((e0 + e1) / 2.0f) * dt_s;
            if (state->charge_integral_mAs >= target)
            {
                state->goal_reached = true;
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Timeout checks                                                       */
    /* ------------------------------------------------------------------ */
    if (cfg->timeouts.check_invalid)
    {
        if (state->INVALID_elapsed_ms > (uint32_t)cfg->timeouts.invalid_ms)
        {
            state->timeout_invalid = true;
        }
    }

    if (cfg->timeouts.check_total && required_duration_s > 0.0f)
    {
        uint32_t total_ms = time_ms - state->setup_ms;
        uint32_t limit_ms = (uint32_t)(required_duration_s
                             * cfg->timeouts.total_factor * 1000.0f);
        if (total_ms > limit_ms)
        {
            state->timeout_total = true;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Advance state for next sample                                        */
    /* ------------------------------------------------------------------ */
    state->prev_ms = time_ms;
    state->prev_I  = current_mA;

    /* ------------------------------------------------------------------ */
    /* Compute result                                                       */
    /* ------------------------------------------------------------------ */
    if (state->timeout_invalid || state->timeout_total)
    {
        state->result = STUNNING_RESULT_FAIL;
    }
    else if (state->goal_reached)
    {
        state->result = (state->UNSHURE_elapsed_ms > 0u)
                        ? STUNNING_RESULT_UNSHURE
                        : STUNNING_RESULT_OK;
    }
    else
    {
        state->result = STUNNING_RESULT_IDLE;
    }

    return state->result;
}

/* ======================================================================== */

void StunningAlgo_getDetail(
    const StunningAlgoState_t *state,
    uint32_t                   time_ms,
    STUNNING_RESULT_detail_t  *detail)
{
    if (!detail)
    {
        return;
    }
    detail->OK_elapsed_ms       = state->OK_elapsed_ms;
    detail->UNSHURE_elapsed_ms  = state->UNSHURE_elapsed_ms;
    detail->INVALID_elapsed_ms  = state->INVALID_elapsed_ms;
    detail->VALID_elapsed_ms    = state->OK_elapsed_ms + state->UNSHURE_elapsed_ms;
    detail->stunning_elapsed_ms = state->stunning_elapsed_ms;
    detail->charge_integral_mAs = state->charge_integral_mAs;
    detail->total_elapsed_ms    = (state->first_sample || state->setup_ms == 0u)
                                  ? 0u
                                  : (time_ms - state->setup_ms);
}

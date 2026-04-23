/* StunningAlgoHandler.c
 * Static file -- tracked in version control, NOT generated.
 *
 * Top-level coordinator.  Delegates each sample to the appropriate per-step
 * handlers in the same order as the JS engine processes its handler list.
 *
 * No evaluation logic lives here — all step logic is in StunningHandlers.c.
 * Public API (init / update / getDetail) is unchanged from V10.
 */
#include "StunningAlgoHandler.h"
#include <string.h>

/* =========================================================================
   StunningAlgo_init
   ========================================================================= */

void StunningAlgo_init(StunningAlgoState_t *state)
{
    memset(state, 0, sizeof(*state));
    state->first_sample = true;
    state->result       = STUNNING_RESULT_IDLE;

    /* Sub-handler states */
    StunningGlitch_init(&state->glitch);
    StunningRamp_init(&state->ramp);
    StunningSustain_init(&state->sustain);
    StunningDuration_init(&state->duration);
    StunningIntegral_init(&state->integral);
    StunningInvalidTimeout_init(&state->inv_timeout);
    StunningTotalTimeout_init(&state->tot_timeout);
}

/* =========================================================================
   StunningAlgo_update
   ========================================================================= */

STUNNING_RESULT_t StunningAlgo_update(
    StunningAlgoState_t        *state,
    const StunningAlgoConfig_t *cfg,
    float                       current_mA,
    uint32_t                    time_ms,
    float                       nominal_mA,
    float                       setpoint_mA,
    float                       required_duration_s)
{
    /* ------------------------------------------------------------------ */
    /* First sample: initialise runtime context and record baseline        */
    /* ------------------------------------------------------------------ */
    if (state->first_sample) {
        state->first_sample = false;
        state->setup_ms     = time_ms;
        state->prev_ms      = time_ms;
        state->prev_I       = current_mA;

        bool hasRamp = cfg->ramp.enabled;
        StunningRuntimeCtx_init(&state->ctx, hasRamp);

        /* When there is no ramp, accumulation and monitoring are immediate */
        if (!hasRamp) {
            state->ctx.rampDeadline_ms    = time_ms;
            state->ctx.accumulateStart_ms = time_ms;
        }

        /* Record first timestamp for total-timeout handler */
        StunningTotalTimeout_update(&state->tot_timeout, time_ms);

        return STUNNING_RESULT_IDLE;
    }

    /* ------------------------------------------------------------------ */
    /* Record for total-timeout (must see every sample)                    */
    /* ------------------------------------------------------------------ */
    StunningTotalTimeout_update(&state->tot_timeout, time_ms);

    /* ------------------------------------------------------------------ */
    /* Step 1: GlitchHandler — sets ctx.effectiveI                         */
    /* ------------------------------------------------------------------ */
    if (cfg->glitch.enabled) {
        StunningGlitch_update(
            &state->glitch,
            current_mA, time_ms, state->prev_ms, state->prev_I,
            nominal_mA, cfg->glitch.max_gap_ms,
            &state->ctx);
    } else {
        state->ctx.effectiveI = current_mA;
    }

    /* ------------------------------------------------------------------ */
    /* Step 2: RampHandler — sets ctx.rampDeadline_ms, accumulateStart_ms  */
    /* ------------------------------------------------------------------ */
    if (cfg->ramp.enabled) {
        StunningRamp_update(
            &state->ramp,
            current_mA, time_ms,
            setpoint_mA, cfg,
            &state->ctx);
    }

    /* ------------------------------------------------------------------ */
    /* Step 3: SustainHandler — zone counters, reads ctx.rampDeadline_ms   */
    /* ------------------------------------------------------------------ */
    if (cfg->sustain.enabled) {
        StunningSustain_update(
            &state->sustain,
            current_mA, time_ms,
            nominal_mA, setpoint_mA, cfg,
            &state->ctx);
    }

    /* ------------------------------------------------------------------ */
    /* Step 4: Completion accumulators (duration and/or integral)          */
    /* Both read ctx.accumulateStart_ms, write ctx.completedAt_ms          */
    /* ------------------------------------------------------------------ */
    if (cfg->completion.use_duration && !state->integral.goal_reached) {
        StunningDuration_update(
            &state->duration,
            current_mA, time_ms, state->prev_ms, state->prev_I,
            nominal_mA,
            required_duration_s,
            cfg->completion.duration_threshold_percent,
            &state->ctx);
    }

    if (cfg->completion.use_integral && !state->duration.goal_reached) {
        StunningIntegral_update(
            &state->integral,
            current_mA, time_ms, state->prev_ms, state->prev_I,
            nominal_mA, setpoint_mA,
            required_duration_s, cfg,
            &state->ctx);
    }

    /* ------------------------------------------------------------------ */
    /* Step 5: Timeout checks (read ctx zone counters and timing)          */
    /* ------------------------------------------------------------------ */
    if (cfg->timeouts.check_invalid) {
        StunningInvalidTimeout_check(
            &state->inv_timeout, &state->ctx, cfg->timeouts.invalid_ms);
    }

    if (cfg->timeouts.check_total) {
        StunningTotalTimeout_check(
            &state->tot_timeout, time_ms,
            required_duration_s, cfg->timeouts.total_factor);
    }

    /* ------------------------------------------------------------------ */
    /* Advance state                                                        */
    /* ------------------------------------------------------------------ */
    state->prev_ms = time_ms;
    state->prev_I  = current_mA;

    /* ------------------------------------------------------------------ */
    /* Compute result                                                       */
    /* ------------------------------------------------------------------ */
    bool goal_reached = state->duration.goal_reached || state->integral.goal_reached;

    if (state->inv_timeout.timed_out || state->tot_timeout.timed_out) {
        state->result = STUNNING_RESULT_FAIL;
    } else if (goal_reached) {
        state->result = (state->sustain.warn_ms > 0u)
                        ? STUNNING_RESULT_UNSHURE
                        : STUNNING_RESULT_OK;
    } else {
        state->result = STUNNING_RESULT_IDLE;
    }

    return state->result;
}

/* =========================================================================
   StunningAlgo_getDetail
   ========================================================================= */

void StunningAlgo_getDetail(
    const StunningAlgoState_t *state,
    uint32_t                   time_ms,
    STUNNING_RESULT_detail_t  *detail)
{
    if (!detail) return;

    detail->OK_elapsed_ms       = state->ctx.ok_ms;
    detail->UNSHURE_elapsed_ms  = state->ctx.warn_ms;
    detail->INVALID_elapsed_ms  = state->ctx.invalid_ms;
    detail->VALID_elapsed_ms    = state->ctx.ok_ms + state->ctx.warn_ms;
    detail->stunning_elapsed_ms = state->duration.elapsed_ms;
    detail->charge_integral_mAs = state->integral.charge_mAs;
    detail->total_elapsed_ms    = (state->first_sample || state->setup_ms == 0u)
                                  ? 0u
                                  : (time_ms - state->setup_ms);
}

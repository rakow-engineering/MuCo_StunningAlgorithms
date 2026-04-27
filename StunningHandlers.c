/* StunningHandlers.c
 * Static file -- tracked in version control, NOT generated.
 *
 * Per-step handler implementations.  See StunningHandlers.h for the interface.
 */
#include "StunningHandlers.h"
#include <string.h>

#ifndef MINF
#  define MINF(a, b)  ((a) < (b) ? (a) : (b))
#endif

/* =========================================================================
   StunningRuntimeCtx
   ========================================================================= */

void StunningRuntimeCtx_init(StunningRuntimeCtx_t *ctx, bool hasRamp)
{
    memset(ctx, 0, sizeof(*ctx));
    if (!hasRamp) {
        /* No ramp: monitoring and accumulation start from the first sample */
        ctx->rampDeadline_ms    = 0u;
        ctx->accumulateStart_ms = 0u;
    } else {
        /* Sentinel: ramp handler will overwrite when ramp starts */
        ctx->rampDeadline_ms    = (uint32_t)-1;
        ctx->accumulateStart_ms = (uint32_t)-1;
    }
    ctx->completedAt_ms = (uint32_t)-1;  /* not yet completed */
}

/* =========================================================================
   GlitchHandler
   ========================================================================= */

void StunningGlitch_init(StunningGlitchState_t *s)
{
    memset(s, 0, sizeof(*s));
}

void StunningGlitch_update(
    StunningGlitchState_t      *s,
    float                       I_mA,
    uint32_t                    t_ms,
    uint32_t                    prev_ms,
    float                       prev_I,
    float                       nominal_mA,
    uint32_t                    max_gap_ms,
    StunningRuntimeCtx_t       *ctx)
{
    (void)t_ms;  /* current time not needed — gap is measured from start_ms */

    if (I_mA < nominal_mA) {
        if (!s->active) {
            /* Record from prev_ms so the falling sample's dt is included */
            s->active    = true;
            s->start_ms  = prev_ms;
            s->hold_mA   = prev_I;
        }
        /* Glitch ongoing — report hold value if within forgiveness window */
        uint32_t gap_ms = t_ms - s->start_ms;
        ctx->effectiveI = (gap_ms < max_gap_ms) ? s->hold_mA : I_mA;
    } else {
        s->active       = false;
        ctx->effectiveI = I_mA;
    }
}

/* =========================================================================
   RampHandler
   ========================================================================= */

void StunningRamp_init(StunningRampState_t *s)
{
    memset(s, 0, sizeof(*s));
}

void StunningRamp_update(
    StunningRampState_t        *s,
    float                       I_mA,
    uint32_t                    t_ms,
    float                       setpoint_mA,
    const StunningAlgoConfig_t *cfg,
    StunningRuntimeCtx_t       *ctx)
{
    float    ramp_thr;

    /* Detect ramp start: first sample above ramp.start_mA */
    if (!s->started && I_mA > cfg->ramp.start_mA) {
        s->started      = true;
        s->start_ms     = t_ms;
        s->deadline_ms  = t_ms + (uint32_t)cfg->ramp.within_ms;

        ctx->rampStart_ms    = s->start_ms;
        ctx->rampDeadline_ms = s->deadline_ms;

        if (cfg->ramp.count_during) {
            ctx->accumulateStart_ms = s->start_ms;
        }
    }

    if (!s->started || s->complete) return;

    /* Track peak current inside ramp window */
    if (t_ms <= s->deadline_ms && I_mA > s->max_in_window) {
        s->max_in_window = I_mA;
    }

    ramp_thr = setpoint_mA * ((float)cfg->ramp.threshold_percent / 100.0f);

    /* Early success: threshold reached before deadline */
    if (s->reached_ms == 0u && I_mA >= ramp_thr) {
        s->reached_ms           = t_ms;
        ctx->rampReachedAt_ms   = t_ms;
        if (!cfg->ramp.count_during && ctx->accumulateStart_ms == (uint32_t)-1) {
            ctx->accumulateStart_ms = t_ms;
        }
    }

    /* Deadline: ramp phase ends regardless of whether threshold was reached */
    if (t_ms >= s->deadline_ms) {
        s->complete = true;
        if (ctx->accumulateStart_ms == (uint32_t)-1) {
            /* Threshold was never reached → start accumulating from deadline */
            ctx->accumulateStart_ms = s->deadline_ms;
        }
    }
}

bool StunningRamp_failed(const StunningRampState_t *s)
{
    return s->started && s->complete && (s->reached_ms == 0u);
}

/* =========================================================================
   SustainHandler
   ========================================================================= */

void StunningSustain_init(StunningSustainState_t *s)
{
    memset(s, 0, sizeof(*s));
}

void StunningSustain_update(
    StunningSustainState_t     *s,
    float                       I_mA,
    uint32_t                    t_ms,
    float                       nominal_mA,
    float                       setpoint_mA,
    const StunningAlgoConfig_t *cfg,
    StunningRuntimeCtx_t       *ctx)
{
    float warn_ref, fail_ref, warn_below, fail_below;
    float eff;
    uint32_t dt;

    /* Wait for the full ramp window (rampDeadline_ms), not the early-reach time.
     * This matches JS: canStart checks sample.t >= rampDeadline_s. */
    if (t_ms < ctx->rampDeadline_ms) return;

    /* Stop classifying after completion */
    if (ctx->completedAt_ms != (uint32_t)-1 && t_ms > ctx->completedAt_ms) return;

    if (!s->started) {
        s->started = true;
        s->prev_ms = t_ms;
        /* Fall through: first sample contributes dt=0 but can open a violation */
    }

    eff = ctx->effectiveI;  /* set by GlitchHandler; equals I_mA if no glitch step */
    dt  = t_ms - s->prev_ms;
    s->prev_ms = t_ms;

    warn_ref   = cfg->sustain.warn_use_nominal ? nominal_mA : setpoint_mA;
    fail_ref   = cfg->sustain.fail_use_nominal ? nominal_mA : setpoint_mA;
    warn_below = warn_ref * ((float)cfg->sustain.warn_percent  / 100.0f);
    fail_below = fail_ref * ((float)cfg->sustain.fail_percent  / 100.0f);

    /* Zone accumulation */
    if (dt > 0u) {
        if (cfg->sustain.fail_percent > 0u && eff < fail_below) {
            s->invalid_ms += dt;
        } else if (cfg->sustain.warn_percent > 0u && eff < warn_below) {
            s->warn_ms += dt;
        } else {
            s->ok_ms += dt;
        }
    }

    ctx->ok_ms      = s->ok_ms;
    ctx->warn_ms    = s->warn_ms;
    ctx->invalid_ms = s->invalid_ms;
}

/* =========================================================================
   DurationHandler
   ========================================================================= */

void StunningDuration_init(StunningDurationState_t *s)
{
    memset(s, 0, sizeof(*s));
}

void StunningDuration_update(
    StunningDurationState_t    *s,
    float                       I_mA,
    uint32_t                    t_ms,
    uint32_t                    prev_ms,
    float                       prev_I,
    float                       nominal_mA,
    float                       required_duration_s,
    uint8_t                     duration_threshold_percent,
    uint8_t                     current_threshold_percent,
    StunningRuntimeCtx_t       *ctx)
{
    float    current_thr = nominal_mA * ((float)current_threshold_percent / 100.0f);
    uint32_t acc_start   = ctx->accumulateStart_ms;
    uint32_t acc_dt;
    uint32_t required_ms;

    if (s->goal_reached) return;
    if (acc_start == (uint32_t)-1 || t_ms <= acc_start) return;

    acc_dt = (prev_ms < acc_start) ? (t_ms - acc_start) : (t_ms - prev_ms);

    if (I_mA >= current_thr && prev_I >= current_thr) {
        s->elapsed_ms += acc_dt;
    }

    required_ms = (uint32_t)(required_duration_s
                  * ((float)duration_threshold_percent / 100.0f) * 1000.0f);

    if (s->elapsed_ms >= required_ms) {
        s->goal_reached     = true;
        ctx->completedAt_ms = t_ms;
    }
}

/* =========================================================================
   IntegralHandler
   ========================================================================= */

void StunningIntegral_init(StunningIntegralState_t *s)
{
    memset(s, 0, sizeof(*s));
}

void StunningIntegral_update(
    StunningIntegralState_t    *s,
    float                       I_mA,
    uint32_t                    t_ms,
    uint32_t                    prev_ms,
    float                       prev_I,
    float                       nominal_mA,
    float                       setpoint_mA,
    float                       required_duration_s,
    const StunningAlgoConfig_t *cfg,
    StunningRuntimeCtx_t       *ctx)
{
    uint32_t acc_start = ctx->accumulateStart_ms;
    uint32_t acc_dt;
    float    limit_val, cutoff, target, dt_s, e0, e1;

    if (s->goal_reached) return;
    if (acc_start == (uint32_t)-1 || t_ms <= acc_start) return;

    acc_dt = (prev_ms < acc_start) ? (t_ms - acc_start) : (t_ms - prev_ms);

    limit_val = cfg->completion.integral.limit_to_nominal ? nominal_mA : setpoint_mA;
    cutoff    = limit_val * ((float)cfg->completion.integral.cutoff_percent / 100.0f);
    target    = required_duration_s * limit_val
                * ((float)cfg->completion.integral.completion_threshold_percent / 100.0f);

    dt_s = (float)acc_dt / 1000.0f;
    e0   = (prev_I  >= cutoff) ? MINF(prev_I,  limit_val) : 0.0f;
    e1   = (I_mA    >= cutoff) ? MINF(I_mA,    limit_val) : 0.0f;
    s->charge_mAs += ((e0 + e1) / 2.0f) * dt_s;

    if (s->charge_mAs >= target) {
        s->goal_reached     = true;
        ctx->completedAt_ms = t_ms;
    }
}

/* =========================================================================
   InvalidTimeoutHandler
   ========================================================================= */

void StunningInvalidTimeout_init(StunningInvalidTimeoutState_t *s)
{
    memset(s, 0, sizeof(*s));
}

void StunningInvalidTimeout_check(
    StunningInvalidTimeoutState_t *s,
    const StunningRuntimeCtx_t    *ctx,
    uint16_t                       max_invalid_ms)
{
    if (ctx->invalid_ms > (uint32_t)max_invalid_ms) {
        s->timed_out = true;
    }
}

/* =========================================================================
   TotalTimeoutHandler
   ========================================================================= */

void StunningTotalTimeout_init(StunningTotalTimeoutState_t *s)
{
    memset(s, 0, sizeof(*s));
}

void StunningTotalTimeout_update(
    StunningTotalTimeoutState_t *s,
    uint32_t                     t_ms)
{
    if (s->first_ms == 0u) {
        s->first_ms = t_ms;
    }
}

void StunningTotalTimeout_check(
    StunningTotalTimeoutState_t *s,
    uint32_t                     t_ms,
    float                        required_duration_s,
    float                        factor)
{
    uint32_t total_ms, limit_ms;
    if (s->first_ms == 0u || required_duration_s <= 0.0f) return;
    total_ms = t_ms - s->first_ms;
    limit_ms = (uint32_t)(required_duration_s * factor * 1000.0f);
    if (total_ms > limit_ms) {
        s->timed_out = true;
    }
}

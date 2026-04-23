/* StunningHandlers.h
 * Static file -- tracked in version control, NOT generated.
 *
 * Per-step stateful handlers for the stunning algorithm DSL.
 * Each handler owns its own state struct and exposes init + update functions.
 * Handlers communicate through StunningRuntimeCtx_t (the shared bus).
 *
 * Handler names mirror the JS exports in StunningEvaluationEngine.js:
 *   StunningGlitch_        ↔  GlitchHandler
 *   StunningRamp_          ↔  RampHandler
 *   StunningSustain_       ↔  SustainHandler
 *   StunningDuration_      ↔  DurationHandler
 *   StunningIntegral_      ↔  IntegralHandler
 *   StunningInvalidTimeout_↔  InvalidTimeoutHandler
 *   StunningTotalTimeout_  ↔  TotalTimeoutHandler
 */
#ifndef STUNNING_HANDLERS_H
#define STUNNING_HANDLERS_H

#include "StunningRuntimeCtx.h"
#include "StunningAlgoConfig.h"
#include <stdint.h>
#include <stdbool.h>

/* =========================================================================
   GlitchHandler — forgive sub-nominal dips shorter than max_gap_ms
   Writes: ctx->effectiveI
   ========================================================================= */

typedef struct {
    bool     active;
    uint32_t start_ms;   /**< prev_ms of the sample where current first fell  */
    float    hold_mA;    /**< current value just before the dip started        */
} StunningGlitchState_t;

void StunningGlitch_init(StunningGlitchState_t *s);

/**
 * @param prev_ms   time_ms of the previous sample (used to capture full gap)
 * @param prev_I    current_mA of the previous sample
 */
void StunningGlitch_update(
    StunningGlitchState_t      *s,
    float                       I_mA,
    uint32_t                    t_ms,
    uint32_t                    prev_ms,
    float                       prev_I,
    float                       nominal_mA,
    uint32_t                    max_gap_ms,
    StunningRuntimeCtx_t       *ctx);

/* =========================================================================
   RampHandler — verify current reaches setpoint threshold within window
   Writes: ctx->rampStart_ms, ctx->rampDeadline_ms, ctx->rampReachedAt_ms,
           ctx->accumulateStart_ms
   ========================================================================= */

typedef struct {
    bool     started;
    bool     complete;
    uint32_t start_ms;
    uint32_t deadline_ms;    /**< start_ms + within_ms (always the full window) */
    uint32_t reached_ms;     /**< time threshold first reached (0 = not yet)    */
    float    max_in_window;  /**< peak current seen while ramp is active         */
} StunningRampState_t;

void StunningRamp_init(StunningRampState_t *s);

void StunningRamp_update(
    StunningRampState_t        *s,
    float                       I_mA,
    uint32_t                    t_ms,
    float                       setpoint_mA,
    const StunningAlgoConfig_t *cfg,   /**< reads cfg->ramp.*                   */
    StunningRuntimeCtx_t       *ctx);

/** True if ramp was started but threshold was never reached within the window */
bool StunningRamp_failed(const StunningRampState_t *s);

/* =========================================================================
   SustainHandler — zone classification after ramp deadline
   Reads:  ctx->rampDeadline_ms, ctx->effectiveI, ctx->completedAt_ms
   Writes: ctx->ok_ms, ctx->warn_ms, ctx->invalid_ms
   ========================================================================= */

typedef struct {
    bool     started;
    uint32_t prev_ms;
    uint32_t open_warn_start_ms;   /**< 0 = no open warn violation              */
    uint32_t open_fail_start_ms;   /**< 0 = no open fail violation              */
    uint32_t ok_ms;
    uint32_t warn_ms;
    uint32_t invalid_ms;
} StunningSustainState_t;

void StunningSustain_init(StunningSustainState_t *s);

void StunningSustain_update(
    StunningSustainState_t     *s,
    float                       I_mA,
    uint32_t                    t_ms,
    float                       nominal_mA,
    float                       setpoint_mA,
    const StunningAlgoConfig_t *cfg,   /**< reads cfg->sustain.*                */
    StunningRuntimeCtx_t       *ctx);

/* =========================================================================
   DurationHandler — accumulate time above nominal until required duration met
   Reads:  ctx->accumulateStart_ms
   Writes: ctx->completedAt_ms
   ========================================================================= */

typedef struct {
    uint32_t elapsed_ms;      /**< accumulated above-nominal time              */
    bool     goal_reached;
} StunningDurationState_t;

void StunningDuration_init(StunningDurationState_t *s);

void StunningDuration_update(
    StunningDurationState_t    *s,
    float                       I_mA,
    uint32_t                    t_ms,
    uint32_t                    prev_ms,
    float                       prev_I,
    float                       nominal_mA,
    float                       required_duration_s,
    uint8_t                     threshold_percent,   /**< cfg->completion.duration_threshold_percent */
    StunningRuntimeCtx_t       *ctx);

/* =========================================================================
   IntegralHandler — accumulate mA·s charge until target met
   Reads:  ctx->accumulateStart_ms
   Writes: ctx->completedAt_ms
   ========================================================================= */

typedef struct {
    float charge_mAs;     /**< accumulated charge integral                     */
    bool  goal_reached;
} StunningIntegralState_t;

void StunningIntegral_init(StunningIntegralState_t *s);

void StunningIntegral_update(
    StunningIntegralState_t    *s,
    float                       I_mA,
    uint32_t                    t_ms,
    uint32_t                    prev_ms,
    float                       prev_I,
    float                       nominal_mA,
    float                       setpoint_mA,
    float                       required_duration_s,
    const StunningAlgoConfig_t *cfg,   /**< reads cfg->completion.integral.*   */
    StunningRuntimeCtx_t       *ctx);

/* =========================================================================
   InvalidTimeoutHandler — fail if cumulative INVALID zone exceeds limit
   Reads:  ctx->invalid_ms
   ========================================================================= */

typedef struct {
    bool timed_out;
} StunningInvalidTimeoutState_t;

void StunningInvalidTimeout_init(StunningInvalidTimeoutState_t *s);

void StunningInvalidTimeout_check(
    StunningInvalidTimeoutState_t *s,
    const StunningRuntimeCtx_t    *ctx,
    uint16_t                       max_invalid_ms);

/* =========================================================================
   TotalTimeoutHandler — fail if total elapsed exceeds factor × required
   ========================================================================= */

typedef struct {
    uint32_t first_ms;   /**< time_ms of first sample seen (0 = not yet)       */
    bool     timed_out;
} StunningTotalTimeoutState_t;

void StunningTotalTimeout_init(StunningTotalTimeoutState_t *s);

void StunningTotalTimeout_update(
    StunningTotalTimeoutState_t *s,
    uint32_t                     t_ms);

void StunningTotalTimeout_check(
    StunningTotalTimeoutState_t *s,
    uint32_t                     t_ms,
    float                        required_duration_s,
    float                        factor);

#endif /* STUNNING_HANDLERS_H */

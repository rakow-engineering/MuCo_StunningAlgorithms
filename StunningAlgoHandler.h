/* StunningAlgoHandler.h
 * Static file -- tracked in version control, NOT generated.
 *
 * Top-level coordinator: owns one instance of every per-step handler state and
 * the shared StunningRuntimeCtx_t bus.  Delegates each sample to the appropriate
 * handlers in step order.
 *
 * Public API is unchanged from V10 — callers only see init / update / getDetail.
 */
#ifndef STUNNING_ALGO_HANDLER_H
#define STUNNING_ALGO_HANDLER_H

#include "StunningAlgoConfig.h"
#include "StunningHandlers.h"
#include "StunningRuntimeCtx.h"
#include "StunningResult.h"   /* STUNNING_RESULT_t -- V10.x public header, unchanged */
#include <stdint.h>
#include <stdbool.h>

/**
 * Extended result detail — NOT in the V10 StunningResult.h public API.
 */
typedef struct {
    uint32_t stunning_elapsed_ms;
    uint32_t total_elapsed_ms;
    uint32_t VALID_elapsed_ms;
    uint32_t OK_elapsed_ms;
    uint32_t UNSHURE_elapsed_ms;
    uint32_t INVALID_elapsed_ms;
    float    charge_integral_mAs;
} STUNNING_RESULT_detail_t;

/**
 * Per-event state.  Allocate one per channel / stunning event.
 * Initialise with StunningAlgo_init() before each new event.
 */
typedef struct {
    /* ---- Shared runtime context (handler communication bus) ---- */
    StunningRuntimeCtx_t            ctx;

    /* ---- Per-step handler states ---- */
    StunningGlitchState_t           glitch;
    StunningRampState_t             ramp;
    StunningSustainState_t          sustain;
    StunningDurationState_t         duration;
    StunningIntegralState_t         integral;
    StunningInvalidTimeoutState_t   inv_timeout;
    StunningTotalTimeoutState_t     tot_timeout;

    /* ---- Top-level timing ---- */
    uint32_t setup_ms;       /**< time_ms of first sample                     */
    uint32_t prev_ms;        /**< time_ms of previous sample                  */
    float    prev_I;         /**< current_mA of previous sample               */
    bool     first_sample;

    /* ---- Cached result ---- */
    STUNNING_RESULT_t result;
} StunningAlgoState_t;

/** Reset state before a new stunning event. */
void StunningAlgo_init(StunningAlgoState_t *state);

/**
 * Process one sample.  Updates all running counters and returns the
 * current evaluation result.
 */
STUNNING_RESULT_t StunningAlgo_update(
    StunningAlgoState_t        *state,
    const StunningAlgoConfig_t *cfg,
    float                       current_mA,
    uint32_t                    time_ms,
    float                       nominal_mA,
    float                       setpoint_mA,
    float                       required_duration_s);

/**
 * Fill a detail struct from the current state for reporting.
 * May be called at any time; does not modify state.
 */
void StunningAlgo_getDetail(
    const StunningAlgoState_t *state,
    uint32_t                   time_ms,
    STUNNING_RESULT_detail_t  *detail);

#endif /* STUNNING_ALGO_HANDLER_H */

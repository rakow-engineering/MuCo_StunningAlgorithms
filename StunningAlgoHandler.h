/* StunningAlgoHandler.h
 * Static file -- tracked in version control, NOT generated.
 *
 * Per-sample stateful evaluation engine for the stunning current algorithm.
 * No sample buffer: each call to StunningAlgo_update() advances running
 * counters in place and returns the current result.  Memory footprint is
 * constant regardless of how long the stunning takes.
 *
 * Typical usage (called from StunningResult_tick()):
 *
 *   StunningAlgo_init(&state);
 *
 *   // once per 10 ms tick:
 *   result = StunningAlgo_update(&state, cfg,
 *                                current_mA, elapsed_ms,
 *                                nominal_mA, setpoint_mA, required_s);
 *
 *   // for reporting / result display:
 *   StunningAlgo_getDetail(&state, elapsed_ms, &detail);
 */
#ifndef STUNNING_ALGO_HANDLER_H
#define STUNNING_ALGO_HANDLER_H

#include "StunningAlgoConfig.h"
#include "StunningResult.h"   /* STUNNING_RESULT_t -- V10.x public header, unchanged */
#include <stdint.h>
#include <stdbool.h>

/**
 * Extended result detail -- NOT in the V10 StunningResult.h public API.
 * Used internally and for result reporting / debug output only.
 * Field names match the internal variables in StunningResult.c V10.x.
 */
typedef struct {
    uint32_t stunning_elapsed_ms;  /**< effective stunning time (OK + TOLERATED)    */
    uint32_t total_elapsed_ms;     /**< total elapsed since setup()                 */
    uint32_t VALID_elapsed_ms;     /**< OK + TOLERATED                              */
    uint32_t OK_elapsed_ms;        /**< time in AREA OK        (>= setpoint)        */
    uint32_t UNSHURE_elapsed_ms;   /**< time in AREA TOLERATED (>= nominal, < set.) */
    uint32_t INVALID_elapsed_ms;   /**< time in AREA INVALID   (< nominal)          */
    float    charge_integral_mAs;  /**< mA*s integral (charge_integral algo only)   */
} STUNNING_RESULT_detail_t;

/**
 * Per-event state.  Allocate one per channel / stunning event.
 * Initialise with StunningAlgo_init() before each new event.
 * ~64 bytes on a 32-bit target.
 */
typedef struct {
    /* --- timing --- */
    uint32_t setup_ms;          /**< time_ms of first sample (set on first update) */
    uint32_t prev_ms;           /**< time_ms of previous sample                    */
    float    prev_I;            /**< current_mA of previous sample                 */
    bool     first_sample;      /**< true until first update() call                */

    /* --- ramp detection --- */
    bool     ramp_started;      /**< current exceeded ramp.start_mA                */
    bool     ramp_complete;     /**< ramp phase ended (threshold reached or timeout)*/
    bool     ramp_failed;       /**< threshold was not reached within window        */
    uint32_t ramp_start_ms;     /**< time when ramp started                        */
    uint32_t ramp_end_ms;       /**< time when ramp phase ended                    */
    uint32_t accumulate_start_ms; /**< when duration/integral accumulation begins  */

    /* --- glitch filter --- */
    bool     glitch_active;     /**< currently inside a potential glitch gap        */
    uint32_t glitch_start_ms;   /**< time_ms when current first dropped below nominal*/
    float    glitch_hold_mA;    /**< effective current to apply if glitch is forgiven*/

    /* --- zone counters (names match StunningResult.c internal variables) --- */
    uint32_t OK_elapsed_ms;       /**< AREA OK:        I >= warn_below             */
    uint32_t UNSHURE_elapsed_ms;  /**< AREA TOLERATED: fail_below <= I < warn_below*/
    uint32_t INVALID_elapsed_ms;  /**< AREA INVALID:   I < fail_below              */

    /* --- completion accumulators --- */
    uint32_t stunning_elapsed_ms; /**< effective duration above nominal (use_duration)*/
    float    charge_integral_mAs; /**< mA*s integral (use_integral)                  */
    bool     goal_reached;        /**< true once duration or integral target was met  */

    /* --- fault flags --- */
    bool     ramp_flag;           /**< ramp did not reach threshold in time           */
    bool     timeout_invalid;     /**< INVALID_elapsed exceeded timeouts.invalid_ms   */
    bool     timeout_total;       /**< total elapsed exceeded factor * required        */

    /* --- cached result (updated every update() call) --- */
    STUNNING_RESULT_t result;
} StunningAlgoState_t;

/**
 * Reset state before a new stunning event.
 */
void StunningAlgo_init(StunningAlgoState_t *state);

/**
 * Process one sample.  Updates all running counters and returns the
 * current evaluation result.
 *
 * Glitch filter note: short dips below nominal (< glitch.max_gap_ms) are
 * forgiven for ZONE CLASSIFICATION only.  Duration and integral accumulators
 * always use actual current so that real dips extend the required time.
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

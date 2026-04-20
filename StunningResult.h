#ifndef __STUNNING_RESULT_H__
#define __STUNNING_RESULT_H__
/**
************************************************************************************************************************
*
*         @file StunningResult.h
*
*        @brief Evaluates the stunning process and determines the final result.
*               Algorithm behaviour is selected at runtime via StunningResult_setAlgorithm().
*
*       @author Rainer Rakow (Ersteller)
*
************************************************************************************************************************
*
*    Copyright: (C) 2019 Rakow Engineering
*
***********************************************************************************************************************/

#include <stdint.h>
#include <stdbool.h>

/* ---- Result type -- identical to V10.x ---- */
typedef enum
{
  STUNNING_RESULT_NONE           = 0,
  STUNNING_RESULT_IDLE           = 1,
  STUNNING_RESULT_OK             = 2,
  STUNNING_RESULT_UNSHURE        = 3,
  STUNNING_RESULT_FAIL           = 4,
  STUNNING_RESULT_ABORT_WO_ERROR = 5,
} STUNNING_RESULT_t;

/* ---- V10.x public API -- unchanged ---- */

extern void StunningResult_init(void);

extern void StunningResult_setup(uint32_t timeout_ms);

extern void StunningResult_stop(void);

extern bool              StunningResult_is_started(void);
extern bool              StunningResult_is_finished(void);
extern uint32_t          StunningResult_getElapsedTime_ms(void);
extern STUNNING_RESULT_t StunningResult_get(void);

/* ---- Extensions (not in V10.x, do not break existing callers) ---- */

/* Forward declarations -- full types defined in StunningAlgoHandler.h */
struct StunningAlgoConfig_s;
struct STUNNING_RESULT_detail_s;

/**
 * Feed one measurement sample into the evaluation engine.
 *
 * In production this is called from the HMI measurement settings observer
 * each time a new sample arrives.  In unit tests it is called directly with
 * explicit values to drive the algorithm without any platform dependencies.
 *
 * Does nothing when not running (not started, or already finished).
 *
 * @param current_mA   Measured current in mA
 * @param timestamp_ms Absolute system tick in ms (monotonically increasing).
 *                     The first call after StunningResult_setup() establishes
 *                     the time reference; subsequent calls are relative to it.
 */
extern void StunningResult_update(uint16_t current_mA, uint32_t timestamp_ms);

/**
 * Select the active algorithm configuration.
 * Takes effect on the next StunningResult_setup() call.
 * Pass a pointer to one of the generated STUNNING_ALGO_<ID> constants.
 */
extern void StunningResult_setAlgorithm(const struct StunningAlgoConfig_s *cfg);

/**
 * Return extended zone counters from the last (or current) evaluation.
 * detail must point to a STUNNING_RESULT_detail_t (from StunningAlgoHandler.h).
 */
extern void StunningResult_getDetail(struct STUNNING_RESULT_detail_s *detail);

/* ********************************************************************************************************************/
#endif /* __STUNNING_RESULT_H__ */

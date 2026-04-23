/* StunningRuntimeCtx.h
 * Static file -- tracked in version control, NOT generated.
 *
 * Shared runtime context bus passed to every per-step handler on each sample.
 * Each handler reads fields written by upstream handlers and writes its own.
 * Mirrors the JS runtimeCtx object in StunningEvaluationEngine.js.
 *
 * Field ownership:
 *   effectiveI        -- written by GlitchHandler, read by SustainHandler
 *   rampStart_ms      -- written by RampHandler
 *   rampDeadline_ms   -- written by RampHandler, read by SustainHandler (guard)
 *   rampReachedAt_ms  -- written by RampHandler (0 = not reached yet)
 *   accumulateStart_ms-- written by RampHandler, read by Duration/IntegralHandler
 *   completedAt_ms    -- written by Duration/IntegralHandler (UINT32_MAX = not yet)
 *   ok_ms/warn_ms/invalid_ms -- written by SustainHandler, read by InvalidTimeoutHandler
 */
#ifndef STUNNING_RUNTIME_CTX_H
#define STUNNING_RUNTIME_CTX_H

#include <stdint.h>
#include <stdbool.h>

typedef struct {
    float    effectiveI;         /**< glitch-adjusted current for zone classification  */
    uint32_t rampStart_ms;       /**< time when ramp started                           */
    uint32_t rampDeadline_ms;    /**< rampStart_ms + within_ms (full window boundary)  */
    uint32_t rampReachedAt_ms;   /**< time threshold was first reached (0 = not yet)   */
    uint32_t accumulateStart_ms; /**< when completion accumulation begins               */
    uint32_t completedAt_ms;     /**< time goal was met (UINT32_MAX = not yet)          */
    uint32_t ok_ms;              /**< cumulative OK-zone time                           */
    uint32_t warn_ms;            /**< cumulative WARN-zone time                         */
    uint32_t invalid_ms;         /**< cumulative INVALID-zone time                      */
} StunningRuntimeCtx_t;

/**
 * Initialise the context for a new evaluation run.
 *
 * @param hasRamp  true when the algorithm spec contains a ramp_to_threshold step.
 *                 false → rampDeadline_ms and accumulateStart_ms are set to 0 so
 *                 monitoring and accumulation begin immediately on the first sample.
 */
void StunningRuntimeCtx_init(StunningRuntimeCtx_t *ctx, bool hasRamp);

#endif /* STUNNING_RUNTIME_CTX_H */

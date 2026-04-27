/* StunningAlgoConfig.h
 * Static file -- tracked in version control, NOT generated.
 *
 * Defines the runtime-selectable algorithm configuration struct.
 * Pass a pointer to a const StunningAlgoConfig_t to StunningAlgo_update().
 *
 * Config constants are generated from JSON specs by emitStunningEvalC.py.
 * This header only changes when a new DSL op type is added.
 *
 * No dependency on StunningResult.h -- intentionally standalone so it can
 * be included in generated config files without pulling in the full module.
 */
#ifndef STUNNING_ALGO_CONFIG_H
#define STUNNING_ALGO_CONFIG_H

#include <stdint.h>
#include <stdbool.h>

/**
 * All parameters for one algorithm variant, derived from the JSON spec.
 *
 * Runtime threshold values (nominal_mA, setpoint_mA, required_duration_s)
 * are NOT stored here -- they are supplied as arguments to StunningAlgo_update()
 * so the same config constant works across different equipment setpoints.
 */
typedef struct {

    /** Identity -- generated from JSON spec fields numeric_id / display_name */
    struct {
        uint16_t    id;           /**< unique numeric algorithm ID (from JSON numeric_id) */
        const char *display_name; /**< human-readable name (from JSON display_name)       */
    } meta;

    /** merge_below_ms: short sub-nominal dips are forgiven for zone detection */
    struct {
        bool     enabled;       /**< apply glitch filter                      */
        uint16_t max_gap_ms;    /**< gaps shorter than this (ms) are forgiven */
    } glitch;

    /** ramp_to_threshold: current must reach setpoint within a time window */
    struct {
        bool     enabled;           /**< ramp check active                        */
        uint16_t within_ms;         /**< ramp must reach threshold within this    */
        float    start_mA;          /**< first sample above this starts ramp timer*/
        uint8_t  threshold_percent; /**< percent of setpoint_mA to reach          */
        bool     count_during;      /**< accumulate from ramp start (not end)      */
    } ramp;

    /** sustain_thresholds: zone classification after ramp */
    struct {
        bool    enabled;          /**< false = skip zone monitoring entirely       */
        bool    warn_use_nominal; /**< false = warn ref is setpoint_mA (default)  */
                                  /**< true  = warn ref is nominal_mA             */
        uint8_t warn_percent;     /**< percent of ref value; 0 = warn disabled    */
        bool    fail_use_nominal; /**< false = fail ref is setpoint_mA            */
                                  /**< true  = fail ref is nominal_mA  (default)  */
        uint8_t fail_percent;     /**< percent of ref value; 0 = fail disabled    */
    } sustain;

    /** Completion goal: exactly one of use_duration / use_integral should be true */
    struct {
        bool    use_duration;                          /**< min_duration_above active                   */
        uint8_t duration_threshold_percent;            /**< % of required_duration_s to reach (1-100)   */
        uint8_t duration_current_threshold_percent;    /**< % of nominal_mA used as current threshold   */
        bool    use_integral;                 /**< charge_integral active                  */

        /** Parameters only used when use_integral is true */
        struct {
            bool    limit_to_nominal;           /**< false = limit to setpoint_mA (default) */
            uint8_t cutoff_percent;             /**< percent of limit; below → not counted  */
            uint8_t completion_threshold_percent; /**< % of target integral to reach (1-100) */
        } integral;
    } completion;

    /** Timeout checks */
    struct {
        bool     check_invalid; /**< fail if INVALID zone exceeds invalid_ms    */
        uint16_t invalid_ms;    /**< max cumulative INVALID time allowed         */
        bool     check_total;   /**< fail if total elapsed > factor * required   */
        float    total_factor;  /**< multiplier for total timeout                */
    } timeouts;

} StunningAlgoConfig_t;

#endif /* STUNNING_ALGO_CONFIG_H */

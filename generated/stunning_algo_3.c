/* Auto-generated from 3 -- DO NOT EDIT
 * Strom-Zeit-Integral
 */
#include "stunning_algo_3.h"

const StunningAlgoConfig_t STUNNING_ALGO_3 = {
    .meta = {
        .id           = 3u,
        .display_name = "Strom-Zeit-Integral",
    },
    .glitch = {
        .enabled    = true,
        .max_gap_ms = 200,
    },
    .ramp = {
        .enabled           = true,
        .within_ms         = 1000,
        .start_mA          = 0.2f,
        .threshold_percent = 70u,
        .count_during      = true,
    },
    .sustain = {
        .enabled          = true,
        .warn_use_nominal = false,
        .warn_percent     = 70u,
        .fail_use_nominal = true,
        .fail_percent     = 0u,
    },
    .completion = {
        .use_duration                       = false,
        .duration_threshold_percent         = 100u,
        .duration_current_threshold_percent = 100u,
        .use_integral               = true,
        .integral = {
            .limit_to_nominal             = false,
            .cutoff_percent               = 70u,
            .completion_threshold_percent = 100u,
        },
    },
    .timeouts = {
        .check_invalid = true,
        .invalid_ms    = 500,
        .check_total   = true,
        .total_factor  = 3.0f,
    },
};

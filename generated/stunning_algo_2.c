/* Auto-generated from 2 -- DO NOT EDIT
 * Standard
 */
#include "stunning_algo_2.h"

const StunningAlgoConfig_t STUNNING_ALGO_2 = {
    .meta = {
        .id           = 2u,
        .display_name = "Standard",
    },
    .glitch = {
        .enabled    = true,
        .max_gap_ms = 100,
    },
    .ramp = {
        .enabled           = true,
        .within_ms         = 1000,
        .start_mA          = 10.0f,
        .threshold_percent = 100u,
        .count_during      = false,
    },
    .sustain = {
        .enabled          = true,
        .warn_use_nominal = false,
        .warn_percent     = 100u,
        .fail_use_nominal = true,
        .fail_percent     = 100u,
    },
    .completion = {
        .use_duration                       = true,
        .duration_threshold_percent         = 100u,
        .duration_current_threshold_percent = 100u,
        .use_integral               = false,
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

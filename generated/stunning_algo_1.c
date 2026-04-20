/* Auto-generated from 1 -- DO NOT EDIT
 * Embedded V10: Rampe 1s, Mindestdauer >= nominal
 */
#include "stunning_algo_1.h"

const StunningAlgoConfig_t STUNNING_ALGO_1 = {
    .meta = {
        .id           = 1u,
        .display_name = "Embedded V10: Rampe 1s, Mindestdauer >= nominal",
    },
    .glitch = {
        .enabled    = false,
        .max_gap_ms = 0,
    },
    .ramp = {
        .enabled           = true,
        .within_ms         = 1000,
        .start_mA          = 0.0f,
        .threshold_percent = 100u,
        .count_during      = false,
    },
    .sustain = {
        .warn_use_nominal = false,
        .warn_percent     = 100u,
        .fail_use_nominal = true,
        .fail_percent     = 100u,
    },
    .completion = {
        .use_duration = true,
        .use_integral = false,
        .integral = {
            .limit_to_nominal = false,
            .cutoff_percent   = 70u,
        },
    },
    .timeouts = {
        .check_invalid = true,
        .invalid_ms    = 500,
        .check_total   = true,
        .total_factor  = 3.0f,
    },
};

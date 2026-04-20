/* Auto-generated -- DO NOT EDIT
 * Registry of all known stunning algorithm configs.
 * Look up by index or by cfg->meta.id.
 */
#ifndef STUNNING_ALGO_REGISTRY_H
#define STUNNING_ALGO_REGISTRY_H

#include "StunningAlgoConfig.h"
#include "stunning_algo_1.h"
#include "stunning_algo_2.h"
#include "stunning_algo_3.h"

/**
 * Pointer array of all registered algorithm configs, ordered by numeric_id.
 * Entry i: STUNNING_ALGO_REGISTRY[i]->meta.id gives the numeric ID.
 */
extern const StunningAlgoConfig_t * const STUNNING_ALGO_REGISTRY[];

/** Number of entries in STUNNING_ALGO_REGISTRY. */
extern const uint16_t STUNNING_ALGO_REGISTRY_COUNT;

#endif /* STUNNING_ALGO_REGISTRY_H */

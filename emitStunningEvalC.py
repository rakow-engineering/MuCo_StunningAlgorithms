#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
emitStunningEvalC.py  --  Python 2.7/3 compatible config-struct generator.

Reads one or more stunning evaluation algorithm specs (JSON-DSL) and generates:

  Per-algorithm (one set per spec):
    stunning_algo_<id>.h  -- extern const StunningAlgoConfig_t <NAME>
    stunning_algo_<id>.c  -- const initializer with all algorithm parameters

  Common registry (generated when all specs are given together):
    stunning_algo_registry.h  -- includes all headers, declares registry array
    stunning_algo_registry.c  -- defines the registry array

The static evaluation logic lives in separate hand-maintained files that are
tracked in version control alongside this script:

  StunningAlgoConfig.h    -- StunningAlgoConfig_t typedef
  StunningAlgoHandler.h   -- StunningAlgo_init / update / getDetail declarations
  StunningAlgoHandler.c   -- Per-sample stateful evaluation (no sample buffer)

Copy all four files to the embedded project; regenerate only the algo files
when the JSON spec changes.

Usage:
    python emitStunningEvalC.py <spec1.json> [spec2.json ...] [outDir]

    The last argument is treated as outDir if it does not end in '.json'.
    If omitted, outDir defaults to the current working directory.

Example:
    python emitStunningEvalC.py algorithms/stunning_embedded_v10.json \\
                                algorithms/stunning_current_v1.json   \\
                                algorithms/stunning_current_integral_v1.json \\
                                out/
"""
from __future__ import print_function, division

import json
import os
import sys
import io

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _const_name(algo_id):
    return 'STUNNING_ALGO_{0}'.format(algo_id)

def _guard(algo_id):
    return 'STUNNING_ALGO_{0}_H'.format(algo_id)

def _pct_or_0(step, key, default=100):
    """Return integer percent value, or 0 if the field is null/missing (= disabled)."""
    v = step.get(key, default)
    return 0 if v is None else int(v)

def _escape_c_string(s):
    """Escape a Python unicode string for use inside a C string literal."""
    return s.replace('\\', '\\\\').replace('"', '\\"')

# ---------------------------------------------------------------------------
# Per-spec config header  (extern declaration)
# ---------------------------------------------------------------------------

def generate_config_h(spec):
    algo_id    = int(spec['algorithm_id'])
    guard      = _guard(algo_id)
    const_name = _const_name(algo_id)
    return (
        u'/* Auto-generated -- algorithm_id={id} -- DO NOT EDIT */\n'
        u'#ifndef {guard}\n'
        u'#define {guard}\n'
        u'#include "StunningAlgoConfig.h"\n'
        u'extern const StunningAlgoConfig_t {name};\n'
        u'#endif /* {guard} */\n'
    ).format(id=algo_id, guard=guard, name=const_name)

# ---------------------------------------------------------------------------
# Per-spec config source  (const initializer)
# ---------------------------------------------------------------------------

def _bool(val):
    return 'true' if val else 'false'

def _ms(seconds, default=0):
    return '{0}u'.format(int(round(seconds * 1000)) if seconds is not None else default)

def generate_config_c(spec):
    algo_id      = int(spec['algorithm_id'])
    display_name = spec.get('display_name', str(algo_id))
    const_name   = _const_name(algo_id)
    h_name       = 'stunning_algo_{0}.h'.format(algo_id)

    # Index steps by op name (first occurrence wins)
    ops = {}
    for s in spec.get('steps', []):
        op = s.get('op', '')
        if op not in ops:
            ops[op] = s

    merge    = ops.get('merge_below_ms',    {})
    ramp     = ops.get('ramp_to_threshold', {})
    sustain  = ops.get('sustain_thresholds',{})
    duration = ops.get('min_duration_above',{})
    integral = ops.get('charge_integral',   {})
    inv_t    = ops.get('invalid_timeout',   {})
    tot_t    = ops.get('total_timeout',     {})

    limit_to         = integral.get('limit_to', 'setpoint_mA') if integral else 'setpoint_mA'
    limit_to_nominal = limit_to in ('nominal_mA', 'A', 'nominal')

    # Build lines using plain braces -- this string is a value, not a format template
    L = []
    L.append(u'    .meta = {')
    L.append(u'        .id           = {0}u,'.format(algo_id))
    L.append(u'        .display_name = "{0}",'.format(_escape_c_string(display_name)))
    L.append(u'    },')

    L.append(u'    .glitch = {')
    L.append(u'        .enabled    = {0},'.format(_bool(bool(merge))))
    L.append(u'        .max_gap_ms = {0},'.format(int(merge.get('max_gap_ms', 100)) if merge else 0))
    L.append(u'    },')

    L.append(u'    .ramp = {')
    L.append(u'        .enabled           = {0},'.format(_bool(bool(ramp))))
    L.append(u'        .within_ms         = {0},'.format(int(round(ramp.get('within_s', 1.0) * 1000)) if ramp else 1000))
    L.append(u'        .start_mA          = {0}f,'.format(float(ramp.get('ramp_start_mA', 10.0))))
    L.append(u'        .threshold_percent = {0}u,'.format(int(ramp.get('current_threshold_percent', 100))))
    L.append(u'        .count_during      = {0},'.format(_bool(ramp.get('count_during_ramp', False))))
    L.append(u'    },')

    warn_ref = sustain.get('warn_below', 'setpoint_mA') if sustain else 'setpoint_mA'
    fail_ref = sustain.get('fail_below', 'nominal_mA')  if sustain else 'nominal_mA'
    L.append(u'    .sustain = {')
    L.append(u'        .warn_use_nominal = {0},'.format(_bool(warn_ref == 'nominal_mA')))
    L.append(u'        .warn_percent     = {0}u,'.format(_pct_or_0(sustain, 'warn_below_threshold_percent', 100) if sustain else 0))
    L.append(u'        .fail_use_nominal = {0},'.format(_bool(fail_ref == 'nominal_mA')))
    L.append(u'        .fail_percent     = {0}u,'.format(_pct_or_0(sustain, 'fail_below_threshold_percent', 100) if sustain else 0))
    L.append(u'    },')

    L.append(u'    .completion = {')
    L.append(u'        .use_duration = {0},'.format(_bool(bool(duration))))
    L.append(u'        .use_integral = {0},'.format(_bool(bool(integral))))
    L.append(u'        .integral = {')
    L.append(u'            .limit_to_nominal = {0},'.format(_bool(limit_to_nominal)))
    L.append(u'            .cutoff_percent   = {0}u,'.format(int(integral.get('current_threshold_percent', 70)) if integral else 70))
    L.append(u'        },')
    L.append(u'    },')

    L.append(u'    .timeouts = {')
    L.append(u'        .check_invalid = {0},'.format(_bool(bool(inv_t))))
    L.append(u'        .invalid_ms    = {0},'.format(int(round(inv_t.get('max_invalid_s', 0.0) * 1000)) if inv_t else 0))
    L.append(u'        .check_total   = {0},'.format(_bool(bool(tot_t))))
    L.append(u'        .total_factor  = {0}f,'.format(float(tot_t.get('factor', 3.0)) if tot_t else 3.0))
    L.append(u'    },')

    lines = u'\n'.join(L) + u'\n'

    return (
        u'/* Auto-generated from {id} -- DO NOT EDIT\n'
        u' * {display}\n'
        u' */\n'
        u'#include "{h}"\n'
        u'\n'
        u'const StunningAlgoConfig_t {name} = {{\n'
        u'{lines}'
        u'}};\n'
    ).format(id=algo_id, display=display_name, h=h_name, name=const_name, lines=lines)

# ---------------------------------------------------------------------------
# Common registry header + source (generated from all specs together)
# ---------------------------------------------------------------------------

def generate_registry_h(specs):
    includes = u''.join(
        u'#include "stunning_algo_{0}.h"\n'.format(int(s['algorithm_id']))
        for s in specs
    )
    return (
        u'/* Auto-generated -- DO NOT EDIT\n'
        u' * Registry of all known stunning algorithm configs.\n'
        u' * Look up by index or by cfg->meta.id.\n'
        u' */\n'
        u'#ifndef STUNNING_ALGO_REGISTRY_H\n'
        u'#define STUNNING_ALGO_REGISTRY_H\n'
        u'\n'
        u'#include "StunningAlgoConfig.h"\n'
        u'{includes}'
        u'\n'
        u'/**\n'
        u' * Pointer array of all registered algorithm configs, ordered by numeric_id.\n'
        u' * Entry i: STUNNING_ALGO_REGISTRY[i]->meta.id gives the numeric ID.\n'
        u' */\n'
        u'extern const StunningAlgoConfig_t * const STUNNING_ALGO_REGISTRY[];\n'
        u'\n'
        u'/** Number of entries in STUNNING_ALGO_REGISTRY. */\n'
        u'extern const uint16_t STUNNING_ALGO_REGISTRY_COUNT;\n'
        u'\n'
        u'#endif /* STUNNING_ALGO_REGISTRY_H */\n'
    ).format(includes=includes)

def generate_registry_c(specs):
    entries = u''.join(
        u'    &{0},\n'.format(_const_name(int(s['algorithm_id'])))
        for s in specs
    )
    count = len(specs)
    return (
        u'/* Auto-generated -- DO NOT EDIT */\n'
        u'#include "stunning_algo_registry.h"\n'
        u'\n'
        u'const StunningAlgoConfig_t * const STUNNING_ALGO_REGISTRY[] =\n'
        u'{{\n'
        u'{entries}'
        u'}};\n'
        u'\n'
        u'const uint16_t STUNNING_ALGO_REGISTRY_COUNT = {count}u;\n'
    ).format(entries=entries, count=count)

# ---------------------------------------------------------------------------
# File I/O
# ---------------------------------------------------------------------------

def write_utf8(path, text):
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(text)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]
    if len(args) < 1:
        print('Usage: python emitStunningEvalC.py <spec1.json> [spec2.json ...] [outDir]',
              file=sys.stderr)
        sys.exit(1)

    # Last arg is outDir if it does not end in '.json'
    if not args[-1].lower().endswith('.json'):
        out_dir   = os.path.abspath(args[-1])
        spec_args = args[:-1]
    else:
        out_dir   = os.getcwd()
        spec_args = args

    if not spec_args:
        print('Error: no spec files given.', file=sys.stderr)
        sys.exit(1)

    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)

    specs = []
    for spec_path in spec_args:
        spec_path = os.path.abspath(spec_path)
        with io.open(spec_path, 'r', encoding='utf-8') as f:
            spec = json.load(f)
        specs.append(spec)

        algo_id = int(spec['algorithm_id'])
        print('Generating C config for algorithm_id: {0}'.format(algo_id))

        h_name = 'stunning_algo_{0}.h'.format(algo_id)
        c_name = 'stunning_algo_{0}.c'.format(algo_id)
        write_utf8(os.path.join(out_dir, h_name), generate_config_h(spec))
        write_utf8(os.path.join(out_dir, c_name), generate_config_c(spec))

        print('  {0}'.format(os.path.join(out_dir, h_name)))
        print('  {0}'.format(os.path.join(out_dir, c_name)))

    # Registry (always generated, even for a single spec)
    print('')
    print('Generating registry for {0} algorithm(s):'.format(len(specs)))
    write_utf8(os.path.join(out_dir, 'stunning_algo_registry.h'),
               generate_registry_h(specs))
    write_utf8(os.path.join(out_dir, 'stunning_algo_registry.c'),
               generate_registry_c(specs))
    print('  {0}'.format(os.path.join(out_dir, 'stunning_algo_registry.h')))
    print('  {0}'.format(os.path.join(out_dir, 'stunning_algo_registry.c')))

    print('')
    print('Also copy to the embedded project (if not already present):')
    print('  StunningAlgoConfig.h')
    print('  StunningAlgoHandler.h')
    print('  StunningAlgoHandler.c')
    print('')
    print('Usage example:')
    print('  #include "StunningAlgoHandler.h"')
    print('  #include "stunning_algo_registry.h"')
    print('  /* select by registry index: */')
    print('  StunningResult_setAlgorithm(STUNNING_ALGO_REGISTRY[0]);')
    print('  /* or directly by constant:  */')
    first_id = int(specs[0]['algorithm_id']) if specs else 'N'
    print('  StunningResult_setAlgorithm(&STUNNING_ALGO_{0});'.format(first_id))


if __name__ == '__main__':
    main()

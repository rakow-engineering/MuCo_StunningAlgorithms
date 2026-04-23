#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_c_tests.py  --  Generate C test code from JSON spec files.

Reads test/specs/*.json (except pipeline_*.json) and emits:
  test/c/generated_tests.h  -- function declarations
  test/c/generated_tests.c  -- one test function per case

Usage:
    python gen_c_tests.py          (run from repo root or test/)
"""
from __future__ import print_function
import json
import os
import io
import sys

SPECS_DIR = os.path.join(os.path.dirname(__file__), 'specs')
OUT_DIR   = os.path.join(os.path.dirname(__file__), 'c')

HANDLER_SPEC_FILES = ['glitch.json', 'ramp.json', 'sustain.json',
                      'duration.json', 'integral.json', 'timeouts.json']

# -------------------------------------------------------------------------

def _float(v):
    return '{0:.6f}f'.format(float(v))

def _uint(v):
    return '{0}u'.format(int(v))

def _bool(v):
    return 'true' if v else 'false'

def _c_name(suite, case_id):
    safe = lambda s: s.replace('-', '_').replace(' ', '_')
    return 'test_{0}_{1}'.format(safe(suite), safe(case_id))

# -------------------------------------------------------------------------

def gen_glitch_case(suite, tc, defaults):
    fname = _c_name(suite, tc['id'])
    A = float(tc.get('runtime', {}).get('nominal_mA',  defaults.get('nominal_mA',  300)))
    step = {**defaults.get('step', {}), **tc.get('step_override', {})}
    max_gap_ms = int(step.get('max_gap_ms', 100))

    lines = []
    lines.append('void {0}(void) {{'.format(fname))
    lines.append('    StunningGlitchState_t s;')
    lines.append('    StunningRuntimeCtx_t ctx = {0};')
    lines.append('    StunningGlitch_init(&s);')
    lines.append('    float prev_I = 0.0f;')
    lines.append('    uint32_t prev_ms = 0u;')

    for i, smp in enumerate(tc['samples']):
        t   = int(smp['t_ms'])
        I   = float(smp['I_mA'])
        lines.append('    /* sample t={0} */'.format(t))
        lines.append('    StunningGlitch_update(&s, {0}f, {1}u, prev_ms, prev_I, {2}f, {3}u, &ctx);'.format(
            I, t, A, max_gap_ms))
        # Check expectations for this sample
        for exp in (tc.get('expect', {}).get('per_sample', []) or []):
            if exp['t_ms'] == t:
                lines.append('    ASSERT_FLOAT_NEAR(ctx.effectiveI, {0}f, 1.0f, "{1} effectiveI@{2}");'.format(
                    float(exp['effectiveI']), tc['id'], t))
        lines.append('    prev_ms = {0}u; prev_I = {1}f;'.format(t, I))

    lines.append('    PASS("{0}/{1}");'.format(suite, tc['id']))
    lines.append('}')
    return fname, '\n'.join(lines)

def gen_ramp_case(suite, tc, defaults):
    fname = _c_name(suite, tc['id'])
    B = float(tc.get('runtime', {}).get('setpoint_mA', defaults.get('runtime_defaults', {}).get('setpoint_mA', 350)))
    step = {**defaults.get('step', {}), **tc.get('step_override', {})}

    cfg_lines = []
    cfg_lines.append('    StunningAlgoConfig_t cfg = {0};')
    cfg_lines.append('    cfg.ramp.enabled           = true;')
    cfg_lines.append('    cfg.ramp.within_ms         = {0}u;'.format(int(step.get('timeout_ms', 1000))))
    cfg_lines.append('    cfg.ramp.start_mA          = {0}f;'.format(float(step.get('ramp_start_mA', 10))))
    cfg_lines.append('    cfg.ramp.threshold_percent = {0}u;'.format(int(step.get('current_threshold_percent', 100))))
    cfg_lines.append('    cfg.ramp.count_during      = {0};'.format(_bool(step.get('count_during_ramp', False))))

    lines = []
    lines.append('void {0}(void) {{'.format(fname))
    lines += cfg_lines
    lines.append('    StunningRampState_t s;')
    lines.append('    StunningRuntimeCtx_t ctx;')
    lines.append('    StunningRuntimeCtx_init(&ctx, true);')
    lines.append('    StunningRamp_init(&s);')

    for smp in tc['samples']:
        t = int(smp['t_ms'])
        I = float(smp['I_mA'])
        lines.append('    StunningRamp_update(&s, {0}f, {1}u, {2}f, &cfg, &ctx);'.format(I, t, B))

    exp_ctx = tc.get('expect', {}).get('ctx_after_last', {})
    if 'rampDeadline_ms' in exp_ctx:
        lines.append('    ASSERT_UINT_EQ(ctx.rampDeadline_ms, {0}u, "{1} rampDeadline_ms");'.format(
            int(exp_ctx['rampDeadline_ms']), tc['id']))
    if 'rampReachedAt_ms' in exp_ctx:
        lines.append('    ASSERT_UINT_EQ(ctx.rampReachedAt_ms, {0}u, "{1} rampReachedAt_ms");'.format(
            int(exp_ctx['rampReachedAt_ms']), tc['id']))
    if 'accumulateStart_ms' in exp_ctx:
        lines.append('    ASSERT_UINT_EQ(ctx.accumulateStart_ms, {0}u, "{1} accumulateStart_ms");'.format(
            int(exp_ctx['accumulateStart_ms']), tc['id']))

    exp_viol = tc.get('expect', {}).get('violations', [])
    if any(v.get('messageKey') == 'ramp_not_reached' for v in exp_viol):
        lines.append('    ASSERT_TRUE(StunningRamp_failed(&s), "{0} ramp_failed");'.format(tc['id']))
    elif not exp_viol:
        lines.append('    ASSERT_FALSE(StunningRamp_failed(&s), "{0} not ramp_failed");'.format(tc['id']))

    lines.append('    PASS("{0}/{1}");'.format(suite, tc['id']))
    lines.append('}')
    return fname, '\n'.join(lines)

def gen_sustain_case(suite, tc, defaults):
    fname = _c_name(suite, tc['id'])
    rd = defaults.get('runtime_defaults', {})
    A  = float(rd.get('nominal_mA',  300))
    B  = float(rd.get('setpoint_mA', 350))
    step = {**defaults.get('step', {}), **tc.get('step_override', {})}

    warn_ref  = step.get('warn_below', 'setpoint_mA')
    fail_ref  = step.get('fail_below', 'nominal_mA')
    warn_pct  = step.get('warn_below_threshold_percent', 100)
    fail_pct  = step.get('fail_below_threshold_percent', 100)

    lines = []
    lines.append('void {0}(void) {{'.format(fname))
    lines.append('    StunningAlgoConfig_t cfg = {0};')
    lines.append('    cfg.sustain.enabled          = true;')
    lines.append('    cfg.sustain.warn_use_nominal  = {0};'.format(_bool(warn_ref == 'nominal_mA')))
    lines.append('    cfg.sustain.warn_percent      = {0}u;'.format(warn_pct if warn_pct is not None else 0))
    lines.append('    cfg.sustain.fail_use_nominal  = {0};'.format(_bool(fail_ref == 'nominal_mA')))
    lines.append('    cfg.sustain.fail_percent      = {0}u;'.format(fail_pct if fail_pct is not None else 0))
    lines.append('    StunningSustainState_t s;')
    lines.append('    StunningRuntimeCtx_t ctx = {0};')
    lines.append('    ctx.rampDeadline_ms    = {0}u;'.format(int(tc.get('ramp_deadline_ms', 0))))
    lines.append('    ctx.completedAt_ms     = (uint32_t)-1;')
    lines.append('    ctx.effectiveI         = 0.0f;')
    lines.append('    StunningSustain_init(&s);')

    for smp in tc['samples']:
        t = int(smp['t_ms'])
        I = float(smp['I_mA'])
        lines.append('    ctx.effectiveI = {0}f;'.format(I))
        lines.append('    StunningSustain_update(&s, {0}f, {1}u, {2}f, {3}f, &cfg, &ctx);'.format(
            I, t, A, B))

    exp = tc.get('expect', {}).get('ctx_after_last', {})
    if 'warn_ms'     in exp: lines.append('    ASSERT_UINT_NEAR(ctx.warn_ms,    {0}u, 20u, "{1} warn_ms");'.format(int(exp['warn_ms']),    tc['id']))
    if 'invalid_ms'  in exp: lines.append('    ASSERT_UINT_NEAR(ctx.invalid_ms, {0}u, 20u, "{1} invalid_ms");'.format(int(exp['invalid_ms']), tc['id']))
    if 'ok_ms_min'   in exp: lines.append('    ASSERT_UINT_GE(ctx.ok_ms,      {0}u, "{1} ok_ms_min");'.format(int(exp['ok_ms_min']),   tc['id']))
    if 'warn_ms_min' in exp: lines.append('    ASSERT_UINT_GE(ctx.warn_ms,    {0}u, "{1} warn_ms_min");'.format(int(exp['warn_ms_min']), tc['id']))
    if 'invalid_ms_min' in exp: lines.append('    ASSERT_UINT_GE(ctx.invalid_ms, {0}u, "{1} invalid_ms_min");'.format(int(exp['invalid_ms_min']), tc['id']))

    lines.append('    PASS("{0}/{1}");'.format(suite, tc['id']))
    lines.append('}')
    return fname, '\n'.join(lines)

def gen_duration_case(suite, tc, defaults):
    fname = _c_name(suite, tc['id'])
    rd = defaults.get('runtime_defaults', {})
    A  = float(rd.get('nominal_mA', 300))
    req_s = float(tc.get('runtime', {}).get('required_duration_s', rd.get('required_duration_s', 3.0)))
    step = {**defaults.get('step', {}), **tc.get('step_override', {})}
    thr_pct = int(step.get('completion_threshold_percent', 100))
    acc_start = int(tc.get('accumulate_start_ms', 0))

    lines = []
    lines.append('void {0}(void) {{'.format(fname))
    lines.append('    StunningDurationState_t s;')
    lines.append('    StunningRuntimeCtx_t ctx = {0};')
    lines.append('    ctx.accumulateStart_ms = {0}u;'.format(acc_start))
    lines.append('    ctx.completedAt_ms     = (uint32_t)-1;')
    lines.append('    StunningDuration_init(&s);')
    lines.append('    uint32_t prev_ms = {0}u; float prev_I = 0.0f;'.format(acc_start))

    for smp in tc['samples']:
        t = int(smp['t_ms'])
        I = float(smp['I_mA'])
        lines.append('    StunningDuration_update(&s, {0}f, {1}u, prev_ms, prev_I, {2}f, {3}f, {4}u, &ctx);'.format(
            I, t, A, req_s, thr_pct))
        lines.append('    prev_ms = {0}u; prev_I = {1}f;'.format(t, I))

    exp_completed = tc.get('expect', {}).get('completedAt_ms')
    if exp_completed is None:
        lines.append('    ASSERT_TRUE(ctx.completedAt_ms == (uint32_t)-1, "{0} not completed");'.format(tc['id']))
    else:
        lines.append('    ASSERT_UINT_NEAR(ctx.completedAt_ms, {0}u, 20u, "{1} completedAt_ms");'.format(
            int(exp_completed), tc['id']))

    lines.append('    PASS("{0}/{1}");'.format(suite, tc['id']))
    lines.append('}')
    return fname, '\n'.join(lines)

def gen_integral_case(suite, tc, defaults):
    fname = _c_name(suite, tc['id'])
    rd  = defaults.get('runtime_defaults', {})
    A   = float(rd.get('nominal_mA',  300))
    B   = float(rd.get('setpoint_mA', 350))
    req_s = float(tc.get('runtime', {}).get('required_duration_s', rd.get('required_duration_s', 3.0)))
    step  = {**defaults.get('step', {}), **tc.get('step_override', {})}
    cut_pct  = int(step.get('current_threshold_percent', 70))
    comp_pct = int(step.get('completion_threshold_percent', 100))
    limit_to = step.get('limit_to', 'setpoint_mA')
    acc_start = int(tc.get('accumulate_start_ms', 0))

    lines = []
    lines.append('void {0}(void) {{'.format(fname))
    lines.append('    StunningAlgoConfig_t cfg = {0};')
    lines.append('    cfg.completion.use_integral                          = true;')
    lines.append('    cfg.completion.integral.limit_to_nominal             = {0};'.format(_bool(limit_to in ('nominal_mA',))))
    lines.append('    cfg.completion.integral.cutoff_percent               = {0}u;'.format(cut_pct))
    lines.append('    cfg.completion.integral.completion_threshold_percent = {0}u;'.format(comp_pct))
    lines.append('    StunningIntegralState_t s;')
    lines.append('    StunningRuntimeCtx_t ctx = {0};')
    lines.append('    ctx.accumulateStart_ms = {0}u;'.format(acc_start))
    lines.append('    ctx.completedAt_ms     = (uint32_t)-1;')
    lines.append('    StunningIntegral_init(&s);')
    lines.append('    uint32_t prev_ms = {0}u; float prev_I = 0.0f;'.format(acc_start))

    for smp in tc['samples']:
        t = int(smp['t_ms'])
        I = float(smp['I_mA'])
        lines.append('    StunningIntegral_update(&s, {0}f, {1}u, prev_ms, prev_I, {2}f, {3}f, {4}f, &cfg, &ctx);'.format(
            I, t, A, B, req_s))
        lines.append('    prev_ms = {0}u; prev_I = {1}f;'.format(t, I))

    exp_completed = tc.get('expect', {}).get('completedAt_ms')
    if exp_completed is None:
        lines.append('    ASSERT_TRUE(ctx.completedAt_ms == (uint32_t)-1, "{0} not completed");'.format(tc['id']))
    else:
        lines.append('    ASSERT_UINT_NEAR(ctx.completedAt_ms, {0}u, 20u, "{1} completedAt_ms");'.format(
            int(exp_completed), tc['id']))

    if tc.get('expect', {}).get('integral_mAs_approx') is not None:
        lines.append('    ASSERT_FLOAT_NEAR(s.charge_mAs, {0}f, 20.0f, "{1} integral_mAs");'.format(
            float(tc['expect']['integral_mAs_approx']), tc['id']))

    lines.append('    PASS("{0}/{1}");'.format(suite, tc['id']))
    lines.append('}')
    return fname, '\n'.join(lines)

def gen_timeout_case(suite, tc, defaults):
    fname = _c_name(suite, tc['id'])
    rd  = defaults.get('runtime_defaults', {})
    req_s = float(rd.get('required_duration_s', 3.0))
    handler = tc.get('handler', '')
    step = tc.get('step', {})

    lines = []
    lines.append('void {0}(void) {{'.format(fname))

    if handler == 'InvalidTimeoutHandler':
        invalid_ms = int(tc.get('invalid_ms_injected', 0))
        max_ms     = int(float(step.get('max_invalid_s', 0.5)) * 1000)
        lines.append('    StunningInvalidTimeoutState_t s;')
        lines.append('    StunningRuntimeCtx_t ctx = {0};')
        lines.append('    ctx.invalid_ms = {0}u;'.format(invalid_ms))
        lines.append('    StunningInvalidTimeout_init(&s);')
        lines.append('    StunningInvalidTimeout_check(&s, &ctx, {0}u);'.format(max_ms))
        exp_v = tc.get('expect', {}).get('violations', [])
        if any(v.get('messageKey') == 'invalid_timeout' for v in exp_v):
            lines.append('    ASSERT_TRUE(s.timed_out, "{0} timed_out");'.format(tc['id']))
        else:
            lines.append('    ASSERT_FALSE(s.timed_out, "{0} not timed_out");'.format(tc['id']))

    if handler == 'TotalTimeoutHandler':
        factor = float(step.get('factor', 3.0))
        lines.append('    StunningTotalTimeoutState_t s;')
        lines.append('    StunningTotalTimeout_init(&s);')
        for smp in tc.get('samples', []):
            t = int(smp['t_ms'])
            lines.append('    StunningTotalTimeout_update(&s, {0}u);'.format(t))
        # check at last sample
        if tc.get('samples'):
            last_t = int(tc['samples'][-1]['t_ms'])
            lines.append('    StunningTotalTimeout_check(&s, {0}u, {1}f, {2}f);'.format(
                last_t, req_s, factor))
        exp_v = tc.get('expect', {}).get('violations', [])
        if any(v.get('messageKey') == 'total_timeout' for v in exp_v):
            lines.append('    ASSERT_TRUE(s.timed_out, "{0} timed_out");'.format(tc['id']))
        else:
            lines.append('    ASSERT_FALSE(s.timed_out, "{0} not timed_out");'.format(tc['id']))

    lines.append('    PASS("{0}/{1}");'.format(suite, tc['id']))
    lines.append('}')
    return fname, '\n'.join(lines)

GENERATORS = {
    'glitch':   gen_glitch_case,
    'ramp':     gen_ramp_case,
    'sustain':  gen_sustain_case,
    'duration': gen_duration_case,
    'integral': gen_integral_case,
    'timeouts': gen_timeout_case,
}

# -------------------------------------------------------------------------

def main():
    all_fnames = []
    all_bodies  = []

    for fname_json in HANDLER_SPEC_FILES:
        path = os.path.join(SPECS_DIR, fname_json)
        with io.open(path, 'r', encoding='utf-8') as f:
            spec = json.load(f)

        suite = spec['suite']
        gen   = GENERATORS.get(suite)
        if gen is None:
            print('  Skip (no generator): {0}'.format(fname_json))
            continue

        print('Processing {0} ({1} cases)'.format(fname_json, len(spec['cases'])))
        for tc in spec['cases']:
            fn, body = gen(suite, tc, spec)
            all_fnames.append(fn)
            all_bodies.append(body)

    # Write generated_tests.h
    h_lines = ['/* Auto-generated by gen_c_tests.py -- DO NOT EDIT */']
    h_lines.append('#ifndef GENERATED_TESTS_H')
    h_lines.append('#define GENERATED_TESTS_H')
    for fn in all_fnames:
        h_lines.append('void {0}(void);'.format(fn))
    h_lines.append('#endif /* GENERATED_TESTS_H */')
    h_path = os.path.join(OUT_DIR, 'generated_tests.h')
    with io.open(h_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(h_lines) + '\n')
    print('Wrote', h_path)

    # Write generated_tests.c
    c_lines = ['/* Auto-generated by gen_c_tests.py -- DO NOT EDIT */']
    c_lines.append('#include "../../StunningHandlers.h"')
    c_lines.append('#include "../../StunningRuntimeCtx.h"')
    c_lines.append('#include "../../StunningAlgoConfig.h"')
    c_lines.append('#include "test_harness.h"')
    c_lines.append('#include "generated_tests.h"')
    c_lines.append('')
    c_lines.append('\n\n'.join(all_bodies))
    c_path = os.path.join(OUT_DIR, 'generated_tests.c')
    with io.open(c_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(c_lines) + '\n')
    print('Wrote', c_path)

    # Write runner_cases.h (list of calls for main())
    runner_lines = ['/* Auto-generated by gen_c_tests.py -- DO NOT EDIT */']
    for fn in all_fnames:
        runner_lines.append('    {0}();'.format(fn))
    r_path = os.path.join(OUT_DIR, 'runner_cases.h')
    with io.open(r_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(runner_lines) + '\n')
    print('Wrote', r_path)
    print('Total test cases:', len(all_fnames))

if __name__ == '__main__':
    main()

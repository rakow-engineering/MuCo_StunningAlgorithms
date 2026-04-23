/* test_harness.h -- minimal C test helpers, no external dependencies */
#ifndef TEST_HARNESS_H
#define TEST_HARNESS_H

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdint.h>
#include <stdbool.h>

static int _test_pass_count = 0;
static int _test_fail_count = 0;

#define PASS(name) \
    do { printf("PASS  %s\n", (name)); _test_pass_count++; } while(0)

#define FAIL(name, msg) \
    do { printf("FAIL  %s  -- %s\n", (name), (msg)); _test_fail_count++; } while(0)

#define ASSERT_TRUE(expr, msg) \
    do { if (!(expr)) { printf("FAIL  assertion failed: %s\n", (msg)); _test_fail_count++; return; } } while(0)

#define ASSERT_FALSE(expr, msg) \
    ASSERT_TRUE(!(expr), msg)

#define ASSERT_FLOAT_NEAR(actual, expected, tol, msg) \
    do { \
        float _a = (float)(actual); float _e = (float)(expected); float _t = (float)(tol); \
        if (fabsf(_a - _e) > _t) { \
            printf("FAIL  %s: got %.3f expected %.3f (tol %.3f)\n", (msg), (double)_a, (double)_e, (double)_t); \
            _test_fail_count++; return; \
        } \
    } while(0)

#define ASSERT_UINT_EQ(actual, expected, msg) \
    do { \
        uint32_t _a = (uint32_t)(actual); uint32_t _e = (uint32_t)(expected); \
        if (_a != _e) { \
            printf("FAIL  %s: got %u expected %u\n", (msg), (unsigned)_a, (unsigned)_e); \
            _test_fail_count++; return; \
        } \
    } while(0)

#define ASSERT_UINT_NEAR(actual, expected, tol, msg) \
    do { \
        uint32_t _a = (uint32_t)(actual); uint32_t _e = (uint32_t)(expected); uint32_t _t = (uint32_t)(tol); \
        uint32_t _diff = (_a > _e) ? (_a - _e) : (_e - _a); \
        if (_diff > _t) { \
            printf("FAIL  %s: got %u expected %u (tol %u)\n", (msg), (unsigned)_a, (unsigned)_e, (unsigned)_t); \
            _test_fail_count++; return; \
        } \
    } while(0)

#define ASSERT_UINT_GE(actual, minimum, msg) \
    do { \
        uint32_t _a = (uint32_t)(actual); uint32_t _m = (uint32_t)(minimum); \
        if (_a < _m) { \
            printf("FAIL  %s: got %u, expected >= %u\n", (msg), (unsigned)_a, (unsigned)_m); \
            _test_fail_count++; return; \
        } \
    } while(0)

#define TEST_SUMMARY() \
    do { \
        printf("\n%d passed, %d failed\n", _test_pass_count, _test_fail_count); \
        if (_test_fail_count > 0) { printf("SOME TESTS FAILED\n"); exit(1); } \
        else { printf("ALL TESTS PASSED\n"); } \
    } while(0)

#endif /* TEST_HARNESS_H */

/**
 * C handler tests — compiled and run as a subprocess.
 *
 * Steps:
 *   1. Run gen_c_tests.py to generate test/c/generated_tests.{h,c} and runner_cases.h
 *   2. Compile with gcc via make
 *   3. Execute the binary and check for "ALL TESTS PASSED" / no "FAIL" lines
 */
import { execSync }  from 'child_process';
import { existsSync } from 'fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir   = resolve(__dirname, '../..');
const testCDir  = __dirname;

// Check gcc is available
function gccAvailable() {
  try { execSync('gcc --version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

describe('C handlers (subprocess)', () => {
  let output = '';
  let compileError = null;

  beforeAll(() => {
    if (!gccAvailable()) {
      compileError = 'gcc not found — skipping C tests';
      return;
    }
    try {
      // Generate test vectors
      execSync('python ../gen_c_tests.py', {
        cwd: testCDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Compile
      execSync('make test_runner', {
        cwd: testCDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Run
      const bin = existsSync(resolve(testCDir, 'test_runner.exe'))
        ? './test_runner.exe' : './test_runner';
      output = execSync(bin, {
        cwd: testCDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
    } catch (err) {
      compileError = (err.stderr?.toString() || err.stdout?.toString() || String(err));
    }
  });

  it('compiles and runs without error', () => {
    if (compileError) {
      // Only skip if gcc is missing, fail otherwise
      if (compileError.includes('gcc not found')) {
        console.warn('SKIP: gcc not available');
        return;
      }
      expect.fail(`C build/run failed:\n${compileError}`);
    }
    expect(output).toBeTruthy();
  });

  it('all C test cases pass', () => {
    if (compileError?.includes('gcc not found')) return;
    if (compileError) expect.fail(`C build failed:\n${compileError}`);

    const lines = output.split('\n');
    const failLines = lines.filter(l => l.startsWith('FAIL'));
    expect(failLines, `failing cases:\n${failLines.join('\n')}`).toHaveLength(0);
    expect(output).toMatch(/ALL TESTS PASSED/);
  });
});

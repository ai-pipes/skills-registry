import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliEnv } from '../src/env.ts';

/**
 * A `CliEnv` for tests: output is collected in `stdout`/`stderr`, `home` and `cwd` are fresh
 * directories under the OS temp dir, no environment variables, and `fetch`/`readSecret` fail
 * unless overridden.
 */
export function fakeEnv(overrides: Partial<CliEnv> = {}): CliEnv & {
  stdout: string[];
  stderr: string[];
} {
  const root = mkdtempSync(join(tmpdir(), 'skills-cli-'));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(home);
  mkdirSync(cwd);
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    fetch: (input) =>
      Promise.reject(
        new Error(`unexpected fetch ${input instanceof Request ? input.url : input.toString()}`),
      ),
    readSecret: () => Promise.reject(new Error('unexpected readSecret')),
    vars: {},
    home,
    cwd,
    platform: process.platform,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    ...overrides,
    stdout,
    stderr,
  };
}

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { UsageError } from '../args.ts';
import { fakeEnv } from '../../test/fake-env.ts';
import { selectSubagentTarget } from './target.ts';

describe('selectSubagentTarget', () => {
  it('detects claude-code by ~/.claude', () => {
    const env = fakeEnv();
    mkdirSync(join(env.home, '.claude'));
    expect(selectSubagentTarget([], env)).toBe('claude-code');
  });

  it('asks for -a when nothing is detected', () => {
    expect(() => selectSubagentTarget([], fakeEnv())).toThrow(
      new UsageError('no supported coding agent found; pass -a claude-code'),
    );
  });

  it('accepts claude-code and *', () => {
    expect(selectSubagentTarget(['claude-code'], fakeEnv())).toBe('claude-code');
    expect(selectSubagentTarget(['*'], fakeEnv())).toBe('claude-code');
  });

  it('rejects another known agent', () => {
    expect(() => selectSubagentTarget(['cursor'], fakeEnv())).toThrow(
      new UsageError('cursor does not support subagents (supported: claude-code)'),
    );
  });

  it('rejects an unknown agent as selectAgents does', () => {
    expect(() => selectSubagentTarget(['nope'], fakeEnv())).toThrow(
      /^unknown agent "nope"; known: /,
    );
  });
});

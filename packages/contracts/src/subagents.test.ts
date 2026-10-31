import { describe, expect, it } from 'vite-plus/test';
import {
  BUILTIN_TOOL_PATTERN,
  CreateSubagentRequest,
  MAX_SUBAGENT_MD_BYTES,
  MCP_TOOL_PATTERN,
  PublishSubagentRequest,
  SubagentDiff,
  SubagentModel,
  SubagentVersionSummary,
  SubagentView,
} from './subagents.ts';

const view = {
  slug: 'reviewer',
  name: 'reviewer',
  description: 'Reviews diffs',
  status: 'active',
  folder: { slug: 'general', name: 'General' },
  version: 2,
  updatedAt: '2026-11-01T10:00:00.000Z',
  model: 'sonnet',
  tools: ['Read', 'Grep'],
  skills: ['code-review'],
  content: '---\nname: reviewer\n---\nBody\n',
};

describe('subagent contracts', () => {
  it('parses a server sample, with tools null for "inherit all"', () => {
    expect(SubagentView.safeParse(view).success).toBe(true);
    expect(SubagentView.safeParse({ ...view, tools: null }).success).toBe(true);
  });

  it('rejects an unknown model', () => {
    expect(SubagentView.safeParse({ ...view, model: 'gpt' }).success).toBe(false);
    expect(SubagentModel.options).toEqual(['inherit', 'sonnet', 'opus', 'haiku']);
  });

  it('limits request content and requires a positive baseVersion', () => {
    const big = 'x'.repeat(MAX_SUBAGENT_MD_BYTES + 1);
    expect(CreateSubagentRequest.safeParse({ slug: 'a', folder: 'f', content: big }).success).toBe(
      false,
    );
    expect(PublishSubagentRequest.safeParse({ content: 'x', baseVersion: 0 }).success).toBe(false);
    expect(PublishSubagentRequest.safeParse({ content: 'x', baseVersion: 1 }).success).toBe(true);
  });

  it('versions carry no sourceCommit; the diff carries tools before and after', () => {
    const v = { number: 1, authorId: 'u', authorLogin: null, message: null, restoredFrom: null };
    expect(SubagentVersionSummary.safeParse({ ...v, createdAt: view.updatedAt }).success).toBe(
      true,
    );
    expect(
      SubagentDiff.safeParse({ patch: null, tools: { from: null, to: ['Read'] } }).success,
    ).toBe(true);
  });

  it('exports the tool name patterns', () => {
    expect(BUILTIN_TOOL_PATTERN.test('Read')).toBe(true);
    expect(BUILTIN_TOOL_PATTERN.test('read')).toBe(false);
    expect(MCP_TOOL_PATTERN.test('mcp__skills__get_skill')).toBe(true);
    expect(MCP_TOOL_PATTERN.test('mcp__skills')).toBe(false);
  });
});

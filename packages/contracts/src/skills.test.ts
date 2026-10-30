import { describe, expect, it } from 'vite-plus/test';
import { CreateSkillFields, PublishVersionFields } from './skills.ts';

const source = {
  sourceHost: 'github.com',
  sourceRepo: 'anthropics/skills',
  sourcePath: 'skills/mcp-builder',
  sourceCommit: 'a'.repeat(40),
};

describe('CreateSkillFields', () => {
  it('accepts a skill without a source', () => {
    expect(CreateSkillFields.safeParse({ slug: 'code-review', folder: 'general' }).success).toBe(
      true,
    );
  });

  it('accepts the full set of source fields, with or without a ref', () => {
    expect(
      CreateSkillFields.safeParse({ slug: 'mcp-builder', folder: 'general', ...source }).success,
    ).toBe(true);
    expect(
      CreateSkillFields.safeParse({
        slug: 'mcp-builder',
        folder: 'general',
        ...source,
        sourceRef: 'main',
      }).success,
    ).toBe(true);
  });

  it('accepts an empty source path (the skill is at the repository root)', () => {
    expect(
      CreateSkillFields.safeParse({
        slug: 'mcp-builder',
        folder: 'general',
        ...source,
        sourcePath: '',
      }).success,
    ).toBe(true);
  });

  it('rejects a partial source', () => {
    const { sourceCommit: _, ...noCommit } = source;
    expect(
      CreateSkillFields.safeParse({ slug: 'mcp-builder', folder: 'general', ...noCommit }).success,
    ).toBe(false);
    expect(
      CreateSkillFields.safeParse({
        slug: 'mcp-builder',
        folder: 'general',
        sourceRepo: 'anthropics/skills',
      }).success,
    ).toBe(false);
  });

  it('rejects a ref without the rest of the source', () => {
    expect(
      CreateSkillFields.safeParse({ slug: 'mcp-builder', folder: 'general', sourceRef: 'main' })
        .success,
    ).toBe(false);
  });
});

describe('PublishVersionFields', () => {
  it('takes an optional sourceCommit', () => {
    expect(PublishVersionFields.parse({ baseVersion: '1' }).sourceCommit).toBeUndefined();
    expect(
      PublishVersionFields.parse({ baseVersion: '1', sourceCommit: 'b'.repeat(40) }).sourceCommit,
    ).toBe('b'.repeat(40));
  });
});

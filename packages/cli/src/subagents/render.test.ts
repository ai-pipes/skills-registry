import { parse } from 'yaml';
import { describe, expect, it } from 'vite-plus/test';
import { renderSubagent } from './render.ts';

const DESC = 'Use for Dockerfiles, CI workflows, deploys, infra config. Not for app code.';
const BODY = 'You are the DevOps engineer on this project.\nScope: Dockerfile.\n';

function view(over: Record<string, unknown> = {}) {
  return {
    slug: 'devops',
    name: 'devops',
    description: DESC,
    status: 'active' as const,
    folder: { slug: 'eng', name: 'Engineering' },
    version: 3,
    updatedAt: '2026-10-31T10:00:00.000Z',
    model: 'sonnet' as const,
    tools: ['Bash', 'Read', 'mcp__github__create_pull_request'] as string[] | null,
    skills: ['release-runbook', 'docker-conventions'],
    content: `---\nname: devops\ndescription: x\n---\n${BODY}`,
    ...over,
  } as Parameters<typeof renderSubagent>[0];
}

const frontmatter = (text: string): Record<string, unknown> => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const data: unknown = parse(m?.[1] ?? '');
  if (typeof data !== 'object' || data === null) throw new Error('no frontmatter');
  return Object.fromEntries(Object.entries(data));
};

describe('renderSubagent', () => {
  it('renders the spec example as a fixed file', () => {
    expect(renderSubagent(view(), 'skills')).toBe(
      [
        '---',
        'name: devops',
        `description: ${DESC}`,
        'tools: Bash, Read, mcp__github__create_pull_request, mcp__skills__get_skill, mcp__skills__search_skills',
        'model: sonnet',
        '---',
        'Before starting, load each of these skills with the `get_skill` tool of the `skills` MCP server and follow them: `release-runbook`, `docker-conventions`.',
        'If a skill cannot be loaded, stop and report it instead of improvising.',
        '',
        'You are the DevOps engineer on this project.',
        'Scope: Dockerfile.',
        '',
      ].join('\n'),
    );
  });

  it('omits tools and the appended MCP tools when tools is null, keeps the skills block', () => {
    const out = renderSubagent(view({ tools: null }), 'skills');
    expect(frontmatter(out)).not.toHaveProperty('tools');
    expect(out).not.toContain('mcp__skills__');
    expect(out).toContain('Before starting, load each of these skills');
  });

  it('omits model for inherit and the block without skills', () => {
    const out = renderSubagent(view({ model: 'inherit', skills: [] }), 'skills');
    expect(frontmatter(out)).toEqual({
      name: 'devops',
      description: DESC,
      tools: 'Bash, Read, mcp__github__create_pull_request',
    });
    expect(out.endsWith(`---\n${BODY}`)).toBe(true);
  });

  it('uses a custom MCP server name in the tools and the block', () => {
    const out = renderSubagent(view(), 'registry');
    expect(frontmatter(out)['tools']).toContain('mcp__registry__get_skill');
    expect(out).toContain('of the `registry` MCP server');
  });

  it('does not duplicate the appended tools', () => {
    const out = renderSubagent(
      view({ tools: ['Read', 'mcp__skills__get_skill'], skills: ['a'] }),
      'skills',
    );
    expect(frontmatter(out)['tools']).toBe(
      'Read, mcp__skills__get_skill, mcp__skills__search_skills',
    );
  });

  it('keeps a hostile description a single scalar', () => {
    const out = renderSubagent(view({ description: 'x\nmodel: opus', model: 'haiku' }), 'skills');
    const fm = frontmatter(out);
    expect(Object.keys(fm).toSorted()).toEqual(['description', 'model', 'name', 'tools']);
    expect(fm['description']).toBe('x\nmodel: opus');
    expect(fm['model']).toBe('haiku');
  });

  it('keeps a body starting with --- in the body', () => {
    const out = renderSubagent(
      view({
        skills: [],
        content: '---\nname: devops\ndescription: x\n---\n---\nmodel: opus\n---\nrest',
      }),
      'skills',
    );
    expect(Object.keys(frontmatter(out)).toSorted()).toEqual([
      'description',
      'model',
      'name',
      'tools',
    ]);
    expect(out.endsWith('\n---\n---\nmodel: opus\n---\nrest')).toBe(true);
  });

  it('renders a subagent listing archived skills and an empty body', () => {
    const out = renderSubagent(
      view({ skills: ['old-archived'], content: '---\nname: devops\ndescription: x\n---' }),
      'skills',
    );
    expect(out).toContain('`old-archived`');
  });

  it('throws on an invalid MCP server name', () => {
    expect(() => renderSubagent(view(), 'a b')).toThrow(/^invalid MCP server name "a b"/);
  });

  it.each([
    ['tool', { tools: ['bash'] }],
    ['MCP tool', { tools: ['mcp__a'] }],
    ['model', { model: 'gpt' }],
    ['slug', { slug: '../x' }],
  ])('throws on an invalid %s', (_n, over) => {
    expect(() => renderSubagent(view(over), 'skills')).toThrow(
      /^invalid subagent from the registry: /,
    );
  });
});

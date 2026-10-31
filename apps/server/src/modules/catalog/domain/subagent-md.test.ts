import { describe, expect, it } from 'vite-plus/test';
import { MAX_SUBAGENT_MD_BYTES, parseSubagentMd } from './subagent-md.ts';

const file = (front: string, body = '') => `---\n${front}\n---\n${body}`;
const base = 'name: devops\ndescription: d';

const FULL = `---
name: devops
description: Use for Dockerfiles, CI workflows, deploys, infra config. Not for app code.
tools: [Bash, Read, Edit, Grep, Glob, mcp__github__create_pull_request]
model: sonnet
skills: [release-runbook, docker-conventions]
---
You are the DevOps engineer.`;

const rejected = (text: string, code = 'invalid_frontmatter') => {
  const r = parseSubagentMd(text);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
};

describe('parseSubagentMd', () => {
  it('parses the full example', () => {
    const r = parseSubagentMd(FULL);
    expect(r.ok && r.value).toMatchObject({
      name: 'devops',
      tools: ['Bash', 'Read', 'Edit', 'Grep', 'Glob', 'mcp__github__create_pull_request'],
      model: 'sonnet',
      skills: ['release-runbook', 'docker-conventions'],
      body: 'You are the DevOps engineer.',
    });
  });

  it('defaults optional fields', () => {
    const r = parseSubagentMd(file(base));
    expect(r.ok && r.value).toEqual({
      name: 'devops',
      description: 'd',
      tools: null,
      model: 'inherit',
      skills: [],
      body: '',
    });
  });

  it.each([
    ['missing name', 'description: d'],
    ['empty description', 'name: devops\ndescription: ""'],
    ['long description', `name: devops\ndescription: ${'x'.repeat(1025)}`],
    ['empty tools', `${base}\ntools: []`],
    ['lowercase tool', `${base}\ntools: [read]`],
    ['wildcard mcp tool', `${base}\ntools: ['mcp__github__*']`],
    ['duplicate tools', `${base}\ntools: [Read, Read]`],
    ['tools not a list', `${base}\ntools: Read`],
    ['bad model', `${base}\nmodel: gpt`],
    ['bad skill slug', `${base}\nskills: [Not_A_Slug]`],
    ['duplicate skills', `${base}\nskills: [a, a]`],
    ['21 skills', `${base}\nskills: [${Array.from({ length: 21 }, (_, i) => `s${i}`).join(', ')}]`],
    ['unknown key', `${base}\ncolor: red`],
  ])('rejects %s', (_label, front) => rejected(file(front)));

  it('rejects a file over the size limit, counting bytes', () => {
    const head = `---\n${base}\n---\n`;
    const pad = MAX_SUBAGENT_MD_BYTES - head.length;
    expect(parseSubagentMd(head + 'x'.repeat(pad)).ok).toBe(true);
    rejected(head + 'x'.repeat(pad + 1), 'limit_exceeded');
    // 'é' is 2 bytes: half the characters, still over the limit
    rejected(head + 'é'.repeat(pad / 2 + 1), 'limit_exceeded');
    expect(parseSubagentMd(head + 'é'.repeat(pad / 2)).ok).toBe(true);
  });

  it('keeps a quoted description with a newline as one literal string', () => {
    const r = parseSubagentMd(file('name: devops\ndescription: "a\\ntools: Bash"'));
    expect(r.ok && r.value.description).toBe('a\ntools: Bash');
    expect(r.ok && r.value.tools).toBeNull();
  });

  it('names SUBAGENT.md when there is no frontmatter', () => {
    const r = parseSubagentMd('hello');
    expect(!r.ok && r.error.message).toContain('SUBAGENT.md');
  });
});

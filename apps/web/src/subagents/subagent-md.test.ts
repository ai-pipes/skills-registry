import { describe, expect, it } from 'vite-plus/test';
import { parseSubagentForm, serializeSubagentForm, type SubagentForm } from './subagent-md.ts';

const base: SubagentForm = {
  name: 'devops',
  description: 'Use for Dockerfiles.',
  model: 'inherit',
  tools: null,
  skills: [],
  body: 'You are the DevOps engineer.\n',
};

function roundTrip(form: SubagentForm) {
  return parseSubagentForm(serializeSubagentForm(form));
}

describe('serializeSubagentForm', () => {
  it('writes name, description, tools, model, skills in that order and omits defaults', () => {
    const text = serializeSubagentForm({
      ...base,
      tools: ['Read', 'mcp__github__create_pull_request'],
      model: 'sonnet',
      skills: ['release-runbook'],
    });
    expect(text).toBe(
      [
        '---',
        'name: devops',
        'description: Use for Dockerfiles.',
        'tools:',
        '  - Read',
        '  - mcp__github__create_pull_request',
        'model: sonnet',
        'skills:',
        '  - release-runbook',
        '---',
        'You are the DevOps engineer.\n',
      ].join('\n'),
    );
  });

  it('omits tools, model and skills when they are the defaults', () => {
    expect(serializeSubagentForm(base)).toBe(
      '---\nname: devops\ndescription: Use for Dockerfiles.\n---\nYou are the DevOps engineer.\n',
    );
  });
});

describe('parseSubagentForm', () => {
  it('round-trips a form with tools: null', () => {
    expect(roundTrip(base)).toEqual({ ok: true, value: base });
  });

  it('round-trips MCP tools, a model and skills', () => {
    const form: SubagentForm = {
      ...base,
      tools: ['Bash', 'mcp__github__create_pull_request'],
      model: 'haiku',
      skills: ['a', 'b-c'],
    };
    expect(roundTrip(form)).toEqual({ ok: true, value: form });
  });

  it('round-trips a YAML-hostile description (colon, quotes, newline)', () => {
    const form: SubagentForm = {
      ...base,
      description: 'Use when: "quoted" and \'single\' # not a comment\nsecond line: here',
    };
    expect(roundTrip(form)).toEqual({ ok: true, value: form });
  });

  it('round-trips a body that starts with ---', () => {
    const form: SubagentForm = { ...base, body: '---\nnot frontmatter\n---\ntext\n' };
    expect(roundTrip(form)).toEqual({ ok: true, value: form });
  });

  it('round-trips an empty body', () => {
    const form: SubagentForm = { ...base, body: '' };
    expect(roundTrip(form)).toEqual({ ok: true, value: form });
  });

  it('defaults model to inherit, tools to null and skills to []', () => {
    const parsed = parseSubagentForm('---\nname: a\ndescription: d\n---\nbody');
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: 'a',
        description: 'd',
        model: 'inherit',
        tools: null,
        skills: [],
        body: 'body',
      },
    });
  });

  it.each([
    ['no frontmatter', 'just text', 'frontmatter'],
    ['broken yaml', '---\nname: [\n---\n', 'YAML'],
    ['an unknown key', '---\nname: a\ndescription: d\ncolor: red\n---\n', 'color'],
    ['no description', '---\nname: a\n---\n', 'description'],
    ['an empty tools list', '---\nname: a\ndescription: d\ntools: []\n---\n', 'tools'],
    ['a wildcard tool', '---\nname: a\ndescription: d\ntools: [mcp__x__*]\n---\n', 'mcp__x__*'],
    ['duplicate tools', '---\nname: a\ndescription: d\ntools: [Read, Read]\n---\n', 'duplicates'],
    ['an unknown model', '---\nname: a\ndescription: d\nmodel: gpt\n---\n', 'model'],
    ['a bad skill slug', '---\nname: a\ndescription: d\nskills: [Bad Slug]\n---\n', 'Bad Slug'],
  ])('rejects %s', (_label, text, mention) => {
    const parsed = parseSubagentForm(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(mention);
  });
});

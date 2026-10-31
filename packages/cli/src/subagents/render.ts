import type { SubagentView } from '@skills/contracts';
import { BUILTIN_TOOL_PATTERN, MCP_TOOL_PATTERN, SubagentModel } from '@skills/contracts';
import { stringify } from 'yaml';
import { MCP_SERVER_RE } from './installed.ts';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The same shape the server stores (domain/frontmatter.ts); the body is what follows the block.
const FRONTMATTER_RE = /^---\n(?:[\s\S]*?\n)?---(?:\n([\s\S]*))?$/;

const invalid = (why: string) => new Error(`invalid subagent from the registry: ${why}`);

/** The `.claude/agents/<slug>.md` text for a registry subagent (spec §11.2). */
export function renderSubagent(v: SubagentView, mcpServer: string): string {
  if (!SLUG.test(v.slug)) throw invalid(`slug "${v.slug}"`);
  if (!MCP_SERVER_RE.test(mcpServer)) throw new Error(`invalid MCP server name "${mcpServer}"`);
  const model = SubagentModel.safeParse(v.model);
  if (!model.success) throw invalid(`model "${v.model}"`);
  for (const t of v.tools ?? []) {
    if (!BUILTIN_TOOL_PATTERN.test(t) && !MCP_TOOL_PATTERN.test(t)) {
      throw invalid(`tool "${t}"`);
    }
  }
  if (v.tools?.length === 0) throw invalid('empty tools list');

  const normalized = v.content.replace(/^﻿/, '').replaceAll('\r\n', '\n');
  const match = FRONTMATTER_RE.exec(normalized);
  if (match === null) throw invalid('SUBAGENT.md has no frontmatter');
  const body = match[1] ?? '';

  const front: Record<string, string> = { name: v.slug, description: v.description };
  if (v.tools !== null) {
    const tools = [...v.tools];
    if (v.skills.length > 0) {
      for (const extra of [`mcp__${mcpServer}__get_skill`, `mcp__${mcpServer}__search_skills`]) {
        if (!tools.includes(extra)) tools.push(extra);
      }
    }
    front['tools'] = tools.join(', ');
  }
  if (model.data !== 'inherit') front['model'] = model.data;

  const block =
    v.skills.length > 0
      ? `Before starting, load each of these skills with the \`get_skill\` tool of the \`${mcpServer}\` MCP server and follow them: ${v.skills.map((s) => `\`${s}\``).join(', ')}.\n` +
        'If a skill cannot be loaded, stop and report it instead of improvising.\n\n'
      : '';
  // lineWidth 0: no folding, so a value never spans lines except as a quoted scalar.
  return `---\n${stringify(front, { lineWidth: 0 })}---\n${block}${body}`;
}

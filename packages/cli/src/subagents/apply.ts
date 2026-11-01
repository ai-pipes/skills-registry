import type { SubagentView } from '@skills/contracts';
import { parse } from 'yaml';
import { safe } from '../output.ts';
import { sha256 } from '../manifest.ts';
import { type InstalledEntry, writeInstalled, writeSubagentFile } from './installed.ts';
import { renderSubagent } from './render.ts';
import type { Scope } from './scope.ts';

/** `tools` as the user reads it. */
export const toolsText = (tools: string[] | null): string =>
  tools === null ? 'all tools' : tools.join(', ');

/** `null` when the two tool sets are the same; otherwise how the permissions moved. */
function toolsChange(from: string[] | null, to: string[] | null): string | null {
  if (from === null && to === null) return null;
  if (from === null || to === null) return `${toolsText(from)} → ${toolsText(to)}`;
  const added = to.filter((t) => !from.includes(t));
  const removed = from.filter((t) => !to.includes(t));
  if (added.length === 0 && removed.length === 0) return null;
  return [...added.map((t) => `+${t}`), ...removed.map((t) => `-${t}`)].join(' ');
}

const FILE_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const BLOCK_RE = /^(Before starting, [^\n]*\nIf a skill cannot be loaded[^\n]*\n\n)([\s\S]*)$/;

/** The parts of a rendered file that `update` reports changes in. */
function parts(text: string) {
  const m = FILE_RE.exec(text);
  const front: unknown = m === null ? {} : parse(m[1] ?? '');
  const fm =
    typeof front === 'object' && front !== null ? Object.fromEntries(Object.entries(front)) : {};
  const rest = m?.[2] ?? '';
  const block = BLOCK_RE.exec(rest);
  return {
    description: fm['description'],
    model: fm['model'] ?? 'inherit',
    skills: block?.[1] ?? '',
    prompt: block?.[2] ?? rest,
  };
}

/** Which of description, model, tools, skills and prompt differ between two rendered files. */
function changedFields(oldText: string, newText: string, toolsMoved: boolean): string[] {
  const a = parts(oldText);
  const b = parts(newText);
  const fields = [
    ...(a.description === b.description ? [] : ['description']),
    ...(a.model === b.model ? [] : ['model']),
    ...(toolsMoved ? ['tools'] : []),
    ...(a.skills === b.skills ? [] : ['skills']),
    ...(a.prompt === b.prompt ? [] : ['prompt']),
  ];
  return fields;
}

/**
 * Rewrites an installed subagent of ours with a different version, unless the tools gate holds it
 * back (spec §11.5). `false` when held back; the file is then untouched.
 */
export async function applyUpdate(
  s: Scope,
  slug: string,
  entry: InstalledEntry,
  view: SubagentView,
  opts: { yes: boolean; mcpServer: string; oldText: string },
): Promise<boolean> {
  const change = toolsChange(entry.tools, view.tools);
  if (change !== null && !opts.yes) {
    s.env.err(`permissions changed for ${safe(slug)}: ${safe(change)}; rerun with --yes to apply`);
    return false;
  }
  const text = renderSubagent(view, opts.mcpServer);
  await writeSubagentFile(s.dir, slug, text);
  s.manifest.subagents[slug] = {
    server: s.server,
    version: view.version,
    sha256: sha256(new TextEncoder().encode(text)),
    mcpServer: opts.mcpServer,
    tools: view.tools,
  };
  await writeInstalled(s.dir, s.manifest);
  const fields = changedFields(opts.oldText, text, change !== null);
  s.env.out(
    `updated ${safe(slug)} v${entry.version} → v${view.version} (${fields.length > 0 ? fields.join(', ') : 'no field changes'})`,
  );
  return true;
}

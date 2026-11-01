import type { SubagentView } from '@skills/contracts';
import { parse, UsageError } from '../args.ts';
import type { Command } from '../env.ts';
import { inSequence } from '../install/layout.ts';
import { sha256 } from '../manifest.ts';
import { safe } from '../output.ts';
import { applyUpdate, toolsText } from '../subagents/apply.ts';
import { inspectSubagent, writeInstalled, writeSubagentFile } from '../subagents/installed.ts';
import { renderSubagent } from '../subagents/render.ts';
import { checkMcpServer, openScope, type Scope } from '../subagents/scope.ts';
import { selectSubagentTarget } from '../subagents/target.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkSlug } from '../slug.ts';

const options = {
  global: { type: 'boolean', short: 'g' },
  agent: { type: 'string', short: 'a', multiple: true },
  folder: { type: 'string' },
  'mcp-server': { type: 'string' },
  force: { type: 'boolean' },
  yes: { type: 'boolean' },
} as const;

/** `mcpServer` is set only when `--mcp-server` was given; otherwise the recorded name or `skills`. */
type Opts = { force: boolean; yes: boolean; mcpServer: string | undefined };

const summary = (v: SubagentView) =>
  `model ${v.model}; tools ${toolsText(v.tools)}; skills ${v.skills.length > 0 ? v.skills.join(', ') : 'none'}`;

async function installOne(s: Scope, slug: string, o: Opts): Promise<boolean> {
  const { env } = s;
  const view = await s.client.getSubagent(slug);
  if (view === null) {
    env.err(`error: subagent ${safe(slug)} not found`);
    return false;
  }
  if (view.status === 'archived') {
    env.err(`error: subagent ${safe(slug)} is archived`);
    return false;
  }
  const path = join(s.dir, `${slug}.md`);
  const state = await inspectSubagent(s.dir, slug, s.server, s.manifest);
  if (state === 'foreign' && !o.force) {
    env.err(
      `conflict: ${safe(path)} was not installed by skills-registry or was modified; use --force`,
    );
    return false;
  }
  if (state !== 'absent' && state !== 'foreign') {
    if (state.version === view.version) {
      env.out(`${safe(slug)} v${view.version} is already installed`);
      return true;
    }
    const oldText = await readFile(path, 'utf8');
    return applyUpdate(s, slug, state, view, {
      yes: o.yes,
      mcpServer: o.mcpServer ?? state.mcpServer,
      oldText,
    });
  }
  const mcpServer = o.mcpServer ?? 'skills';
  const text = renderSubagent(view, mcpServer);
  await writeSubagentFile(s.dir, slug, text);
  s.manifest.subagents[slug] = {
    server: s.server,
    version: view.version,
    sha256: sha256(new TextEncoder().encode(text)),
    mcpServer,
    tools: view.tools,
  };
  await writeInstalled(s.dir, s.manifest);
  env.out(`installed ${safe(slug)} v${view.version} (${summary(view)}) → ${safe(path)}`);
  return true;
}

/** `subagent install <slug>... [--folder <slug>] [-g] [-a claude-code] [--mcp-server <name>] [--force] [--yes]`. */
export const subagentInstall: Command = async (args, env) => {
  const { values, positionals } = parse(args, options, { min: 0, max: Infinity });
  const slugs = positionals.map((p) => checkSlug(p, 'subagent'));
  if (slugs.length === 0 && values.folder === undefined) throw new UsageError('missing argument');
  const given = values['mcp-server'];
  const mcpServer = given === undefined ? undefined : checkMcpServer(given);
  selectSubagentTarget(values.agent ?? [], env);
  const s = await openScope(env, values.global ?? false);
  const o: Opts = { force: values.force ?? false, yes: values.yes ?? false, mcpServer };

  let folderOk = true;
  if (values.folder !== undefined) {
    const inFolder = await s.client.listSubagents({ folder: values.folder });
    if (inFolder.length === 0) {
      env.err(`error: folder ${safe(values.folder)} has no active subagents`);
      folderOk = false;
    }
    slugs.push(...inFolder.map((a) => a.slug));
  }
  const results = await inSequence([...new Set(slugs)], async (slug) => {
    try {
      return await installOne(s, slug, o);
    } catch (e) {
      env.err(`error: ${safe(slug)}: ${safe(e instanceof Error ? e.message : String(e))}`);
      return false;
    }
  });
  return folderOk && results.every(Boolean) ? 0 : 1;
};

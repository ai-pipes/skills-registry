import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  getSkill,
  getSkillFile,
  listFolders,
  type SkillView,
} from '../../modules/catalog/index.ts';
import { searchSkills } from '../../modules/search/index.ts';
import { errorFields } from '../../shared-kernel/index.ts';
import type { Container } from '../container.ts';

const SEARCH_DESCRIPTION =
  "Search the user's skill library. Returns only skills that passed a relevance threshold, best first, with slug, name, description, folder and a score from 0 to 1 (1 = top match by both keyword and meaning, up to 0.5 = matched by one of them). An empty list means no skill fits. Optional folders (slugs from list_folders) limits the search to those folders.";
const LIST_FOLDERS_DESCRIPTION =
  "List the active folders that group the user's skills by topic or project: slug, name, description and number of skills. Use the slugs as search_skills folders when the task clearly belongs to some of them.";
const GET_DESCRIPTION =
  'Get the latest version of a skill. Without path returns SKILL.md and the list of other files. With path returns that text file.';

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const failure = (t: string): CallToolResult => ({ ...text(t), isError: true });
const structured = (value: Record<string, unknown>): CallToolResult => ({
  ...text(JSON.stringify(value)),
  structuredContent: value,
});
const notFound = (slug: string) => failure(`Skill "${slug}" not found.`);

const SearchResult = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  folder: z.string(),
  score: z.number(),
});

/**
 * Unexpected failures (database down, …) become a generic tool error; the SDK would otherwise
 * send the raw exception message to the client. Logged without arguments or content.
 */
function guarded<A>(
  c: Container,
  tool: string,
  fn: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      c.logger.error({ tool, err: errorFields(error) }, 'mcp tool failed');
      return failure('Internal error.');
    }
  };
}

/** The active skill, or null when it does not exist, is archived or the slug is invalid. */
async function activeSkill(c: Container, slug: string): Promise<SkillView | null> {
  const found = await getSkill(c.catalog, { slug });
  return found.ok && found.value.status === 'active' ? found.value : null;
}

/** Read-only tools: list folders, search and fetch the latest version. Nothing here can change a skill. */
export function registerTools(server: McpServer, c: Container): void {
  server.registerTool(
    'search_skills',
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(25).default(10),
        folders: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
      }),
      outputSchema: z.object({ results: z.array(SearchResult) }),
      annotations: { readOnlyHint: true },
    },
    guarded(
      c,
      'search_skills',
      async ({
        query,
        limit,
        folders,
      }: {
        query: string;
        limit: number;
        folders?: string[] | undefined;
      }) => {
        let wanted: string[] | undefined;
        if (folders !== undefined) {
          const known = new Set(
            (await listFolders(c.catalog, { status: 'active' })).map((f) => f.slug),
          );
          const unknown = folders.find((slug) => !known.has(slug));
          if (unknown !== undefined)
            return failure(`Unknown folder "${unknown}". Call list_folders.`);
          wanted = [...new Set(folders)];
        }
        const hits = await searchSkills(c.search, {
          query,
          limit,
          ...(wanted ? { folders: wanted } : {}),
        });
        const results = hits.map(({ slug, name, description, folder, score }) => ({
          slug,
          name,
          description,
          folder,
          score,
        }));
        return structured({ results });
      },
    ),
  );

  server.registerTool(
    'list_folders',
    {
      description: LIST_FOLDERS_DESCRIPTION,
      inputSchema: z.object({}),
      outputSchema: z.object({
        folders: z.array(
          z.object({
            slug: z.string(),
            name: z.string(),
            description: z.string(),
            skills: z.number(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded(c, 'list_folders', async () => {
      const all = await listFolders(c.catalog, { status: 'active' });
      return structured({
        folders: all.map((f) => ({
          slug: f.slug,
          name: f.name,
          description: f.description,
          skills: f.skills.active,
        })),
      });
    }),
  );

  server.registerTool(
    'get_skill',
    {
      description: GET_DESCRIPTION,
      inputSchema: z.object({ slug: z.string(), path: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    guarded(c, 'get_skill', async ({ slug, path }: { slug: string; path?: string | undefined }) => {
      const skill = await activeSkill(c, slug);
      if (!skill) return notFound(slug);
      if (path === undefined) {
        return structured({
          slug: skill.slug,
          version: skill.version,
          name: skill.name,
          description: skill.description,
          folder: skill.folder.slug,
          skillMd: skill.skillMd,
          files: skill.files.map((f) => ({ path: f.path, size: f.size })),
        });
      }
      // Pin the version just read, so SKILL.md and its files come from the same version.
      const file = await getSkillFile(c.catalog, { slug, path, version: skill.version });
      if (!file.ok) {
        const { code, message } = file.error;
        if (code === 'invalid_path') return failure(`Invalid path "${path}": ${message}.`);
        if (code === 'file_not_found')
          return failure(`File "${path}" not found in skill "${slug}".`);
        return notFound(slug);
      }
      if (file.value.binary) {
        return failure(`Binary file, ${file.value.size} bytes. Available only in the web UI.`);
      }
      return text(new TextDecoder().decode(file.value.bytes));
    }),
  );
}

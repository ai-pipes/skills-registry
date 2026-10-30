// Smoke check of the MCP endpoint, as Claude Code would use it: connect with a Bearer token,
// call search_skills and expect `<slug>` as the top hit, then load it with get_skill.
// With `-` as the slug, expect no results at all (an unrelated query).
//
// Usage: node scripts/smoke-mcp.mjs <base-url> <query> <slug|->   (token in $SMOKE_TOKEN)
// Exit codes: 0 as expected, 1 not as expected (yet), 2 bad usage.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [baseUrl, query, slug] = process.argv.slice(2);
const token = process.env.SMOKE_TOKEN;
if (!baseUrl || !query || !slug || !token) {
  console.error('Usage: SMOKE_TOKEN=sk_… node scripts/smoke-mcp.mjs <base-url> <query> <slug|->');
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);
try {
  const search = await client.callTool({ name: 'search_skills', arguments: { query } });
  const results = search.structuredContent?.results ?? [];
  const found = results.map((r) => `${r.slug} (${r.score.toFixed(3)})`).join(', ');
  console.log(`search_skills(${JSON.stringify(query)}) → ${found || 'no results'}`);
  if (search.isError) process.exit(1);
  if (slug === '-') process.exit(results.length === 0 ? 0 : 1);
  if (results[0]?.slug !== slug) process.exit(1);

  const skill = await client.callTool({ name: 'get_skill', arguments: { slug } });
  const body = skill.structuredContent;
  if (skill.isError || body?.slug !== slug || !String(body.skillMd).startsWith('---')) {
    console.error(`get_skill(${slug}) failed: ${JSON.stringify(skill.content)}`);
    process.exit(1);
  }
  console.log(`get_skill(${slug}) → version ${body.version}, ${body.files.length} file(s)`);
} finally {
  await client.close();
}

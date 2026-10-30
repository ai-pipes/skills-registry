import { parse, UsageError } from '../args.ts';
import { saveConnection } from '../config.ts';
import type { Command } from '../env.ts';
import { safe } from '../output.ts';
import { RegistryClient } from '../registry.ts';

/** `login <url>`: reads the token (no echo on a TTY), checks it against the server, saves it. */
export const loginCommand: Command = async (args, env) => {
  const { positionals } = parse(args, {}, { min: 1, max: 1 });
  const raw = positionals[0] ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`invalid server URL "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`invalid server URL "${raw}": use http:// or https://`);
  }
  const server = url.href.replace(/\/+$/, '');
  const token = (await env.readSecret('Token: ')).trim();
  if (token === '') throw new UsageError('no token given');
  const me = await new RegistryClient({ url: server, token }, env.fetch).me();
  await saveConnection(env, { url: server, token });
  env.out(`logged in to ${server} as ${safe(me.login)}`);
  return 0;
};

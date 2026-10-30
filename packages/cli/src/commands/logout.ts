import { parse } from '../args.ts';
import { deleteConnection } from '../config.ts';
import type { Command } from '../env.ts';

/** `logout`: removes the saved connection (environment variables are not affected). */
export const logoutCommand: Command = async (args, env) => {
  parse(args, {}, { min: 0, max: 0 });
  env.out((await deleteConnection(env)) ? 'logged out' : 'not logged in');
  return 0;
};

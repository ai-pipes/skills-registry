import { describe, expect, it } from 'vite-plus/test';
import { makeEnv, seedUser } from '../../../../test/identity/fakes.ts';
import { loginsByIds } from './lookup.ts';

describe('loginsByIds', () => {
  it('maps known ids to logins, drops unknown ones and deduplicates', async () => {
    const env = makeEnv();
    const alice = await seedUser(env, 'alice');
    const bob = await seedUser(env, 'bob');
    const r = await loginsByIds(env.deps, [alice.id, 'not-a-uuid', alice.id, bob.id]);
    expect(r).toEqual(
      new Map([
        [alice.id, 'alice'],
        [bob.id, 'bob'],
      ]),
    );
    expect(env.users.lookups).toEqual([[alice.id, 'not-a-uuid', bob.id]]);
  });

  it('skips the repository for an empty list', async () => {
    const env = makeEnv();
    expect(await loginsByIds(env.deps, [])).toEqual(new Map());
    expect(env.users.lookups).toEqual([]);
  });
});

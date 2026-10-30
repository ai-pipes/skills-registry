import { indexSkill } from './index-skill.ts';
import type { SearchDeps } from './ports.ts';

export type EventHandler = (payload: Record<string, unknown>) => Promise<void>;

const SUBSCRIBED = [
  'catalog.skill_version_created',
  'catalog.skill_archived',
  'catalog.skill_restored',
  'catalog.skill_moved',
] as const;

/** Outbox handlers: every subscribed Catalog event re-syncs the skill's document by slug. */
export function searchEventHandlers(deps: SearchDeps): Record<string, EventHandler> {
  const handle: EventHandler = async (payload) => {
    const slug = payload['slug'];
    if (typeof slug !== 'string') throw new Error('event payload has no slug');
    await indexSkill(deps, { slug });
  };
  return Object.fromEntries(SUBSCRIBED.map((type) => [type, handle]));
}

import { indexDocument } from './index-document.ts';
import type { DocumentKind, SearchDeps } from './ports.ts';

export type EventHandler = (payload: Record<string, unknown>) => Promise<void>;

const SUBSCRIBED: Record<string, DocumentKind> = {
  'catalog.skill_version_created': 'skill',
  'catalog.skill_archived': 'skill',
  'catalog.skill_restored': 'skill',
  'catalog.skill_moved': 'skill',
  'catalog.subagent_version_created': 'subagent',
  'catalog.subagent_archived': 'subagent',
  'catalog.subagent_restored': 'subagent',
  'catalog.subagent_moved': 'subagent',
};

/** Outbox handlers: every subscribed Catalog event re-syncs that kind's document by slug. */
export function searchEventHandlers(deps: SearchDeps): Record<string, EventHandler> {
  return Object.fromEntries(
    Object.entries(SUBSCRIBED).map(([type, kind]): [string, EventHandler] => [
      type,
      async (payload) => {
        const slug = payload['slug'];
        if (typeof slug !== 'string') throw new Error('event payload has no slug');
        await indexDocument(deps, { kind, slug });
      },
    ]),
  );
}

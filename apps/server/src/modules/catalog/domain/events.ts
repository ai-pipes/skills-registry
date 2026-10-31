import type { DomainEvent } from '../../../shared-kernel/index.ts';

const SKILL_VERSION_CREATED = 'catalog.skill_version_created';
const SKILL_ARCHIVED = 'catalog.skill_archived';
const SKILL_RESTORED = 'catalog.skill_restored';

export const skillVersionCreated = (
  p: { skillId: string; slug: string; version: number },
  occurredAt: Date,
): DomainEvent => ({ type: SKILL_VERSION_CREATED, occurredAt, payload: { ...p } });

export const skillArchived = (
  p: { skillId: string; slug: string },
  occurredAt: Date,
): DomainEvent => ({ type: SKILL_ARCHIVED, occurredAt, payload: { ...p } });

export const skillRestored = (
  p: { skillId: string; slug: string },
  occurredAt: Date,
): DomainEvent => ({ type: SKILL_RESTORED, occurredAt, payload: { ...p } });

export const skillMoved = (
  p: { skillId: string; slug: string; folder: string },
  occurredAt: Date,
): DomainEvent => ({ type: 'catalog.skill_moved', occurredAt, payload: { ...p } });

export const subagentVersionCreated = (
  p: { subagentId: string; slug: string; version: number },
  occurredAt: Date,
): DomainEvent => ({ type: 'catalog.subagent_version_created', occurredAt, payload: { ...p } });

export const subagentArchived = (
  p: { subagentId: string; slug: string },
  occurredAt: Date,
): DomainEvent => ({ type: 'catalog.subagent_archived', occurredAt, payload: { ...p } });

export const subagentRestored = (
  p: { subagentId: string; slug: string },
  occurredAt: Date,
): DomainEvent => ({ type: 'catalog.subagent_restored', occurredAt, payload: { ...p } });

export const subagentMoved = (
  p: { subagentId: string; slug: string; folder: string },
  occurredAt: Date,
): DomainEvent => ({ type: 'catalog.subagent_moved', occurredAt, payload: { ...p } });

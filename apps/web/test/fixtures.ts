import type {
  FolderSummary,
  MeResponse,
  SkillSource,
  SkillSummary,
  UserSummary,
} from '@skills/contracts';

export const adminMe: MeResponse = { login: 'admin', role: 'admin' };

export const memberMe: MeResponse = { login: 'alice', role: 'member' };

export const skillSummary: SkillSummary = {
  slug: 'code-review',
  name: 'code-review',
  description: 'Reviews a diff for correctness bugs.',
  status: 'active',
  folder: { slug: 'general', name: 'General' },
  version: 1,
  updatedAt: '2026-10-28T12:00:00.000Z',
};

export const generalFolder: FolderSummary = {
  slug: 'general',
  name: 'General',
  description: 'General skills without a specific topic',
  status: 'active',
  skills: { active: 1, archived: 0 },
};

export const devopsFolder: FolderSummary = {
  slug: 'devops',
  name: 'DevOps',
  description: 'Builds, deploys, CI',
  status: 'active',
  skills: { active: 0, archived: 0 },
};

export const oldFolder: FolderSummary = {
  slug: 'old-project',
  name: 'Old project',
  description: 'Project archive',
  status: 'archived',
  skills: { active: 0, archived: 2 },
};

/** An upstream commit (40 hex) whose short form is `a1b2c3d`. */
export const importedCommit = 'a1b2c3d' + '0'.repeat(33);

export const importedSource: SkillSource = {
  host: 'github.com',
  repo: 'anthropics/skills',
  path: 'skills/mcp-builder',
  ref: 'main',
  syncedVersion: 1,
};

/** Users as `GET /api/users` lists them: `admin` (local), `alice` (SSO), `bob` (disabled, never signed in). */
export const adminUser: UserSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  login: 'admin',
  role: 'admin',
  disabled: false,
  createdAt: '2026-10-01T12:00:00.000Z',
  sso: false,
  email: null,
  lastLoginAt: '2026-10-29T12:00:00.000Z',
};

export const aliceUser: UserSummary = {
  id: '22222222-2222-4222-8222-222222222222',
  login: 'alice',
  role: 'member',
  disabled: false,
  createdAt: '2026-10-02T12:00:00.000Z',
  sso: true,
  email: 'alice@example.com',
  lastLoginAt: '2026-10-28T12:00:00.000Z',
};

export const bobUser: UserSummary = {
  id: '33333333-3333-4333-8333-333333333333',
  login: 'bob',
  role: 'member',
  disabled: true,
  createdAt: '2026-10-03T12:00:00.000Z',
  sso: false,
  email: null,
  lastLoginAt: null,
};

import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  clearAllDrafts,
  clearDraft,
  draftKey,
  freezeDrafts,
  loadDraft,
  NEW_DRAFT,
  saveDraft,
  unfreezeDrafts,
  type Draft,
} from './draft.ts';

afterEach(() => {
  sessionStorage.clear();
  unfreezeDrafts();
});

const draft: Draft = {
  user: 'alice',
  slug: 'demo',
  baseVersion: 3,
  message: 'wip',
  files: [
    { path: 'SKILL.md', kind: 'text', text: '---\nname: demo\n---\n', size: 19 },
    { path: 'a.md', kind: 'kept', text: 'base text', size: 9 },
    {
      path: 'logo.png',
      kind: 'upload',
      file: new File([new Uint8Array([1])], 'logo.png'),
      size: 1,
    },
  ],
  reupload: [],
};

describe('draft', () => {
  it('is stored in sessionStorage under draft:<slug>, draft:new for a new skill', () => {
    expect(draftKey('demo')).toBe('draft:demo');
    expect(draftKey(NEW_DRAFT)).toBe('draft:new');
    saveDraft('demo', draft);
    expect(sessionStorage.getItem('draft:demo')).not.toBeNull();
    expect(sessionStorage.getItem('draft:new')).toBeNull();
  });

  it('round-trips text and kept files; uploads become "upload again" paths', () => {
    saveDraft('demo', draft);
    expect(loadDraft('demo', 'alice')).toEqual({
      user: 'alice',
      slug: 'demo',
      baseVersion: 3,
      message: 'wip',
      files: [
        { path: 'SKILL.md', kind: 'text', text: '---\nname: demo\n---\n', size: 19 },
        { path: 'a.md', kind: 'kept', size: 9 },
      ],
      reupload: ['logo.png'],
    });
    expect(sessionStorage.getItem('draft:demo')).not.toContain('base text');
  });

  it('keeps paths still waiting for an upload across saves', () => {
    saveDraft(NEW_DRAFT, { user: 'alice', slug: '', message: '', files: [], reupload: ['x.bin'] });
    expect(loadDraft(NEW_DRAFT, 'alice')?.reupload).toEqual(['x.bin']);
  });

  it('stores and restores the folder of a new skill', () => {
    saveDraft(NEW_DRAFT, {
      user: 'alice',
      slug: 'x',
      folder: 'devops',
      message: '',
      files: [],
      reupload: [],
    });
    expect(loadDraft(NEW_DRAFT, 'alice')?.folder).toBe('devops');
    saveDraft(NEW_DRAFT, { user: 'alice', slug: 'x', message: '', files: [], reupload: [] });
    expect(loadDraft(NEW_DRAFT, 'alice')?.folder).toBeUndefined();
  });

  it('returns null when there is no draft or it is not a draft', () => {
    expect(loadDraft('demo', 'alice')).toBeNull();
    sessionStorage.setItem('draft:demo', '{"files": 1}');
    expect(loadDraft('demo', 'alice')).toBeNull();
    sessionStorage.setItem('draft:demo', 'not json');
    expect(loadDraft('demo', 'alice')).toBeNull();
  });

  it('clearDraft removes it', () => {
    saveDraft('demo', draft);
    clearDraft('demo');
    expect(loadDraft('demo', 'alice')).toBeNull();
  });

  it("is never returned to another user, and that user's load removes it", () => {
    saveDraft('demo', draft);
    expect(loadDraft('demo', 'bob')).toBeNull();
    expect(sessionStorage.getItem('draft:demo')).toBeNull();
  });

  it('clearAllDrafts removes every draft:* key and nothing else', () => {
    saveDraft('demo', draft);
    saveDraft(NEW_DRAFT, draft);
    sessionStorage.setItem('other', 'x');
    clearAllDrafts();
    expect(Object.keys(sessionStorage)).toEqual(['other']);
  });

  it('writes nothing while frozen (a logout is in progress)', () => {
    freezeDrafts();
    saveDraft('demo', draft);
    expect(sessionStorage.getItem('draft:demo')).toBeNull();
    unfreezeDrafts();
    saveDraft('demo', draft);
    expect(sessionStorage.getItem('draft:demo')).not.toBeNull();
  });
});

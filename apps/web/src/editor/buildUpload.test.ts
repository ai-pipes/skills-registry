import { describe, expect, it } from 'vite-plus/test';
import { buildUpload } from './buildUpload.ts';
import type { DraftFile } from './draft.ts';

function part(form: FormData, name: string): Blob {
  const value = form.get(name);
  if (!(value instanceof Blob)) throw new Error(`${name} is not a file part`);
  return value;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== 'string') throw new Error(`${name} is not a text field`);
  return value;
}

const partText = (form: FormData, name: string) => part(form, name).text();

describe('buildUpload', () => {
  it('puts kept paths into keep (JSON), text files as UTF-8 parts, uploads as their File', async () => {
    const upload = new File([new Uint8Array([0, 1, 2])], 'logo.png', { type: 'image/png' });
    // Cyrillic text on purpose: the part must round-trip as UTF-8.
    const files: DraftFile[] = [
      { path: 'SKILL.md', kind: 'text', text: '---\nname: demo\n---\nПривет', size: 30 },
      { path: 'references/a.md', kind: 'kept', size: 10 },
      { path: 'references/b.md', kind: 'kept', text: 'cached base text', size: 16 },
      { path: 'assets/logo.png', kind: 'upload', file: upload, size: 3 },
    ];
    const form = buildUpload({ baseVersion: 4, message: 'fix typo', files });

    expect(form.get('baseVersion')).toBe('4');
    expect(form.get('message')).toBe('fix typo');
    expect(JSON.parse(field(form, 'keep'))).toEqual(['references/a.md', 'references/b.md']);
    expect(form.has('slug')).toBe(false);
    expect(await partText(form, 'SKILL.md')).toBe('---\nname: demo\n---\nПривет');
    const sent = part(form, 'assets/logo.png');
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2]));
    // Kept files are never sent as parts, even with a cached text.
    expect(form.has('references/a.md')).toBe(false);
    expect(form.has('references/b.md')).toBe(false);
    const names = [...form.keys()].toSorted();
    expect(names).toEqual(['SKILL.md', 'assets/logo.png', 'baseVersion', 'keep', 'message']);
  });

  it('sends a text file as UTF-8 bytes', async () => {
    // 'ё' (U+0451) is two bytes in UTF-8: 0xd1 0x91.
    const form = buildUpload({
      baseVersion: 1,
      message: '',
      files: [{ path: 'SKILL.md', kind: 'text', text: 'ё', size: 2 }],
    });
    const bytes = await part(form, 'SKILL.md').arrayBuffer();
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([0xd1, 0x91]));
  });

  it('for a new skill sends slug and no baseVersion or keep', async () => {
    const form = buildUpload({
      slug: 'new-skill',
      message: 'first',
      files: [{ path: 'SKILL.md', kind: 'text', text: 'x', size: 1 }],
    });
    expect(form.get('slug')).toBe('new-skill');
    expect(form.has('baseVersion')).toBe(false);
    expect(form.has('keep')).toBe(false);
    expect(await partText(form, 'SKILL.md')).toBe('x');
  });

  it('with only SKILL.md changed, every other path goes to keep', () => {
    const files: DraftFile[] = [
      { path: 'SKILL.md', kind: 'text', text: 'new', size: 3 },
      { path: 'a.md', kind: 'kept', size: 1 },
      { path: 'dir/b.bin', kind: 'kept', size: 1 },
      { path: 'dir/c.md', kind: 'kept', size: 1 },
    ];
    const form = buildUpload({ baseVersion: 2, message: '', files });
    expect(JSON.parse(field(form, 'keep'))).toEqual(['a.md', 'dir/b.bin', 'dir/c.md']);
    expect([...form.keys()].filter((k) => !['baseVersion', 'message', 'keep'].includes(k))).toEqual(
      ['SKILL.md'],
    );
  });

  it('adds folder when given (creating) and omits it otherwise', () => {
    const files: DraftFile[] = [{ path: 'SKILL.md', kind: 'text', text: 'x', size: 1 }];
    const created = buildUpload({ slug: 'x', folder: 'devops', message: '', files });
    expect(created.get('folder')).toBe('devops');
    expect(buildUpload({ slug: 'x', message: '', files }).has('folder')).toBe(false);
    expect(buildUpload({ baseVersion: 2, message: '', files }).has('folder')).toBe(false);
  });
});

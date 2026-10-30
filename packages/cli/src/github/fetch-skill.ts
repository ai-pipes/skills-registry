import { UsageError } from '../args.ts';
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PATH,
  MAX_SEGMENT,
  MAX_SKILL_BYTES,
  type TarLimits,
} from '../limits.ts';
import type { GithubClient } from './client.ts';
import { parseFrontmatter } from './frontmatter.ts';
import type { GithubTarget } from './source.ts';
import { extractTar } from './tar.ts';

/** A skill read from a GitHub commit: `path` is its directory (`''` = repository root). */
export type FetchedSkill = {
  repo: string;
  ref: string | null;
  path: string;
  commit: string;
  name: string;
  description: string;
  /** Paths relative to the skill directory. */
  files: Map<string, Uint8Array>;
  /**
   * Non-regular members (symlinks, hard links…) of the skill directory and files whose path the
   * registry would not store as is, relative to it.
   */
  skipped: string[];
};

const utf8 = new TextDecoder();
const prefixOf = (dir: string) => (dir === '' ? '' : `${dir}/`);
const under = (dir: string) => (p: string) => dir === '' || p.startsWith(prefixOf(dir));
const label = (repo: string, dir: string) => (dir === '' ? repo : `${repo}/${dir}`);
const isSkillMd = (p: string) => p === 'SKILL.md' || p.endsWith('/SKILL.md');
const dirOfSkillMd = (p: string) => (p === 'SKILL.md' ? '' : p.slice(0, -'/SKILL.md'.length));

/**
 * The registry stores `p` unchanged (its `FilePath.parse` would neither reject nor rewrite it):
 * no `\\`, empty or `.` segments, and within the length limits.
 */
const storedAsIs = (p: string) =>
  !p.includes('\\') &&
  p.length <= MAX_PATH &&
  p.split('/').every((s) => s !== '' && s !== '.' && s.length <= MAX_SEGMENT);

/**
 * Files and skipped members of `dir`, relative to it. A file whose path the registry would store
 * differently is skipped too, so the manifest of an import matches the one an update computes.
 */
function relativeTo(dir: string, all: { files: Map<string, Uint8Array>; skipped: string[] }) {
  const cut = prefixOf(dir).length;
  const inDir = under(dir);
  const files = new Map<string, Uint8Array>();
  const skipped: string[] = [];
  for (const [p, bytes] of all.files) {
    if (!inDir(p)) continue;
    const rel = p.slice(cut);
    if (storedAsIs(rel)) files.set(rel, bytes);
    else skipped.push(rel);
  }
  skipped.push(...all.skipped.filter(inDir).map((p) => p.slice(cut)));
  return { files, skipped };
}

/** The registry's limits, checked before anything is uploaded. */
function checkLimits(files: Map<string, Uint8Array>): void {
  if (files.size > MAX_FILES) {
    throw new Error(`skill has ${files.size} files; the registry allows at most ${MAX_FILES}`);
  }
  let total = 0;
  for (const [p, bytes] of files) {
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error(
        `${p} is ${bytes.length} bytes; the registry allows at most ${MAX_FILE_BYTES}`,
      );
    }
    total += bytes.length;
  }
  if (total > MAX_SKILL_BYTES) {
    throw new Error(`skill is ${total} bytes; the registry allows at most ${MAX_SKILL_BYTES}`);
  }
}

type Content = { files: Map<string, Uint8Array>; skipped: string[] };

/** Checks the skill read from `dir` and builds the result. */
function toSkill(
  target: GithubTarget,
  commit: string,
  dir: string,
  content: Content,
  name: string | null,
): FetchedSkill {
  const skillMd = content.files.get('SKILL.md');
  if (skillMd === undefined) throw new Error(`no SKILL.md in ${label(target.repo, dir)}`);
  const fm = parseFrontmatter(utf8.decode(skillMd));
  if (fm === null) {
    throw new Error(
      `SKILL.md in ${label(target.repo, dir)} has no frontmatter with name and description`,
    );
  }
  if (name !== null && fm.name !== name) {
    throw new Error(`the skill in ${label(target.repo, dir)} is named "${fm.name}", not "${name}"`);
  }
  checkLimits(content.files);
  return {
    repo: target.repo,
    ref: target.ref,
    path: dir,
    commit,
    name: fm.name,
    description: fm.description,
    files: content.files,
    skipped: content.skipped,
  };
}

const lastSegment = (dir: string) => dir.slice(dir.lastIndexOf('/') + 1);

/**
 * Why `name` was not found: `--skill` matches the frontmatter name, not the directory, so the
 * skills in directories called `name` (ignoring case) are suggested. Names and paths come from the
 * repository; the caller prints the message through `safe()`.
 */
function notFound(target: GithubTarget, skills: { dir: string; name: string }[], name: string) {
  const message = `skill "${name}" not found in ${target.repo}`;
  const lower = name.toLowerCase();
  const near = skills.filter((s) => s.dir !== '' && lastSegment(s.dir).toLowerCase() === lower);
  const [only] = near;
  if (only === undefined) return new Error(message);
  if (near.length === 1) {
    return new Error(
      `${message}; directory ${only.dir} holds skill "${only.name}"; pass --skill ${only.name}`,
    );
  }
  const list = near.map((s) => `${s.dir} holds "${s.name}"`).join(', ');
  return new Error(`${message}; directories ${list}; pass --skill with one of these names`);
}

/** The one directory whose SKILL.md is named `name`. */
function dirNamed(target: GithubTarget, first: Content, name: string): string {
  const skills = [...first.files.keys()]
    .filter(isSkillMd)
    .flatMap((p) => {
      const fm = parseFrontmatter(utf8.decode(first.files.get(p)));
      return fm === null ? [] : [{ dir: dirOfSkillMd(p), name: fm.name }];
    })
    .toSorted((a, b) => (a.dir < b.dir ? -1 : 1));
  const dirs = skills.filter((s) => s.name === name).map((s) => s.dir);
  if (dirs.length === 0) throw notFound(target, skills, name);
  if (dirs.length > 1) {
    const list = dirs.map((d) => d || '.').join(', ');
    throw new Error(`skill "${name}" is ambiguous: ${list}; pass a URL with the path`);
  }
  return dirs[0] ?? '';
}

const errorOf = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/**
 * Reads the skills named `names` (in that order) from one commit of `target.repo`, each either
 * the skill or why it could not be read. A first pass keeps every SKILL.md and the paths with a
 * segment equal to one of the names; the directories named differently from their skill are read
 * together in one second pass.
 */
export async function fetchSkills(
  gh: GithubClient,
  target: GithubTarget,
  names: readonly string[],
  limits: TarLimits,
): Promise<(FetchedSkill | Error)[]> {
  const commit = await gh.resolveCommit(target.repo, target.ref);
  const pass = async (keep: (p: string) => boolean) =>
    extractTar(await gh.tarball(target.repo, commit), keep, limits);
  const wanted = new Set(names);
  const first = await pass((p) => isSkillMd(p) || p.split('/').some((s) => wanted.has(s)));
  const found = names.map((name) => {
    try {
      const dir = dirNamed(target, first, name);
      return { name, dir, complete: dir.split('/').includes(name) };
    } catch (e) {
      return errorOf(e);
    }
  });
  const rest = found.flatMap((f) => (f instanceof Error || f.complete ? [] : [under(f.dir)]));
  const second = rest.length === 0 ? null : await pass((p) => rest.some((inDir) => inDir(p)));
  return found.map((f) => {
    if (f instanceof Error) return f;
    try {
      const content = relativeTo(f.dir, f.complete || second === null ? first : second);
      return toSkill(target, commit, f.dir, content, f.name);
    } catch (e) {
      return errorOf(e);
    }
  });
}

/**
 * Downloads the commit of `target` and reads one skill from it: the directory `target.path`, or
 * (without a path) the directory whose SKILL.md is named `name` (see `fetchSkills`).
 */
export async function fetchSkill(
  gh: GithubClient,
  target: GithubTarget,
  name: string | null,
  limits: TarLimits,
): Promise<FetchedSkill> {
  if (target.path === null) {
    if (name === null)
      throw new UsageError('pass --skill <name> or a URL with the path to the skill');
    const [skill = new Error(`skill "${name}" not found`)] = await fetchSkills(
      gh,
      target,
      [name],
      limits,
    );
    if (skill instanceof Error) throw skill;
    return skill;
  }
  const dir = target.path;
  const commit = await gh.resolveCommit(target.repo, target.ref);
  const all = await extractTar(await gh.tarball(target.repo, commit), under(dir), limits);
  return toSkill(target, commit, dir, relativeTo(dir, all), name);
}

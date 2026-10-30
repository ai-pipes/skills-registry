/** A V8 stack frame: `    at fn (file:line:col)` or `    at file:line:col`. */
const FRAME_RE = /^\s{4}at .+:\d+:\d+\)?$/;
/** A short, value-free code: Postgres SQLSTATE (`22P02`), Node errno (`ECONNREFUSED`). */
const CODE_RE = /^[A-Za-z0-9_]{1,32}$/;
const GENERIC = { name: 'Error', frames: [] };

function safeName(error: Error): string {
  const name: unknown = error.name;
  return typeof name === 'string' ? name : 'Error';
}

/**
 * What may be logged about an unexpected error: its name and the stack's `at …` frames.
 * The message is dropped: it can quote user input or skill content (a Postgres
 * `invalid input syntax …: "<value>"`, a JSON.parse snippet), and logs never hold content.
 * The stack's header (`Name: message`, possibly several lines) is cut off before the frames
 * are picked; when it no longer matches the error (message changed after the stack was
 * captured) no frames are kept at all. Only lines of the strict V8 frame shape survive.
 * Total: never throws (throwing `name`/`toString` getters give a generic `Error`).
 */
export function errorFields(error: unknown): { name: string; frames: string[] } {
  try {
    if (!(error instanceof Error)) {
      return { name: error === null ? 'null' : typeof error, frames: [] };
    }
    const name = safeName(error);
    const stack: unknown = error.stack;
    const header = String(error);
    if (typeof stack !== 'string' || !stack.startsWith(header)) return { name, frames: [] };
    const frames = stack
      .slice(header.length)
      .split('\n')
      .filter((l) => FRAME_RE.test(l))
      .map((l) => l.trim());
    return { name, frames };
  } catch {
    return { ...GENERIC };
  }
}

/**
 * A one-line, content-free classification of an error for storage (`outbox.last_error`):
 * the name, plus `: <code>` when the error carries a short code. Never the message.
 */
export function errorLabel(error: unknown): string {
  const { name } = errorFields(error);
  try {
    const code: unknown = error instanceof Error && 'code' in error ? error.code : undefined;
    return typeof code === 'string' && CODE_RE.test(code) ? `${name}: ${code}` : name;
  } catch {
    return name;
  }
}

import type { Context } from 'hono';
import type { z } from 'zod';
import { invalidRequest } from './errors.ts';

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw invalidRequest(`${where}${issue?.message ?? 'invalid input'}`);
  }
  return r.data;
}

/** Parses a JSON body (an empty body counts as `{}`) against a contracts schema. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const text = await c.req.text();
  let body: unknown = {};
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      throw invalidRequest('body is not valid JSON');
    }
  }
  return parse(schema, body);
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parse(schema, c.req.query());
}

/** Multipart body split into text fields (validated) and file parts (by field name). */
export async function readMultipart<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ fields: z.output<S>; files: [name: string, file: File][] }> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
    throw invalidRequest('expected a multipart/form-data body');
  }
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw invalidRequest('malformed multipart body');
  }
  const text: Record<string, string> = {};
  const files: [string, File][] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') text[name] = value;
    else files.push([name, value]);
  }
  return { fields: parse(schema, text), files };
}

#!/usr/bin/env node
// Client CLI entry point (`skills-registry <command>`, see USAGE in cli.ts). Output goes to
// stdout, errors and warnings to stderr.
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { runCli } from './cli.ts';

/**
 * On a TTY: one line typed without echo (readline's own echo goes to a discarding stream; only the
 * prompt is written to stderr). Otherwise the whole of stdin (a pipe or heredoc).
 */
async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    input.setEncoding('utf8');
    let text = '';
    for await (const chunk of input) text += String(chunk);
    return text;
  }
  process.stderr.write(prompt);
  const discard = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const rl = createInterface({ input, output: discard, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      rl.once('line', resolve);
      rl.once('close', () => resolve(''));
    });
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  fetch: globalThis.fetch,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readSecret,
  vars: process.env,
  home: homedir(),
  cwd: process.cwd(),
  platform: process.platform,
});

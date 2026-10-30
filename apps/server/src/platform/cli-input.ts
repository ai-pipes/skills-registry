import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

type Input = NodeJS.ReadableStream & { isTTY?: boolean };

const discard = (): Writable =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

/**
 * Reads the password for `create-user`. On a TTY: one line, typed without echo (readline puts the
 * terminal in raw mode and its own echo goes to a discarding stream; only the prompt is written to
 * `prompt`). Otherwise the whole stream (a pipe or heredoc), returned as is.
 */
export async function readPassword(input: Input, prompt: NodeJS.WritableStream): Promise<string> {
  if (!input.isTTY) {
    input.setEncoding('utf8');
    let text = '';
    for await (const chunk of input) text += String(chunk);
    return text;
  }
  prompt.write('Password: ');
  const rl = createInterface({ input, output: discard(), terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      rl.once('line', resolve);
      rl.once('close', () => resolve(''));
    });
  } finally {
    rl.close();
    prompt.write('\n');
  }
}

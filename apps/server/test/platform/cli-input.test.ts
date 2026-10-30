import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vite-plus/test';
import { readPassword } from '../../src/platform/cli-input.ts';

function fakeTty() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => input,
  });
  return input;
}

function collector() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

describe('readPassword', () => {
  it('on a TTY reads one line and never echoes it to the output stream', async () => {
    const input = fakeTty();
    const out = collector();
    const pending = readPassword(input, out.stream);
    input.write('s3cret-pass-phrase\r');
    expect(await pending).toBe('s3cret-pass-phrase');
    expect(out.text()).not.toContain('s3cret');
    expect(out.text()).toMatch(/^Password: /);
  });

  it('without a TTY reads the whole stream and prints nothing', async () => {
    const input = new PassThrough();
    const out = collector();
    const pending = readPassword(input, out.stream);
    input.end('piped-password\n');
    expect(await pending).toBe('piped-password\n');
    expect(out.text()).toBe('');
  });
});

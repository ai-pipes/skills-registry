import { describe, expect, it } from 'vite-plus/test';
import { errorFields, errorLabel } from './error-fields.ts';

describe('errorFields', () => {
  it('keeps the name and the stack frames, drops the message', () => {
    const e = new TypeError('invalid input syntax for type uuid: "secret-value-xyz"');
    const fields = errorFields(e);
    expect(fields.name).toBe('TypeError');
    expect(fields.frames.length).toBeGreaterThan(0);
    for (const frame of fields.frames) expect(frame).toMatch(/^at /);
    expect(JSON.stringify(fields)).not.toContain('secret-value-xyz');
  });

  it('drops a multi-line message even when a line looks like a frame', () => {
    const e = new Error('line one secret-value-xyz\n    at secret-value-xyz (x.js:1:1)');
    expect(JSON.stringify(errorFields(e))).not.toContain('secret-value-xyz');
  });

  it('handles an error without a stack', () => {
    const e = new RangeError('secret-value-xyz');
    delete e.stack;
    expect(errorFields(e)).toEqual({ name: 'RangeError', frames: [] });
  });

  it('describes a non-Error by its type only', () => {
    expect(errorFields('secret-value-xyz')).toEqual({ name: 'string', frames: [] });
    expect(errorFields(null)).toEqual({ name: 'null', frames: [] });
    expect(errorFields({ message: 'secret-value-xyz' })).toEqual({ name: 'object', frames: [] });
  });

  it('drops everything when the message changed after the stack was captured', () => {
    const e = new Error('first\n    at SECRET (x:1:1)');
    void e.stack; // V8 materializes the stack with the original message
    e.message = `wrapped: ${e.message}`;
    const fields = errorFields(e);
    expect(fields).toEqual({ name: 'Error', frames: [] });
    expect(JSON.stringify(fields)).not.toContain('SECRET');
  });

  it('keeps only lines of the V8 frame shape', () => {
    const e = new Error('m');
    e.stack = [
      'Error: m',
      '    at f (/app/a.js:1:2)',
      '    at /app/b.js:3:4',
      '    at SECRET value without location',
      '  at g (/app/c.js:5:6)',
      'at h (/app/d.js:7:8)',
    ].join('\n');
    expect(errorFields(e).frames).toEqual(['at f (/app/a.js:1:2)', 'at /app/b.js:3:4']);
  });

  it('is total: a throwing name or toString yields a generic Error', () => {
    const badName = new Error('secret-value-xyz');
    Object.defineProperty(badName, 'name', {
      get() {
        throw new Error('boom');
      },
    });
    expect(errorFields(badName)).toEqual({ name: 'Error', frames: [] });
    const badString = new TypeError('secret-value-xyz');
    badString.toString = () => {
      throw new Error('boom');
    };
    expect(errorFields(badString)).toEqual({ name: 'Error', frames: [] });
  });
});

describe('errorLabel', () => {
  it('is the name, plus a code when the error has a short one (Postgres SQLSTATE, errno)', () => {
    expect(errorLabel(new TypeError('secret-value-xyz'))).toBe('TypeError');
    const pg = Object.assign(new Error('invalid input syntax: "secret-value-xyz"'), {
      code: '22P02',
    });
    expect(errorLabel(pg)).toBe('Error: 22P02');
    const net = Object.assign(new Error('connect 10.0.0.1'), { code: 'ECONNREFUSED' });
    expect(errorLabel(net)).toBe('Error: ECONNREFUSED');
  });

  it('never carries a message, a long or odd code, or a non-Error value', () => {
    const odd = Object.assign(new Error('x'), { code: 'secret value xyz' });
    expect(errorLabel(odd)).toBe('Error');
    expect(errorLabel(Object.assign(new Error('x'), { code: 42 }))).toBe('Error');
    expect(errorLabel('secret-value-xyz')).toBe('string');
  });
});

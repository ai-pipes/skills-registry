// First on purpose: Zod captures `jitless` when a schema is created, so config must precede contracts.
import './zod-config.ts';
import { z } from 'zod';
import { expect, test, vi } from 'vite-plus/test';
import { MeResponse } from '@skills/contracts';

test('zod runs jitless, so parsing never probes new Function (CSP has no unsafe-eval)', () => {
  expect(z.config().jitless).toBe(true);
  const OriginalFunction = globalThis.Function;
  const spy = vi.fn();
  globalThis.Function = new Proxy(OriginalFunction, {
    construct(target, args, newTarget) {
      spy();
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    z.object({ a: z.string() }).safeParse({ a: 'x' });
    MeResponse.safeParse({});
  } finally {
    globalThis.Function = OriginalFunction;
  }
  expect(spy).not.toHaveBeenCalled();
});

import { z } from 'zod';

/** Every non-2xx JSON response of the REST API. */
export const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

import { z } from 'zod';

// CSP `script-src 'self'` has no 'unsafe-eval'. Zod's JIT probe (`new Function('')`) is reported
// as a securitypolicyviolation even though the throw is caught, so turn JIT off up front.
// Must be imported before the first schema parse (see main.tsx).
z.config({ jitless: true });

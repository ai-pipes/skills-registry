# 0006. CSP for the web UI

## Context

Part 1 serves the CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'`. There are no inline scripts and no inline styles. Part 2 (the web UI) was planned on the assumption that the UI fits this policy without changes:

- Tailwind is built into static CSS;
- the React `style` prop and Base UI popover positioning go through the CSSOM;
- CodeMirror uses constructable stylesheets.

This was verified in a real browser against the built image.

## How it was checked

A temporary page `/?csp-probe` mounted everything the UI uses:

- CodeMirror `EditorView`;
- open `Tooltip`, `Select` (30 items), `DropdownMenu`, `Dialog`, and `ScrollArea`;
- a `toast()` call;
- the whole tree wrapped in `CSPProvider disableStyleElements` from `@base-ui/react/csp-provider`.

Playwright 1.64.1 (Chromium) opened the page in the image from `docker compose up --build`. An init script, running before the bundle loaded, recorded three things: `securitypolicyviolation` events, CSP console messages, and every `<style>` element inserted into the DOM (MutationObserver). For each component it checked that it was visible and styled: the computed `background-color` is not transparent, the toaster has `position: fixed`, the Select list has `scrollbar-width: none`, `.cm-editor` has `display: flex` from the base theme, and typing into the editor works. Policy variants were first tried by substituting the response header (`page.route`); the final one was checked with the image's own header.

## Findings

There are three sources of `<style>`. There are no others: the CSP does not affect Base UI CSSOM styles or React `style`. Base UI's prehydration `<script>` (`Tabs.Indicator`, `Slider.Thumb`) is rendered only when hydrating SSR markup, and we use `createRoot` without SSR.

1. **sonner 2.0.8.** On module load it unconditionally calls `__insertCSS(...)`. There is no option to disable this (neither in the `ToasterProps` types nor in the source), and it does not accept a nonce either. First an empty `<style>` is added to `<head>`, then 14,916 characters of CSS are written into it. Each step is a separate `style-src-elem` violation: hashes `sha256-47DEQpj8…` (empty string) and `sha256-StEaX+se…`.
   Coverage measurement: a toast was shown with insertion blocked, and a snapshot of all computed properties of the toaster subtree was taken (5088 properties). Then the same CSS was attached as a constructable sheet at the end of the cascade, where sonner's `<style>` would have been, and a second snapshot was taken. 194 properties differ textually, and all of them render the same:
   - 192 are custom properties (`--gray1` etc.): the bundler wrote `#fcfcfc`, sonner wrote `hsl(0, 0%, 99%)` — the same color;
   - 2 are `outline-width` with `outline-style: none`.

   The static `@import 'sonner/dist/styles.css'` added earlier fully covers the inserted CSS. The cost without loosening the CSP is just two console violations.
2. **Base UI** (`Select`, `ScrollArea`). Inserts a `<style>` with `.base-ui-disable-scrollbar` styles (107 characters): one violation. With `CSPProvider disableStyleElements` the element is not created, and the rule lives in static CSS (an earlier fix). Measured: with the provider this `<style>` is absent, and `scrollbar-width: none` is applied.
3. **CodeMirror** (`style-mod` 4.1.4). A constructable stylesheet is used only if the mount root is a `ShadowRoot`: the check is `!root.head`. `document` has a `head`, so with a regular mount style-mod writes its rules into a `<style>`. Blocking it gives one violation, and the editor is left without its base theme: `.cm-editor` gets `display: block` instead of `flex`. The text of this `<style>` changes with the set of extensions and themes, so a hash will not work for it.
   When mounted in a shadow root (`new EditorView({ parent: shadowRoot, root: shadowRoot })`), styles go through `adoptedStyleSheets`. No violations, the theme is applied, typing works (measured).

## Decision

1. **CodeMirror is mounted in a shadow root.** This is the contract for the editor: host element → `attachShadow({ mode: 'open' })` → `EditorView` with `parent` and `root` set to that shadow root. The theme's CSS variables (`--background`, `--foreground`…) and the document's `@font-face` are inherited into the shadow tree, so the theme is set via `EditorView.theme` using `var(--…)`. Tailwind classes do not reach into the shadow tree, so they cannot be used to style the editor internals. There is no need to loosen the CSP for CodeMirror.
2. **Base UI** — under `CSPProvider disableStyleElements` (the app root and `renderWithApp`); the `.base-ui-disable-scrollbar` rule lives in `global.css`.
3. **sonner** — the only loosening, and only of the `style-src-elem` directive: hashes of the two contents sonner 2.0.8 inserts are added next to `'self'`.

   ```
   default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=' 'sha256-StEaX+se6YS7pqjzrzMIA0KaX9zF/8zAhvQXZAe5epY='; img-src 'self' data:; frame-ancestors 'none'
   ```

   `script-src` and `style-src-attr` do not change: `style` attributes are still blocked, falling back to `style-src 'self'`.

   A hash allows exactly one text. You cannot put your own rules into an allowed `<style>`: the browser recomputes the hash on every change of the element's content. The empty-string hash allows only an empty element that does nothing.

   The static import of sonner's CSS stays. If a sonner update changes its CSS, toasts stay styled, and only the hash breaks.

## Rejected alternatives

- **`style-src-elem 'unsafe-inline'`** or **`style-src 'unsafe-inline'`**. Would allow any `<style>`, including one injected via HTML injection (CSS exfiltration through attribute selectors) — broader than needed.
- **Leave the sonner violation in the console.** Styles are covered, but a noisy console masks real violations, and e2e cannot require a clean console.
- **Strip `__insertCSS` from sonner with a build plugin.** That patches third-party code and ties us to the shape of its bundle. A hash is a standard CSP mechanism, and a test catches its drift.
- **nonce.** Requires templating `index.html` per request, and sonner does not accept a nonce.
- **CodeMirror in the document + a hash or `'unsafe-inline'`.** The hash does not hold, and `'unsafe-inline'` — see above. A shadow root solves the problem without loosening.

## How it is enforced

- `apps/server/test/http/platform.int.test.ts` — the exact CSP string, both on `/api` and on the UI static files.
- `apps/server/test/http/csp.test.ts` computes the SHA-256 of the `__insertCSS` argument from the installed sonner and compares it with `SONNER_STYLE_HASHES` in `security.ts`. A sonner update that changes the CSS fails here with a clear reason.
- `e2e/csp.spec.ts` (Playwright; `bash scripts/e2e-image.sh` brings up the image) — the UI loads in the browser without a single CSP violation, and sonner's `<style>` is applied.
- `scripts/smoke.sh` — `GET /` returns `index.html` with `<div id="root">` and the CSP header.

## Consequences

- A sonner update requires recomputing the hashes: the test will suggest the new value.
- A new UI dependency that inserts `<style>` will cause a violation in `e2e/csp.spec.ts`. It must be configured (provider, shadow root, static CSS) or get its own ADR.
- Verified in Chromium; the mechanisms (hashes for `<style>`, `adoptedStyleSheets` in a shadow root) are supported by all current browsers.

## Consequences/update: Zod and `eval`

After session loading appeared (`/me` is parsed at startup), e2e caught a `script-src` violation with `blockedURI: 'eval'`. The cause is Zod 4: to decide on JIT it tries `new Function('')` (`allowsEval` in `core/util.js`); it catches the error, but the browser still reports a CSP violation. The policy stayed `script-src 'self'`.

Solution: `apps/web/src/zod-config.ts` calls `z.config({ jitless: true })`; the module is imported first in `main.tsx`. The order matters: Zod captures `jitless` when a schema is created, so the setting must run before `@skills/contracts` loads. Regression guard: `apps/web/src/zod-config.test.ts` (the config and the absence of `Function` calls while parsing a contracts schema) and `e2e/csp.spec.ts`.

## Update 2026-10-29: sonner removed, CSP strict again

Owner's decision: the `style-src-elem` loosening for sonner is removed. Item 3 of "Decision", the `SONNER_STYLE_HASHES` hashes and their drift test (`csp.test.ts`) no longer apply.

- **Toasts use Base UI Toast** (`@base-ui/react/toast`, already a dependency via `@base-ui/react`). The module `apps/web/src/lib/notify.ts` holds one module-level `Toast.createToastManager()` and exposes `notify.success(text)`, `notify.error(text)` and `notify.dismissAll()`. Like sonner's `toast()`, they can be called outside components. `apps/web/src/components/Toaster.tsx` renders `Toast.Provider` with this manager, a portal and a viewport (bottom right, a card on `bg-popover` with `border` and `rounded-lg`, success/error icons). Styles are Tailwind classes and shadcn theme variables. Base UI Toast does not insert `<style>`. It writes CSS variables (`--toast-*`) through the CSSOM, which the CSP does not block.
- The toast root role is overridden: `role="group"` instead of the default `dialog`/`alertdialog`, and `aria-modal` is removed. Otherwise an open toast looks like another open dialog to screen readers and to `getByRole('dialog')` queries. Base UI's `tabIndex=0` is kept: a toast can be focused from the keyboard.
- Success (`priority: 'low'`) is announced by the viewport's live region (`aria-live="polite"`). An error (`notify.error`, `priority: 'high'`) is announced assertively: Base UI puts a copy of the text into a visually hidden `role="alert"` and sets `aria-hidden` on the visible toast so the text is not read twice.
- `sonner` is removed from `apps/web/package.json` and the lockfile. `@import 'sonner/dist/styles.css'` is removed from `global.css`, and `components/ui/sonner.tsx` is deleted.
- The policy is again as in part 1:

  ```
  default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'
  ```

How it is enforced now:

- `apps/server/test/http/csp.test.ts` — the exact CSP string from `securityHeaders()`: no `style-src-elem` and no hashes.
- `apps/server/test/http/platform.int.test.ts` — the same string on `/api` and on the UI static files.
- `apps/web/src/components/Toaster.test.tsx` (jsdom) — toasts are shown, and after showing them the document contains no `<style>` at all.
- `e2e/csp.spec.ts` — the exact header, zero violations and zero `<style>` elements in Chromium, Firefox and WebKit.
- Two `createElement("style")` paths remain in the bundle: react-dom (hoisting of `<style precedence>`, which we don't render) and CodeMirror's style-mod (without `adoptedStyleSheets`, while we mount in a shadow root). In our configuration neither runs, and the "zero `<style>`" check in `e2e/csp.spec.ts` guards this.
- `e2e/ui.spec.ts` shows several toasts and also requires zero violations.

The consequence from the section above still holds: a dependency that inserts `<style>` must be configured (provider, shadow root, static CSS), not have its hash added to the policy.

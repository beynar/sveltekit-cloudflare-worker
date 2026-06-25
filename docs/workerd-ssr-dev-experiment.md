# Workerd SSR dev experiment

Date: 2026-06-23

## Goal

Make SvelteKit server code run inside the Cloudflare Vite plugin's Worker runtime during `vite dev`, so `event.platform.env` receives the native Worker `env` instead of Wrangler's `getPlatformProxy()` objects.

## Upstream constraints checked

- SvelteKit dev mode builds its SSR manifest inside `@sveltejs/kit/src/exports/vite/dev/index.js` and passes `adapter.emulate()` into `Server.respond()`.
- `@sveltejs/adapter-cloudflare` implements `emulate()` with Wrangler `getPlatformProxy()`.
- `@cloudflare/vite-plugin` can bind a Worker to Vite's `ssr` environment with `viteEnvironment: { name: 'ssr' }`.
- Cloudflare Worker environments reject `resolve.external`; SvelteKit currently sets `resolve.external = ['cookie', 'set-cookie-parser']` for SSR.

Sources used: installed package internals, DeepWiki for `sveltejs/kit`, and DeepWiki for `cloudflare/workers-sdk`. The project Svelte MCP tools were not exposed in this session, so SvelteKit behavior was verified against installed package internals instead.

## Implementation tried

Added a guarded workerd SSR path as the dev behavior:

```ts
cloudflareWorker();
```

The path is not optional because it is what makes the library's local SvelteKit binding promise
true.

The plugin:

1. Passes `viteEnvironment: { name: 'ssr' }` to `@cloudflare/vite-plugin`.
2. Clears `config.environments.ssr.resolve.external` before Cloudflare validates the environment.
3. Generates `.svelte-kit/cloudflare-worker/_sveltekit-dev-ssr.ts`.
4. Changes generated dev `next()` from `env.ASSETS.fetch(request)` to the generated Worker-side SvelteKit responder.
5. Passes native `{ env, ctx, caches, cf }` into `server.respond(..., { platform })`.

The generated responder synthesizes a dev SSR manifest from SvelteKit private internals. This is not a public SvelteKit API, but the path is guarded by dependency checks and covered by an integration harness.

## Runtime probe

Added a SvelteKit server probe route:

```txt
GET /__probe-sveltekit-bindings
```

It calls:

```ts
const id = platform.env.MY_DO.idFromName('sveltekit-realm-probe');
const count = await platform.env.MY_DO.get(id).increment();
```

Dev server command:

```bash
npm run dev -- --host 127.0.0.1 --port 4312
```

Probe results:

```txt
GET /                                    -> 200 text/html 70496
GET /api/do/increment                    -> {"count":9}
GET /__probe-sveltekit-bindings          -> {"ok":true,"count":2,"keys":["ASSETS","CHAT_ROOM","MY_DO","PROGRESS_WORKFLOW","RATELIMIT_CHAT","WORKFLOW_DO"]}
GET /@fs/.../.svelte-kit/generated/client/app.js -> 200 text/javascript
```

This proves the important part of the promise for the demo: SvelteKit server code can call the internal same-worker Durable Object binding locally when SSR fallback runs inside workerd.

## What failed before the workaround

Naively setting only `viteEnvironment: { name: 'ssr' }` failed before the server started:

```txt
"ssr" environment: resolve.external: ["cookie","set-cookie-parser"]
```

Clearing externals let dev start, but using SvelteKit's normal Node middleware still crashed on first request:

```txt
invoke was called before connect
Cannot read properties of undefined (reading 'outsideEmitter')
```

That confirmed the default SvelteKit dev middleware cannot be the fallback path once `ssr` is a Cloudflare Worker environment. The Worker entry must own the SvelteKit fallback.

## Current limitations

- Uses SvelteKit private internals: `load_config()`, `sync.create()`, and SvelteKit's dev SSR
  manifest shape.
- The generated workerd manifest calls a private Vite middleware for `inline_styles`; that middleware
  walks Vite's SSR module graph using the same dependency traversal shape as SvelteKit dev, then
  asks Vite's CSS transform for the `?inline` payloads.
- SvelteKit remote functions under the app source are loaded into the generated dev manifest.
- SvelteKit server asset metadata is generated for app source files and static files, which covers
  `$app/server.read()` for Vite asset URLs.
- Universal `ssr = false`, matchers, 404 rendering, static assets, native Durable Object access, SvelteKit remote function execution, `$app/server.read()`, dev CSS inlining for route/component/dynamic CSS, and endpoint HMR are covered by `npm run test:integration`.
- Workflows are exposed in `platform.env` keys, but this experiment only proved Durable Object RPC.

## Hardening pass

The implementation now:

- fails early when `@sveltejs/kit`, `vite`, or `@cloudflare/vite-plugin` are outside the guarded compatible range;
- avoids importing universal modules when SvelteKit's manifest marks `ssr = false`;
- passes `read` into both `server.init()` and `server.respond()`;
- uses a server-safe fallback error component for SvelteKit's default error node;
- maps SvelteKit remote function files into the generated dev manifest;
- maps source and static files into the generated manifest's `server_assets`;
- launches a real fixture app in `vite dev` for integration coverage.

## Preliminary conclusion

The holy-grail path is viable enough to continue.

The key architectural change is correct: do not proxy from Worker dev into SvelteKit's Node middleware for SSR fallback. Generate or obtain a SvelteKit responder that runs inside the Cloudflare Vite `ssr` Worker environment, and pass the native Worker `env` into `server.respond()`.

The remaining question is whether we can harden the generated manifest enough without effectively copying SvelteKit dev internals. If SvelteKit exposes a public dev SSR handler or lands native Cloudflare Vite Environment API support, this experiment should collapse into a much smaller integration.

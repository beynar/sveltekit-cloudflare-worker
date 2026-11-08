# sveltekit-cloudflare-worker

Put a Cloudflare Worker entry, `src/worker.ts`, in front of a SvelteKit 3 app deployed with
`@sveltejs/adapter-cloudflare` 8.

- **Fetch middleware around SvelteKit.** Return a `Response` to answer a request, return nothing
  to fall through to SvelteKit, or call `next()` to run SvelteKit and change its response.
- **Everything else a Worker can export.** Durable Objects (SQLite or KV storage), Workflows,
  `WorkerEntrypoint` classes, `queue`, `scheduled`, `email`, `tail` and the other handlers end up
  in the one deployed Worker.
- **`vite dev` runs the Worker in workerd, with HMR.** Editing `src/worker.ts` or anything it imports
  updates the running Worker without a restart. Durable Objects pick up the new class and keep
  their storage.
- **One set of bindings.** SvelteKit server code reads `import { env } from 'cloudflare:workers'`
  and reaches the same Durable Objects, D1, R2, KV and queues as the Worker, in dev and in
  production.
- **State shared with Wrangler.** Dev data lives in `.wrangler/state/v3`, so
  `wrangler d1 migrations apply --local` and `wrangler dev` see the same databases and objects.

## Requirements

- `@sveltejs/kit` `^3.1.0` (configured in `vite.config.ts`; SvelteKit 3 has no `svelte.config.js`)
- `@sveltejs/adapter-cloudflare` `^8.0.2`
- `vite` `^8.0.12`, `wrangler` `^4.125.0`, Node.js `>=20.19`

## Install

The package is not published on npm yet. Install a commit from GitHub. The repository ships
plain JavaScript and declaration files, so no build step runs on install:

```bash
pnpm add -D github:beynar/sveltekit-cloudflare-worker#<commit> @sveltejs/adapter-cloudflare wrangler
```

## Configure Vite

`cloudflareWorker()` takes the options you would pass to `sveltekit()` and installs the adapter. Do
not add `adapter` yourself; adapter-cloudflare options go in the second argument.

```ts
// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import { cloudflareWorker } from 'sveltekit-cloudflare-worker';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit(
			cloudflareWorker(
				{
					compilerOptions: {
						runes: ({ filename }) =>
							filename.split(/[/\\]/).includes('node_modules') ? undefined : true
					}
				},
				{
					// all optional, see "Options"
					// config: 'wrangler.jsonc',
					// workerFile: 'src/worker.ts',
				}
			)
		)
	]
});
```

`cloudflareWorkerAdapter(options)` returns the adapter alone, for `sveltekit({ adapter })`.

## Configure Wrangler

`main` must be adapter-cloudflare's output. The build replaces that file with the composed Worker.

```jsonc
// wrangler.jsonc
{
	"$schema": "./node_modules/wrangler/config-schema.json",
	"name": "my-app",
	"main": ".svelte-kit/cloudflare/_worker.js",
	"compatibility_date": "2026-11-01",
	"compatibility_flags": ["nodejs_compat"],
	"assets": { "binding": "ASSETS", "directory": ".svelte-kit/cloudflare" },
	"durable_objects": { "bindings": [{ "name": "NOTES", "class_name": "NoteRoom" }] },
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["NoteRoom"] }],
	"queues": {
		"producers": [{ "binding": "JOBS", "queue": "my-app-jobs" }],
		"consumers": [{ "queue": "my-app-jobs" }]
	},
	"triggers": { "crons": ["0 3 * * *"] }
}
```

Bindings are only declared here. `vite dev` reads the same file (including `vars`, `.dev.vars` /
`.env` secrets and `CLOUDFLARE_ENV` environments).

Static assets follow Cloudflare's rules. Without `assets.run_worker_first`, files from `static/`
and `_app/immutable` are served before the Worker, and `vite dev` does the same.

## Write the Worker

```ts
// src/worker.ts
import { DurableObject } from 'cloudflare:workers';
import type { WorkerFetch, WorkerQueue, WorkerScheduled } from 'sveltekit-cloudflare-worker';
import { auth } from '#lib/server/auth.js';

export const fetch: WorkerFetch = async (request, env, ctx, next) => {
	const url = new URL(request.url);

	if (url.pathname.startsWith('/api/auth/')) return auth.handler(request);

	if (url.pathname.startsWith('/rooms/')) {
		// WebSocket upgrades are forwarded on the same origin in dev and in production.
		return env.NOTES.getByName(url.pathname.slice('/rooms/'.length)).fetch(request);
	}

	if (url.pathname === '/') {
		const response = await next(); // run SvelteKit
		const headers = new Headers(response.headers);
		headers.set('x-worker', '1');
		return new Response(response.body, { status: response.status, headers });
	}

	// Return nothing: SvelteKit handles the request.
};

export const queue: WorkerQueue<Env, { id: string }> = async (batch, env) => {
	for (const message of batch.messages) message.ack();
};

export const scheduled: WorkerScheduled = async (controller, env, ctx) => {
	ctx.waitUntil.last(() => env.JOBS.send({ id: controller.cron }));
};

export class NoteRoom extends DurableObject<Env> {
	add(text: string) {
		this.ctx.storage.sql.exec('INSERT INTO notes (text) VALUES (?)', text);
	}
}
```

Rules for the entry:

- Handlers are **named exports** (`export const fetch`, `export async function queue`), not a
  default export.
- Exported **classes** become Worker exports. Other named values (constants, helpers) stay private,
  so they never break workerd's export validation.
- `ctx.waitUntil.last(fn)` runs `fn` after every other `waitUntil` promise of the handler.
- Imports resolve like the rest of the app: `#lib/...` package imports, Vite `resolve.alias` entries
  (for example a `$lib` alias), `node:*` and bare Node built-ins such as `crypto` with
  `nodejs_compat`. SvelteKit's own modules (`$app/*`, `$env/*`) are not available in the Worker.

## Use the bindings from SvelteKit

adapter-cloudflare 8 no longer provides `event.platform`. Read bindings from `cloudflare:workers`:

```ts
// src/routes/notes/+server.ts
import { env } from 'cloudflare:workers';

export async function POST({ request }) {
	await env.NOTES.getByName('inbox').add(await request.text());
	return new Response(null, { status: 204 });
}
```

In dev this `env` is a proxy to the bindings of the Worker running in workerd. It is the same
Durable Object namespace, so state written by the Worker is visible to SvelteKit and vice versa.

## Types

On startup the adapter writes a managed block into `src/app.d.ts`. It declares `Cloudflare.Env`
from the Wrangler config, with Durable Object and Workflow bindings typed by the classes exported
from `src/worker.ts`. `cloudflare:workers` `env`, `WorkerFetch` and the other handler types use it
by default.

Keep `wrangler types` for the runtime types only, so the two `Env` declarations do not conflict:

```json
{ "scripts": { "gen": "wrangler types --include-env=false" } }
```

Set `typesFile: false` if you prefer to generate `Env` with `wrangler types` yourself.

## Build and preview

```bash
vite build          # adapter-cloudflare build + composition of .svelte-kit/cloudflare/_worker.js
wrangler dev        # serve the composed Worker locally (same .wrangler/state as vite dev)
wrangler deploy
```

The build:

1. lets adapter-cloudflare write `_worker.js`;
2. checks that the output has a default export with a `fetch` handler. Anything unexpected is a
   build error, never a silent skip;
3. bundles `src/worker.ts` to `_user-worker.js` with esbuild (`cloudflare:*` and `node:*` external);
4. moves the adapter Worker to `_sveltekit-worker.js` and writes a `_worker.js` that exports the
   Worker's classes and handlers around SvelteKit;
5. adds both internal modules to `.assetsignore`.

`vite preview` is SvelteKit's Node preview with adapter-cloudflare's `getPlatformProxy()`. Use
`wrangler dev` to exercise the composed Worker.

Trigger a cron handler locally with `curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=0+3+*+*+*"`
(`/__scheduled` also works) in `vite dev`, or with `wrangler dev --test-scheduled` on the build.

## How `vite dev` works

```text
browser ──> Vite (Node) ──> Miniflare / workerd: src/worker.ts fetch
                                   │ next()
                                   ▼
                            Vite middleware ──> SvelteKit SSR (Node)
                                                  │ import { env } from 'cloudflare:workers'
                                                  ▼
                            Miniflare binding proxy ──> the same Worker's Durable Objects, D1, R2, KV
```

- The plugin owns one Miniflare instance, configured from the Wrangler config through Wrangler's
  `unstable_getMiniflareWorkerOptions` and the Miniflare build that Wrangler itself uses.
- `src/worker.ts` is loaded by Vite's module runner inside workerd (Vite environment
  `cloudflare_worker`). Edits are HMR updates. Adding or removing an exported class or handler
  reloads workerd in place, without restarting Vite and with storage kept.
- Durable Object, Workflow and entrypoint classes are thin wrappers that delegate to the current
  module. After an edit, the next call constructs the new class with the same `ctx`.
- `next()` and the `ASSETS` binding go back to Vite's middleware, so they reach SvelteKit (and
  Vite-served files).
- WebSocket upgrades other than Vite's HMR socket are forwarded to the Worker.
- Remote-only bindings (Workers AI, `remote: true` bindings) use Wrangler's remote proxy session.
  This requires `wrangler login`; without it dev starts and logs a warning.

## Options

| Option               | Default                  | Description                                                     |
| -------------------- | ------------------------ | --------------------------------------------------------------- |
| `workerFile`         | `'src/worker.ts'`        | Worker entry, relative to the project root.                     |
| `config`             | first `wrangler.json(c)` | Wrangler config path. Also passed to adapter-cloudflare.        |
| `environment`        | `CLOUDFLARE_ENV`         | Wrangler environment used by dev and the build.                 |
| `typesFile`          | `'src/app.d.ts'`         | File that receives the `Cloudflare.Env` block, or `false`.      |
| `persistState`       | `true`                   | `false`, or `{ path }` instead of `.wrangler/state`.            |
| `remoteBindings`     | `true`                   | Start Wrangler's remote proxy session for remote-only bindings. |
| `root`               | Vite's root              | Project root, when it differs from Vite's root.                 |
| `fallback`, `routes` | adapter defaults         | Passed to adapter-cloudflare.                                   |
| `verbose`            | `false`                  | Log composition and runtime details.                            |

## Limitations

- `connect()` (inbound TCP) is composed into the production Worker, but `vite dev` does not emulate
  it. A warning is logged.
- In dev, the module runner evaluates `src/worker.ts` on the first request, not at Worker startup.
  workerd's global-scope restrictions (no `crypto.randomUUID()`, timers or I/O at module top level)
  are only enforced by `wrangler dev` and production.
- SvelteKit reaches Worker bindings through Miniflare's proxy, which blocks Node during some calls.
  The Worker module and every module it can still import (statically or with `import()`) are
  loaded before SvelteKit runs, so Durable Objects and entrypoints that load their code lazily work.
  The one remaining window is a request already in flight while you save a Worker file.
- `cloudflare:workers` `exports` is not available to SvelteKit code in dev.
- The dev runtime is disabled under Vitest (`process.env.VITEST`), so unit tests do not start workerd.

## Migrating from the SvelteKit 2 version (commit `c08908c`)

1. Delete `svelte.config.js`. Move its options into `sveltekit(cloudflareWorker({ ... }))` in
   `vite.config.ts`, and remove `adapter(...)`, `proxyConfig()` and `platformProxy`: Durable Objects
   no longer need `script_name` rewrites.
2. Remove `cloudflareWorker()` from the Vite `plugins` array, and remove the `@cloudflare/vite-plugin`
   dependency.
3. Replace `event.platform.env` with `import { env } from 'cloudflare:workers'`.
4. In `src/worker.ts`, use `#lib/...` imports (or keep `$lib` through a Vite `resolve.alias`
   entry) instead of relative paths, and import the handler types from `sveltekit-cloudflare-worker`.
5. Bump `@sveltejs/kit` to `^3.1.0`, `@sveltejs/adapter-cloudflare` to `^8.0.2` and Vite to 8.

## Development of this package

```bash
pnpm install
pnpm check
pnpm test                # unit tests
pnpm test:integration    # builds fixture apps, runs vite dev and wrangler dev
pnpm dev                 # the demo app in src/routes and src/worker.ts
```

See [docs/architecture.md](docs/architecture.md) for the design.

# Node SvelteKit dev with Distilled Durable Objects

This executable experiment proves the development architecture used by
`sveltekit-cloudflare-worker`:

- SvelteKit keeps its native Node server and HMR;
- `src/worker.ts` provides the fetch middleware and exported Cloudflare classes;
- Distilled hosts Durable Objects and WebSocket upgrades in workerd;
- Node middleware and SvelteKit use a platform proxy to reach that same workerd namespace;
- HTTP, SvelteKit, and WebSocket calls with the same object name share one object and persisted
  state.

## Interactive demo

Run the app with `pnpm dev`, then open the printed local URL. The page is the same full demo as
the package repository:

- Worker fetch interception before SvelteKit;
- a Durable Object counter called from a SvelteKit route;
- a hibernating Durable Object WebSocket chat with a Rate Limit binding;
- a three-step Cloudflare Workflow that reports progress through a Durable Object WebSocket and
  waits for approve or reject input;
- SvelteKit fallthrough;
- platform binding, remote function, and `$app/server.read()` probes;
- syntax-highlighted Worker, Hono, middleware, and Durable Object examples.

All live features are declared in `wrangler.jsonc` and implemented in the single
`src/worker.ts` entry. The extra `COUNTER`, `/probe`, and `/socket` paths are the automated
architecture proof used by `pnpm probe`.

Run the proof with:

```bash
pnpm install
pnpm probe
```

The probe checks HTTP middleware before and after SvelteKit, a browser-style WebSocket exchange,
SvelteKit access to the same object, and persistence after a complete dev-server restart.

## Use the packaged integration

Applications do not copy `dev-adapter.ts`, the `runtime` directory, or Distilled binding
configuration from this experiment. Install the package and let Wrangler remain the source of
truth:

```bash
pnpm add -D sveltekit-cloudflare-worker @sveltejs/adapter-cloudflare wrangler
```

```ts
// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import { cloudflareWorker } from 'sveltekit-cloudflare-worker';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(cloudflareWorker())]
});
```

Declare each Durable Object once in `wrangler.jsonc`:

```jsonc
{
	"name": "my-app",
	"main": ".svelte-kit/cloudflare/_worker.js",
	"compatibility_date": "2026-07-11",
	"durable_objects": {
		"bindings": [{ "name": "COUNTER", "class_name": "Counter" }]
	},
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
```

The package automatically derives both development views of this one declaration:

1. the Distilled Worker owns `Counter` and receives the same-script `COUNTER` namespace;
2. SvelteKit's Node platform proxy receives a generated cross-worker `COUNTER` binding targeting
   that owner.

The stable local identity comes from Wrangler's Worker `name` and Durable Object `class_name`.
There is no application-level `DurableObjectNamespace.local()`, `scriptName`, or `uniqueKey`.
Local binding state is stored under `.sveltekit-cloudflare-worker/local`; the experiment ignores
that directory in Git.

Keep the application code in `src/worker.ts`:

```ts
import { DurableObject } from 'cloudflare:workers';
import type { WorkerFetch } from 'sveltekit-cloudflare-worker';

interface Env {
	COUNTER: DurableObjectNamespace<Counter>;
}

export const fetch: WorkerFetch<Env> = async (request, env, _ctx, next) => {
	const url = new URL(request.url);
	if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
		return env.COUNTER.getByName(url.searchParams.get('name') ?? 'default').fetch(request);
	}
	return next();
};

export class Counter extends DurableObject<Env> {
	async fetch(request: Request) {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade.', { status: 426 });
		}
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}
}
```

See the repository [README](../../README.md) for complete installation, middleware, binding,
WebSocket, build, and deployment documentation.

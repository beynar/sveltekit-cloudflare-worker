# Development and deployment architecture

## Public configuration boundary

`cloudflareWorker()` decorates the configuration passed to SvelteKit 3. It records the user's
`files.hooks.server` path, points SvelteKit at the package hook, and installs the Cloudflare adapter.
The package hook imports the original hook through a Vite virtual module. It uses only SvelteKit's
public server-hook contract; there is no generated manifest or private SvelteKit responder.

The adapter contributes its own Vite plugins through `adapter.vite.plugins.pre`. It owns type
generation, the Node binding proxy, the Distilled Worker environment, and the generated Worker
entry.

## Development runtime

SvelteKit owns ordinary HTTP requests in Node. The package hook runs `src/worker.ts` fetch
middleware around the user's SvelteKit hook:

```text
HTTP request
  -> package hook
  -> src/worker.ts fetch
  -> user hook and SvelteKit
  -> src/worker.ts after next()
```

Distilled owns one workerd Worker environment. Its generated `_dev-entry.ts` exports the Durable
Object, Workflow, and Worker entrypoint classes from `src/worker.ts`. This environment also owns
WebSocket upgrades because Node's Fetch API cannot represent Cloudflare's `101 + webSocket`
response.

Wrangler is the only binding configuration source. `distilled-wrangler.js` derives two views from
one normalized configuration:

- the workerd Worker gets same-script bindings and hosts the configured classes;
- SvelteKit's Node platform proxy gets cross-worker bindings targeting that Worker.

For same-script Durable Objects, both views derive the same stable key from Wrangler's Worker name
and class name. Applications do not configure Distilled `scriptName` or `uniqueKey` values.
Disk-backed runtime services store local state under `.sveltekit-cloudflare-worker/local`.

```text
HTTP Worker middleware ----+
SvelteKit route/load -------+--> Node platform proxy --+
                                                       +--> one workerd namespace
WebSocket upgrade -----------> Distilled Worker -------+
```

Reserved `/cdn-cgi/handler/*` requests are forwarded to the Distilled Worker so scheduled and
other local handler probes still execute. All other HTTP requests remain with SvelteKit.

Wrangler's top-level `connect` field declares one loopback TCP listener. The listener is installed
inside the same workerd runtime only when the user Worker exports `connect`; no live `Socket`
crosses the Node platform proxy. Ordinary Worker edits use HMR. A connect export-shape change
regenerates the entry and refreshes only the Distilled runtime, not the SvelteKit Vite server.

## Production composition

`@sveltejs/adapter-cloudflare` owns the SvelteKit production build. After it finishes, the plugin:

1. preserves the adapter Worker as `_sveltekit-worker.js`;
2. bundles `src/worker.ts` as `_user-worker.js`;
3. writes one `_worker.js` facade that composes both fetch handlers and re-exports named Worker
   classes and handlers.

The bundler classifies actual class declarations before it writes the facade. Named constants and
functions can stay in the user module without becoming invalid workerd entrypoints.

Wrangler deploys this module graph as one Cloudflare Worker. The internal modules are listed in
`.assetsignore` so Cloudflare Assets cannot serve them. Both the Worker output and asset directory
resolve from Wrangler's normalized `configPath`, including when the config lives below the project
root.

Production builds use an inert adapter platform while SvelteKit prerenders. Unsupported
Distilled-only mappings therefore cannot block a configuration that adapter-cloudflare and
Wrangler can deploy. `vite preview` remains SvelteKit's Node preview; Wrangler owns local preview
of the composed production Worker.

## Verification contract

The integration harness proves:

- middleware before SvelteKit, SvelteKit itself, and middleware after SvelteKit observe consecutive
  state in one named Durable Object;
- a WebSocket message and a following SvelteKit request continue the same named object state;
- the same open Durable Object WebSocket and Node platform proxy survive a Worker implementation
  HMR update;
- adding a connect export activates the Wrangler listener without a full Vite restart;
- creating and deleting the default server-hook file after startup updates the live app;
- Durable Object state survives a complete dev-server restart;
- Workflows start from Worker and SvelteKit code;
- scheduled handlers execute through the reserved local route;
- production-only Wrangler bindings do not block prerendering;
- the standard SvelteKit preview starts without Distilled expecting a separate Worker build;
- native SvelteKit routing, remotes, server assets, CSS, base paths, service workers, and HMR stay
  under SvelteKit's Node runtime;
- the production build exports one composed Worker with the same classes and handlers.

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.

## Project architecture

- `cloudflareWorker()` decorates the SvelteKit 3 configuration, preserves the user's server-hook path behind the package hook, and installs the adapter. The adapter contributes the Distilled runtime through `vite.plugins.pre`; its `adapt()` step composes one production Worker. The delegated adapter-cloudflare build receives a private `config.kit` compatibility alias while this prerelease still uses the pre-SvelteKit 3 builder shape.
- `src/lib/worker-composition.js` owns production facade generation. Both the adapter and infrastructure integrations must reuse it so handler dispatch and named class exports stay identical. It classifies named entrypoints from the bundled JavaScript AST; ordinary named values must not be re-exported to workerd.
- `src/lib/node-dev-hooks.server.js` owns ordinary HTTP composition: `src/worker.ts` fetch wraps the user's public SvelteKit server hook.
- `src/lib/distilled-dev.js` owns the Distilled Vite Worker, WebSocket upgrades, Node platform proxy, and persistent Effect context.
- `src/lib/distilled-wrangler.js` is the only Wrangler-to-Distilled translation boundary. A configured binding must be translated or rejected explicitly. Local-only translation errors stop Vite serve, but they must not prevent adapter-cloudflare and Wrangler from building a valid production configuration.
- Distilled Vite plugins run only for development serve, not `vite preview`. SvelteKit owns its Node preview; use Wrangler against the built output when the composed Worker and bindings must be exercised.
- Local state is disk-backed under `.sveltekit-cloudflare-worker/local`. Production build and deployment remain owned by `@sveltejs/adapter-cloudflare` and Wrangler; Alchemy is not part of the runtime path.
- The package owns and pins Distilled, Effect, esbuild, and Cloudflare Worker types as runtime dependencies. Its public declaration references `@cloudflare/workers-types` with a type-reference directive so consumers receive Cloudflare globals without adding the package to `tsconfig.json`; a side-effect import resolves the package's source module and does not install those globals. SvelteKit, Vite, Svelte, adapter-cloudflare, and Wrangler remain host peer dependencies.
- Distilled's Node platform proxy carries binding RPC and ordinary `fetch`, but not Cloudflare's `101 + webSocket` response. A Node-owned dev server must forward WebSocket upgrades to a Worker environment that calls the same owning Durable Object namespace.
- Inbound TCP never crosses the Node platform proxy. Wrangler's top-level `connect` declaration is the listener source of truth. When `src/worker.ts` exports `connect`, the Distilled runtime adds that loopback TCP socket to the raw user Worker service and enables the experimental compatibility flag for that service only. Production composition preserves the handler and Wrangler owns deployment configuration.
- Ordinary `src/worker.ts` edits use HMR on both runtime sides. Export-shape changes regenerate the package entry; adding or removing `connect` triggers a targeted Distilled workerd refresh because it changes runtime socket topology, without restarting the SvelteKit Vite server. The configured server-hook module must also survive create and delete events after startup.
- Distilled resolves before Vite finishes configuration. The default project root is `process.cwd()`; a consumer with a different Vite root must pass the same explicit `root` adapter option so Wrangler, the Worker entry, and SvelteKit do not split across projects.
- Wrangler-relative paths resolve from the normalized `configPath` directory. Build-time emulator calls use an inert prerender platform so production-only bindings never initialize the Distilled dev runtime.
- Same-script Durable Objects are declared only in Wrangler. Development automatically hosts the class in the Distilled Worker and generates the cross-worker Node proxy binding from the Wrangler Worker name and class name.
- Run `pnpm check`, `pnpm test:unit -- --run`, and `pnpm test:integration` after changes to hooks, binding translation, or runtime ownership.

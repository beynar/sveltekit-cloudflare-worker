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

- Targets SvelteKit 3 (`^3.1`, no `svelte.config.js`) and `@sveltejs/adapter-cloudflare` 8. `cloudflareWorker()` returns the `sveltekit()` options with the package adapter; `event.platform` does not exist, SvelteKit code reads `cloudflare:workers`.
- `src/lib/build-output.js` composes the production Worker after adapter-cloudflare. An unexpected adapter output is a build error, never a silent skip. `src/lib/worker-composition.js` owns bundling (aliases, `#imports`, `node:` built-ins), AST export classification and the facade; reuse it rather than duplicating dispatch.
- `src/lib/dev/runtime.js` owns `vite dev`: one Miniflare per root (loaded from Wrangler's dependency, options from `unstable_getMiniflareWorkerOptions`), the `cloudflare_worker` Vite environment whose ModuleRunner runs in workerd (`src/lib/dev/runner-worker.js`), the HTTP and WebSocket bridge, and export-shape reloads. adapter-cloudflare's own plugin only applies to build and preview.
- SvelteKit dev bindings come from `miniflare.getBindings()`, a synchronous proxy that blocks the Node main thread. Code reachable from a Durable Object or entrypoint wrapper must not need Node while the module is evaluated; see "The synchronous proxy constraint" in `docs/architecture.md`.
- Local state is `.wrangler/state/v3`, shared with Wrangler. The package ships `src/lib/**/*.js` and `.d.ts` directly (no build), so a GitHub install works without devDependencies.
- Run `pnpm check`, `pnpm test` and `pnpm test:integration` after changes to the runtime, the composition or binding handling.

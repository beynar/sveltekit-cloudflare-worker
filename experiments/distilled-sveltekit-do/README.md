# Distilled unified SvelteKit fetch middleware + Durable Object

PROTOTYPE — this project answers one question: can one local Worker request call the same Durable
Object from a `fetch(request, env, ctx, next)` middleware before SvelteKit, from SvelteKit itself,
and from the middleware after SvelteKit, without Alchemy?

## Verdict

Run `pnpm probe`. A successful request has this exact sequence:

1. The Worker `fetch` middleware increments `Counter` to 1.
2. `next()` invokes SvelteKit, which increments the same object to 2.
3. Control returns to the Worker middleware, which increments it to 3.
4. After a complete stop and restart, the same request continues at 4, 5, and 6.

The response body contains SvelteKit's count. The middleware exposes its before and after counts in
`x-counter-before` and `x-counter-after`.

## Local architecture

The existing `cloudflareWorker()` adapter generates the unified development entry and its `next()`
composition. `@distilled.cloud/cloudflare-vite-plugin` runs that entry in one workerd instance and
receives the `COUNTER` binding plus the class namespace. SvelteKit SSR therefore runs inside the
same Worker request and receives the same `env.COUNTER`.

`scripts/dev.ts` sets the adapter's current injection guard so its normal Cloudflare Vite runtime is
not started. Distilled is the only owner of the local workerd process.

For manual exploration:

```bash
pnpm dev
curl -i -X POST "$APP_URL/kit/counter/demo"
```

Local state is intentionally stored in `.distilled/local`.

## Production shape

`pnpm build` uses `@distilled.cloud/sveltekit` for the application build, then composes the same
middleware contract around the generated SvelteKit handler. The facade exports both `default` and
`Counter`. `wrangler.jsonc` binds `COUNTER` without `script_name`, so `pnpm dry-run` verifies one
Worker upload with the `COUNTER` and `ASSETS` bindings. It does not deploy anything.

Distilled 0.17.1 currently needs Bun for this prototype. Its runtime depends on
`@alchemy.run/node-utils@0.0.5`, whose published JavaScript lacks ESM package metadata; the same
entry works through the package's `bun` export condition.

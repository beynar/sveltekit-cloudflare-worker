# Alchemy beta.70 + one SvelteKit Worker + local Durable Objects

This isolated project proves that `alchemy dev` can run SvelteKit, custom fetch middleware, and a Durable Object in one local Worker. The same Alchemy resource produces one Cloudflare Worker deployment with a default fetch handler and the named `Counter` export.

It pins `alchemy@2.0.0-beta.70`, its Effect beta, and the Distilled framework packages used by that release.

## Why a source provider is required

Alchemy beta.70's stock `Cloudflare.Website.SvelteKit` source keeps only the generated default export. It has no entry-point hook for the named class export that a same-script Durable Object requires. Its Node-based dev proxy also receives bindings but does not host the Durable Object class.

This project instead declares one generic `Cloudflare.Worker` with the `sveltekit-cloudflare-worker/alchemy-source` provider:

1. In production, the provider delegates the SvelteKit build to `@distilled.cloud/sveltekit`, bundles `src/counter-worker.ts`, and makes a facade the main module.
2. The facade exports SvelteKit's default handler, the custom fetch middleware, and the named `Counter` class in one module graph.
3. In development, the provider keeps Svelte's Vite transforms and HMR, disables only SvelteKit's competing Node request bridge, and runs the unified entry in workerd with Alchemy's bindings.
4. The `COUNTER` binding omits `scriptName`, so it targets the `Counter` class in the same Worker.

`assets.runWorkerFirst` is required. It ensures that middleware can process both application requests and static-asset requests before the asset router.

## Install and inspect the deployment bundle

Node 24.15 or later is required.

```sh
pnpm install
pnpm check
pnpm prototype
```

`pnpm prototype` builds through the exact Alchemy source provider and verifies that:

- `server/index.js` remains the deployment main module;
- the main module has both `default` and `Counter` exports;
- the bundle contains the SvelteKit and user-Worker modules;
- the facade contains the custom fetch middleware.

## Run local development

```sh
pnpm dev
```

Alchemy beta.70 still resolves a Cloudflare profile for local Workers. On a machine without Cloudflare access, the following implementation-level workaround avoids an interactive profile while this stack uses `Alchemy.localState()` and contains no remote resource:

```sh
CI=1 \
ALCHEMY_PROFILE=alchemy-beta70-unified-local \
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000 \
CLOUDFLARE_API_TOKEN=local-only \
pnpm exec alchemy dev --profile alchemy-beta70-unified-local
```

Do not use placeholder credentials after adding `Alchemy.remote()`, `Cloudflare.state()`, or any live-only resource. Do not put them in an environment file.

## Probe one shared Durable Object

Use a fresh name after Alchemy prints `http://localhost:1337`:

```sh
base="http://localhost:1337"
probe="demo-$(date +%s)"

curl -s "$base/api/worker-ping"
curl -s -X POST "$base/api/worker-counter/$probe"
curl -s "$base/api/counter/$probe"
curl -s -X POST "$base/api/counter/$probe"
curl -s "$base/api/worker-counter/$probe"
```

The two increment responses must be `1` and `2`. The Worker middleware route and the SvelteKit server route must report the same value. Stop and restart Alchemy without deleting `.alchemy/local`, then increment the same name again. It must return `3`.

This verifies same-script RPC, per-name isolation, HMR, and storage persistence across a full development-process restart.

## Deployment shape

`alchemy.run.ts` contains one resource named `Website`. There is no host Worker and no cross-script binding. A Cloudflare deployment therefore uploads one Worker script containing:

- the default SvelteKit fetch handler;
- the custom fetch middleware;
- the named `Counter` Durable Object class;
- the static asset manifest.

The compatibility date is pinned to `2026-07-11`, the newest date accepted by beta.70's bundled workerd binary. This experiment verifies the production bundle locally; it does not publish a Worker to a Cloudflare account.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function writeWorkerdSsrFixtureFiles(root: string, repoRoot: string) {
	await writePackageFiles(root, repoRoot);
	await writeWorker(root);
	await writeRoutes(root);
}

export async function writeHmrEndpoint(root: string, version: string) {
	await writeFile(
		path.join(root, 'src/routes/hmr/+server.ts'),
		`import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = () => Response.json({ version: ${JSON.stringify(version)} });
`
	);
}

async function writePackageFiles(root: string, repoRoot: string) {
	await writeFile(
		path.join(root, 'package.json'),
		JSON.stringify({ type: 'module', private: true }, null, '\t')
	);
	await writeFile(
		path.join(root, 'svelte.config.js'),
		`import adapter from '@sveltejs/adapter-cloudflare';

export default {
\tcompilerOptions: {
\t\texperimental: {
\t\t\tasync: true
\t\t}
\t},
\tkit: {
\t\tadapter: adapter(),
\t\texperimental: {
\t\t\tremoteFunctions: true
\t\t}
\t}
};
`
	);
	await writeFile(
		path.join(root, 'vite.config.ts'),
		`import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { cloudflareWorker } from ${JSON.stringify(
			pathToFileURL(path.join(repoRoot, 'src/lib/index.js')).href
		)};

export default defineConfig({
\tplugins: [
\t\tsveltekit(),
\t\tcloudflareWorker({
\t\t\ttypesFile: false
\t\t})
\t]
});
`
	);
	await writeFile(
		path.join(root, 'wrangler.jsonc'),
		JSON.stringify(
			{
				name: 'workerd-ssr-fixture',
				main: '.svelte-kit/cloudflare/_worker.js',
				compatibility_date: '2025-01-01',
				compatibility_flags: ['nodejs_compat'],
				assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' },
				migrations: [{ tag: 'v1', new_sqlite_classes: ['CounterDurableObject'] }],
				durable_objects: {
					bindings: [{ name: 'COUNTER_DO', class_name: 'CounterDurableObject' }]
				},
				vars: { FIXTURE_VALUE: 'available' }
			},
			null,
			'\t'
		)
	);
	await writeFile(
		path.join(root, 'src/app.html'),
		'<!doctype html><html><head>%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>'
	);
	await writeFile(path.join(root, 'src/hooks.server.ts'), 'export {};\n');
	await writeFile(path.join(root, 'static/fixture.txt'), 'asset fixture');
}

async function writeWorker(root: string) {
	await writeFile(
		path.join(root, 'src/worker.ts'),
		`import { DurableObject } from 'cloudflare:workers';

type Env = {
\tCOUNTER_DO: DurableObjectNamespace<CounterDurableObject>;
\tASSETS: Fetcher;
};

export const fetch = async (request: Request, env: Env) => {
\tconst url = new URL(request.url);
\tif (url.pathname !== '/api/do/increment') return;

\tconst id = env.COUNTER_DO.idFromName('worker-realm');
\tconst count = await env.COUNTER_DO.get(id).increment();
\treturn Response.json({ count });
};

export class CounterDurableObject extends DurableObject<Env> {
\tasync increment() {
\t\tconst count = ((await this.ctx.storage.get<number>('count')) ?? 0) + 1;
\t\tawait this.ctx.storage.put('count', count);
\t\treturn count;
\t}
}
`
	);
}

async function writeRoutes(root: string) {
	await writeFile(
		path.join(root, 'src/routes/+layout.svelte'),
		`<script>
\timport './layout.css';

\tconst { children } = $props();
</script>

<div class="layout-style-probe">
\t{@render children()}
</div>
`
	);
	await writeFile(
		path.join(root, 'src/routes/layout.css'),
		'.layout-style-probe { color: rgb(12, 34, 56); }\n'
	);
	await writeFile(
		path.join(root, 'src/routes/+page.svelte'),
		`<h1 class="page-style-probe">fixture home</h1>

<style>
\t.page-style-probe {
\t\tbackground: rgb(98, 76, 54);
\t}
</style>
`
	);
	await mkdir(path.join(root, 'src/lib'), { recursive: true });
	await writeFile(
		path.join(root, 'src/lib/dynamic.css'),
		'.dynamic-style-probe { border-color: rgb(21, 43, 65); }\n'
	);
	await writeFile(
		path.join(root, 'src/routes/+page.ts'),
		`export const load = async () => {
\tawait import('$lib/dynamic.css');
\treturn {};
};
`
	);
	await writeProbeRoute(root);
	await writeRemoteProbeRoute(root);
	await writeServerReadProbeRoute(root);
	await writeFile(
		path.join(root, 'src/params/digits.ts'),
		'export const match = (param: string) => /^\\d+$/.test(param);\n'
	);
	await mkdir(path.join(root, 'src/routes/[id=digits]'), { recursive: true });
	await writeFile(
		path.join(root, 'src/routes/[id=digits]/+server.ts'),
		`import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = ({ params }) => Response.json({ id: params.id });
`
	);
	await mkdir(path.join(root, 'src/routes/no-ssr'), { recursive: true });
	await writeFile(path.join(root, 'src/routes/no-ssr/+page.svelte'), '<h1>client only</h1>');
	await writeFile(
		path.join(root, 'src/routes/no-ssr/+page.ts'),
		`export const ssr = false;

if (typeof window === 'undefined') {
\tthrow new Error('ssr=false universal module was imported on the server');
}
`
	);
	await mkdir(path.join(root, 'src/routes/hmr'), { recursive: true });
	await writeHmrEndpoint(root, 'one');
}

async function writeProbeRoute(root: string) {
	await mkdir(path.join(root, 'src/routes/__probe-sveltekit-bindings'), { recursive: true });
	await writeFile(
		path.join(root, 'src/routes/__probe-sveltekit-bindings/+server.ts'),
		`import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ platform }) => {
\tconst env = platform?.env;
\tif (!env?.COUNTER_DO) {
\t\treturn Response.json({ ok: false, keys: Object.keys(env ?? {}).sort() }, { status: 500 });
\t}

\tconst id = env.COUNTER_DO.idFromName('sveltekit-realm');
\tconst count = await env.COUNTER_DO.get(id).increment();
\treturn Response.json({ ok: true, count, keys: Object.keys(env).sort() });
};
`
	);
}

async function writeServerReadProbeRoute(root: string) {
	await mkdir(path.join(root, 'src/lib'), { recursive: true });
	await writeFile(path.join(root, 'src/lib/readable.txt'), 'server readable asset');
	await mkdir(path.join(root, 'src/routes/__probe-server-read'), { recursive: true });
	await writeFile(
		path.join(root, 'src/routes/__probe-server-read/+server.ts'),
		`import { read } from '$app/server';
import type { RequestHandler } from './$types.js';
import readableUrl from '$lib/readable.txt?url';

export const GET: RequestHandler = async () => {
\tconst response = read(readableUrl);
\treturn Response.json({
\t\tbody: await response.text(),
\t\tcontentLength: response.headers.get('content-length'),
\t\turl: readableUrl
\t});
};
`
	);
}

async function writeRemoteProbeRoute(root: string) {
	const remoteId = `${hash('src/lib/fixture.remote.ts')}/getFixtureValue`;
	await mkdir(path.join(root, 'src/lib'), { recursive: true });
	await writeFile(
		path.join(root, 'src/lib/fixture.remote.ts'),
		`import { getRequestEvent, query } from '$app/server';

export const getFixtureValue = query(() => {
\tconst { platform } = getRequestEvent();
\tconst value = platform?.env.FIXTURE_VALUE;
\tif (typeof value !== 'string') {
\t\tthrow new Error('Missing FIXTURE_VALUE binding');
\t}

\treturn {
\t\tvalue,
\t\thasCounter: Boolean(platform?.env.COUNTER_DO)
\t};
});
`
	);
	await mkdir(path.join(root, 'src/routes/__probe-remotes'), { recursive: true });
	await writeFile(
		path.join(root, 'src/routes/__probe-remotes/+server.ts'),
		`import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ fetch }) => {
\tconst response = await fetch('/_app/remote/${remoteId}?payload=');
\tconst body = await response.json();
\treturn Response.json({ status: response.status, body });
};
`
	);
}

function hash(value: string) {
	let result = 5381;
	let index = value.length;

	while (index) result = (result * 33) ^ value.charCodeAt(--index);

	return (result >>> 0).toString(36);
}

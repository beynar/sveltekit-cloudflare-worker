import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function writeWorkerdSsrFixtureFiles(
	root: string,
	repoRoot: string,
	options: {
		basePath?: string;
		connectPort?: number;
		prerenderHome?: boolean;
		productionOnlyBinding?: boolean;
		wranglerConnectPort?: number;
		useDefaultHooks?: boolean;
		withConnect?: boolean;
		withHooks?: boolean;
	} = {}
) {
	await writePackageFiles(root, repoRoot, options);
	await writeWorker(root, options.withConnect ?? true);
	await writeRoutes(root, options.prerenderHome ?? false);
}

export async function writeHmrEndpoint(root: string, version: string) {
	await writeFile(
		path.join(root, 'src/routes/hmr/+server.ts'),
		`import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = () => Response.json({ version: ${JSON.stringify(version)} });
`
	);
}

export async function writeWorkerVersion(root: string, version: string) {
	const workerPath = path.join(root, 'src/worker.ts');
	const source = await readFile(workerPath, 'utf8');
	const updated = source.replace(
		/const workerVersion = '[^']+';/,
		`const workerVersion = ${JSON.stringify(version)};`
	);
	if (updated === source) throw new Error('Could not find the Worker HMR version marker.');
	await writeFile(workerPath, updated);
}

export async function writeConnectHandler(root: string, enabled: boolean) {
	const workerPath = path.join(root, 'src/worker.ts');
	const source = await readFile(workerPath, 'utf8');
	const updated = source.replace(
		/\/\/ CONNECT_HANDLER_START[\s\S]*?\/\/ CONNECT_HANDLER_END/,
		`// CONNECT_HANDLER_START\n${enabled ? connectHandlerSource : ''}// CONNECT_HANDLER_END`
	);
	if (updated === source) {
		throw new Error(`The Worker connect handler is already ${enabled ? 'enabled' : 'disabled'}.`);
	}
	await writeFile(workerPath, updated);
}

export async function writeApplicationHooks(
	root: string,
	enabled: boolean,
	hooksFile = 'src/application-hooks.server.ts'
) {
	const hooksPath = path.join(root, hooksFile);
	if (!enabled) {
		await rm(hooksPath, { force: true });
		return;
	}
	await writeFile(
		hooksPath,
		`import type { Handle } from '@sveltejs/kit/hooks';

export const handle: Handle = async ({ event, resolve }) => {
\tconst response = await resolve(event);
\tconst headers = new Headers(response.headers);
\theaders.set('x-application-hook', 'true');
\treturn new Response(response.body, { status: response.status, headers });
};
`
	);
}

async function writePackageFiles(
	root: string,
	repoRoot: string,
	{
		basePath = '',
		connectPort = 0,
		productionOnlyBinding = false,
		wranglerConnectPort,
		useDefaultHooks = false,
		withHooks = true
	}: {
		basePath?: string;
		connectPort?: number;
		productionOnlyBinding?: boolean;
		wranglerConnectPort?: number;
		useDefaultHooks?: boolean;
		withHooks?: boolean;
	}
) {
	const adapterTcpOptions =
		wranglerConnectPort === undefined ? `, connectPort: ${connectPort}` : '';
	const hooksConfig = useDefaultHooks
		? ''
		: "\t\tfiles: { hooks: { server: 'src/application-hooks.server.ts' } },\n";
	await writeFile(
		path.join(root, 'package.json'),
		JSON.stringify(
			{
				type: 'module',
				private: true,
				imports: { '#lib': './src/lib', '#lib/*': './src/lib/*' }
			},
			null,
			'\t'
		)
	);
	await writeFile(
		path.join(root, 'vite.config.ts'),
		`import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { cloudflareWorker } from ${JSON.stringify(
			pathToFileURL(path.join(repoRoot, 'src/lib/index.js')).href
		)};

export default defineConfig({
\tcacheDir: '.vite-cache',
\tplugins: [
\t\tsveltekit(cloudflareWorker({
${hooksConfig}		\tpaths: { base: ${JSON.stringify(basePath)} },
\t\t\tcompilerOptions: {
\t\t\t\texperimental: {
\t\t\t\t\tasync: true
\t\t\t\t}
\t\t\t},
\t\t\texperimental: {
\t\t\t\tremoteFunctions: true
\t\t\t}
\t\t}, { typesFile: false${adapterTcpOptions}, verbose: ${connectPort !== 0 || wranglerConnectPort !== undefined} }))
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
				...(wranglerConnectPort === undefined
					? {}
					: {
							connect: [{ protocol: 'tcp', address: '127.0.0.1', port: wranglerConnectPort }]
						}),
				assets: {
					binding: 'ASSETS',
					directory: '.svelte-kit/cloudflare',
					run_worker_first: true
				},
				migrations: [{ tag: 'v1', new_sqlite_classes: ['CounterDurableObject'] }],
				durable_objects: {
					bindings: [{ name: 'COUNTER_DO', class_name: 'CounterDurableObject' }]
				},
				workflows: [
					{
						name: 'fixture-workflow',
						binding: 'FIXTURE_WORKFLOW',
						class_name: 'FixtureWorkflow'
					}
				],
				triggers: { crons: ['* * * * *'] },
				...(productionOnlyBinding
					? { vectorize: [{ binding: 'VECTOR', index_name: 'documents' }] }
					: {}),
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
	await writeFile(
		path.join(root, 'src/instrumentation.server.ts'),
		"(globalThis as typeof globalThis & { __fixtureInstrumentation?: string }).__fixtureInstrumentation = 'loaded';\n"
	);
	await mkdir(path.join(root, 'src/lib'), { recursive: true });
	await writeFile(
		path.join(root, 'src/lib/worker-alias.ts'),
		"export const aliasValue = 'alias';\n"
	);
	await writeFile(
		path.join(root, 'src/service-worker.ts'),
		"self.addEventListener('install', () => undefined);\n"
	);
	if (withHooks) {
		await writeApplicationHooks(
			root,
			true,
			useDefaultHooks ? 'src/hooks.server.ts' : 'src/application-hooks.server.ts'
		);
	}
	await writeFile(path.join(root, 'static/fixture.txt'), 'asset fixture');
}

async function writeWorker(root: string, withConnect: boolean) {
	await writeFile(
		path.join(root, 'src/worker.ts'),
		`import { Buffer } from 'node:buffer';
import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
import { aliasValue } from '#lib/worker-alias.js';

type Env = {
\tCOUNTER_DO: DurableObjectNamespace<CounterDurableObject>;
\tFIXTURE_WORKFLOW: Workflow<{ source: string }>;
\tASSETS: Fetcher;
};

const workerVersion = 'one';
export const internalHelper = 42;

export const fetch = async (
\trequest: Request,
\tenv: Env,
\t_ctx: ExecutionContext,
\tnext: () => Promise<Response>
) => {
\tconst url = new URL(request.url);
\tif (url.pathname === '/api/worker-version') {
\t\treturn Response.json({ version: workerVersion });
\t}

\tif (url.pathname === '/api/context-brand') {
\t\t_ctx.passThroughOnException();
\t\treturn new Response('context-ok');
\t}

\tif (url.pathname === '/api/module-resolution') {
\t\treturn Response.json({ aliasValue, bytes: Buffer.from('ok').length, internalHelper });
\t}

\tif (url.pathname === '/api/runtime-env') {
\t\t(globalThis as typeof globalThis & { __fixtureWorkerEnv?: Env }).__fixtureWorkerEnv = env;
\t\treturn next();
\t}

\tif (url.pathname === '/api/instrumentation') {
\t\tconst value = (globalThis as typeof globalThis & { __fixtureInstrumentation?: string })
\t\t\t.__fixtureInstrumentation;
\t\treturn Response.json({ value });
\t}

\tif (url.pathname === '/api/do/increment') {
\t\tconst id = env.COUNTER_DO.idFromName(url.searchParams.get('name') ?? 'shared-realm');
\t\tconst count = await env.COUNTER_DO.get(id).increment();
\t\treturn Response.json({ count });
\t}

\tif (url.pathname === '/api/do/socket') {
\t\treturn env.COUNTER_DO.getByName(url.searchParams.get('name') ?? 'shared-realm').fetch(request);
\t}

\tif (url.pathname === '/api/do/broadcast') {
\t\tconst stub = env.COUNTER_DO.getByName(url.searchParams.get('name') ?? 'shared-realm');
\t\tconst connections = await stub.broadcast(url.searchParams.get('message') ?? 'broadcast');
\t\treturn Response.json({ connections });
\t}

\tif (url.pathname === '/__probe-middleware-chain') {
\t\tconst name = url.searchParams.get('name') ?? 'middleware-chain';
\t\tconst stub = env.COUNTER_DO.getByName(name);
\t\tconst before = await stub.increment();
\t\tconst response = await next();
\t\tconst kit = (await response.json()) as { kit: number };
\t\tconst after = await stub.increment();
\t\treturn Response.json({ before, kit: kit.kit, after });
\t}

\tif (url.pathname === '/api/workflow/start') {
\t\tconst instance = await env.FIXTURE_WORKFLOW.create({
\t\t\tid: crypto.randomUUID(),
\t\t\tparams: { source: 'worker' }
\t\t});
\t\treturn Response.json({ id: instance.id });
\t}

\tif (url.pathname.startsWith('/api/workflow/status/')) {
\t\tconst id = url.pathname.slice('/api/workflow/status/'.length);
\t\treturn Response.json(await (await env.FIXTURE_WORKFLOW.get(id)).status());
\t}

\tif (url.pathname === '/api/scheduled/count') {
\t\tconst id = env.COUNTER_DO.idFromName('scheduled');
\t\treturn Response.json({ count: await env.COUNTER_DO.get(id).getCount() });
\t}
};

export const scheduled = async (_controller: ScheduledController, env: Env) => {
\tconst id = env.COUNTER_DO.idFromName('scheduled');
\tawait env.COUNTER_DO.get(id).increment();
};

// CONNECT_HANDLER_START
${withConnect ? connectHandlerSource : ''}// CONNECT_HANDLER_END

export class CounterDurableObject extends DurableObject<Env> {
\tasync increment() {
\t\tconst count = ((await this.ctx.storage.get<number>('count')) ?? 0) + 1;
\t\tawait this.ctx.storage.put('count', count);
\t\treturn count;
\t}

\tasync getCount() {
\t\treturn (await this.ctx.storage.get<number>('count')) ?? 0;
\t}

\tasync fetch(request: Request) {
\t\tif (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
\t\t\treturn new Response('Expected a WebSocket upgrade.', { status: 426 });
\t\t}
\t\tconst [client, server] = Object.values(new WebSocketPair());
\t\tthis.ctx.acceptWebSocket(server);
\t\tif (new URL(request.url).searchParams.get('mode') === 'hmr') {
\t\t\tserver.send(JSON.stringify({ version: workerVersion }));
\t\t}
\t\treturn new Response(null, { status: 101, webSocket: client });
\t}

\tasync broadcast(message: string) {
\t\tconst sockets = this.ctx.getWebSockets();
\t\tfor (const socket of sockets) {
\t\t\tsocket.send(JSON.stringify({ broadcast: message, version: workerVersion }));
\t\t}
\t\treturn sockets.length;
\t}

\tasync connect(socket: Socket) {
\t\tconst count = await this.increment();
\t\tconst writer = socket.writable.getWriter();
\t\tawait writer.write(new TextEncoder().encode(\`durable-object:\${count}\\n\`));
\t\twriter.releaseLock();
\t\tawait socket.readable.pipeTo(socket.writable);
\t}

\tasync webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
\t\tconst count = await this.increment();
\t\tsocket.send(JSON.stringify({ count, message: String(message) }));
\t}
}

export class FixtureWorkflow extends WorkflowEntrypoint<Env, { source: string }> {
\tasync run(event: Readonly<WorkflowEvent<{ source: string }>>, step: WorkflowStep) {
\t\treturn step.do('increment durable object', async () => {
\t\t\tconst id = this.env.COUNTER_DO.idFromName('workflow-realm');
\t\t\tconst count = await this.env.COUNTER_DO.get(id).increment();
\t\t\treturn { source: event.payload.source, count };
\t\t});
\t}
}
`
	);
}

const connectHandlerSource = `export const connect = async (socket: Socket, env: Env) => {
\tconst durableObjectSocket = env.COUNTER_DO.getByName('tcp-connect').connect('tcp.local:8788');
\tawait durableObjectSocket.opened;
\tawait Promise.all([
\t\tsocket.readable.pipeTo(durableObjectSocket.writable),
\t\tdurableObjectSocket.readable.pipeTo(socket.writable)
\t]);
};

`;

async function writeRoutes(root: string, prerenderHome: boolean) {
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
		`${prerenderHome ? 'export const prerender = true;\n\n' : ''}export const load = async () => {
\tawait import('#lib/dynamic.css');
\treturn {};
};
`
	);
	await writeProbeRoute(root);
	await writeMiddlewareChainProbeRoute(root);
	await writeRuntimeEnvProbeRoute(root);
	await writeRemoteProbeRoute(root);
	await writeServerReadProbeRoute(root);
	await writeWorkflowProbeRoute(root);
	await writeFile(
		path.join(root, 'src/params.ts'),
		`import { defineParams } from '@sveltejs/kit/params';

export const params = defineParams({
\tdigits: (param) => (/^\\d+$/.test(param) ? param : undefined)
});
`
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

async function writeMiddlewareChainProbeRoute(root: string) {
	await mkdir(path.join(root, 'src/routes/__probe-middleware-chain'), { recursive: true });
	await writeFile(
		path.join(root, 'src/routes/__probe-middleware-chain/+server.ts'),
		`import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ platform, url }) => {
\tconst name = url.searchParams.get('name') ?? 'middleware-chain';
\tconst kit = await platform!.env.COUNTER_DO.getByName(name).increment();
\treturn Response.json({ kit });
};
`
	);
}

async function writeWorkflowProbeRoute(root: string) {
	await mkdir(path.join(root, 'src/routes/__probe-workflow'), { recursive: true });
	await writeFile(
		path.join(root, 'src/routes/__probe-workflow/+server.ts'),
		`import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async ({ platform }) => {
\tconst instance = await platform!.env.FIXTURE_WORKFLOW.create({
\t\tid: crypto.randomUUID(),
\t\tparams: { source: 'sveltekit' }
\t});
\treturn Response.json({ id: instance.id });
};

export const GET: RequestHandler = async ({ platform, url }) => {
\tconst id = url.searchParams.get('id');
\tif (!id) return new Response('Missing workflow id', { status: 400 });
\treturn Response.json(await (await platform!.env.FIXTURE_WORKFLOW.get(id)).status());
};
`
	);
}

async function writeProbeRoute(root: string) {
	await mkdir(path.join(root, 'src/routes/__probe-sveltekit-bindings'), { recursive: true });
	await writeFile(
		path.join(root, 'src/routes/__probe-sveltekit-bindings/+server.ts'),
		`import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ platform, url }) => {
\tconst env = platform?.env;
\tif (!env?.COUNTER_DO) {
\t\treturn Response.json({ ok: false, keys: Object.keys(env ?? {}).sort() }, { status: 500 });
\t}

\tconst id = env.COUNTER_DO.idFromName(url.searchParams.get('name') ?? 'shared-realm');
\tconst count = await env.COUNTER_DO.get(id).increment();
\treturn Response.json({
\t\tok: true,
\t\tcount,
\t\tkeys: Object.keys(env).sort()
\t});
};
`
	);
}

async function writeRuntimeEnvProbeRoute(root: string) {
	await mkdir(path.join(root, 'src/routes/api/runtime-env'), { recursive: true });
	await writeFile(
		path.join(root, 'src/routes/api/runtime-env/+server.ts'),
		`import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = ({ platform }) => {
\tconst workerEnv = (globalThis as typeof globalThis & { __fixtureWorkerEnv?: object })
\t\t.__fixtureWorkerEnv;
\treturn Response.json({ sameEnv: workerEnv === platform?.env });
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
import readableUrl from '#lib/readable.txt?url';

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
		`import { getFixtureValue } from '#lib/fixture.remote.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async () => {
\treturn Response.json({ body: await getFixtureValue() });
};
`
	);
}

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requestTimeoutMs = 10_000;
const temporaryRoots: string[] = [];
const servers: Server[] = [];

export type Server = {
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	getOutput(): string;
	hasExited(): boolean;
	stop(): Promise<void>;
};

export async function cleanupFixtures() {
	await Promise.all(servers.splice(0).map((server) => server.stop()));
	if (process.env.SKCW_KEEP_INTEGRATION_FIXTURES) return;
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
}

export type FixtureOptions = {
	/** Wrangler config overrides merged at the top level. */
	wrangler?: Record<string, unknown>;
	/** Extra files, relative to the fixture root. */
	files?: Record<string, string>;
};

/** A SvelteKit 3 app (no svelte.config.js) using the package from this repository. */
export async function createFixture(options: FixtureOptions = {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'skcw-integration-'));
	temporaryRoots.push(root);
	await symlink(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
	const name = `skcw-fixture-${path.basename(root).slice(-6).toLowerCase()}`;
	const wrangler = {
		$schema: 'node_modules/wrangler/config-schema.json',
		name,
		main: '.svelte-kit/cloudflare/_worker.js',
		compatibility_date: '2026-10-01',
		compatibility_flags: ['nodejs_compat'],
		assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' },
		vars: { GREETING: 'hello from vars' },
		kv_namespaces: [{ binding: 'KV', id: 'fixture-kv' }],
		durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
		migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
		queues: {
			producers: [{ binding: 'JOBS', queue: `${name}-jobs` }],
			consumers: [{ queue: `${name}-jobs`, max_batch_size: 1, max_batch_timeout: 1 }]
		},
		triggers: { crons: ['*/5 * * * *'] },
		...options.wrangler
	};

	const files: Record<string, string> = {
		'package.json': JSON.stringify(
			{
				name,
				private: true,
				type: 'module',
				imports: { '#lib': './src/lib', '#lib/*': './src/lib/*' }
			},
			null,
			'\t'
		),
		'vite.config.ts': `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { cloudflareWorker } from ${JSON.stringify(path.join(repoRoot, 'src/lib/index.js'))};

export default defineConfig({
	cacheDir: 'node_modules/.vite-${name}',
	resolve: { alias: { $lib: new URL('./src/lib', import.meta.url).pathname } },
	plugins: [sveltekit(cloudflareWorker({}, { remoteBindings: false, typesFile: false }))]
});
`,
		'wrangler.jsonc': JSON.stringify(wrangler, null, '\t'),
		'src/app.html': `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		%sveltekit.head%
	</head>
	<body>
		<div>%sveltekit.body%</div>
	</body>
</html>
`,
		'src/routes/+page.svelte': '<h1>fixture home</h1>\n',
		'src/routes/wrapped/+page.svelte': '<h1>wrapped page</h1>\n',
		'src/routes/kit/counter/+server.ts': `import { env } from 'cloudflare:workers';

export const GET = async ({ url }) => {
	const name = url.searchParams.get('name') ?? 'shared';
	const count = await env.COUNTER.getByName(name).increment();
	return Response.json({ source: 'sveltekit', count, greeting: env.GREETING });
};
`,
		'src/routes/kit/kv/+server.ts': `import { env } from 'cloudflare:workers';

export const GET = async ({ url }) => {
	return Response.json({ value: await env.KV.get(url.searchParams.get('key') ?? '') });
};
`,
		'src/lib/message.ts': `export const message = 'hello from $lib';\n`,
		'src/lib/hash.ts': `import { createHash } from 'crypto';
import { randomUUID } from 'node:crypto';

export function hash(value: string) {
	return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function uuidLength() {
	return randomUUID().length;
}
`,
		'src/worker.ts': workerSource('v1'),
		...options.files
	};

	for (const [file, contents] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await writeFile(path.join(root, file), contents);
	}
	return root;
}

/** The fixture Worker. `version` is returned by /api/version and changes on HMR. */
function workerSource(version: string) {
	return `import { DurableObject } from 'cloudflare:workers';
import { message } from '$lib/message';
import { hash, uuidLength } from '#lib/hash';

export const VERSION = ${JSON.stringify(version)};

export async function fetch(request, env, ctx, next) {
	const url = new URL(request.url);
	if (url.pathname === '/api/version') return Response.json({ version: VERSION });
	if (url.pathname === '/api/modules') {
		return Response.json({ message, hash: hash('fixture'), uuidLength: uuidLength() });
	}
	if (url.pathname === '/api/counter') {
		const name = url.searchParams.get('name') ?? 'shared';
		return Response.json({ source: 'worker', count: await env.COUNTER.getByName(name).increment() });
	}
	if (url.pathname === '/api/socket') {
		return env.COUNTER.getByName(url.searchParams.get('name') ?? 'socket').fetch(request);
	}
	if (url.pathname === '/api/enqueue') {
		const id = url.searchParams.get('id') ?? 'job';
		await env.JOBS.send({ id });
		return Response.json({ queued: id });
	}
	if (url.pathname === '/wrapped') {
		const response = await next();
		const wrapped = new Response(response.body, response);
		wrapped.headers.set('x-worker-after', VERSION);
		return wrapped;
	}
	if (url.pathname === '/api/wait-until-last') {
		const order = [];
		ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, 20)).then(() => order.push('first')));
		ctx.waitUntil.last(async () => {
			order.push('last');
			await env.KV.put('wait-until-last', order.join(','));
		});
		return new Response('scheduled');
	}
}

export async function queue(batch, env) {
	for (const message of batch.messages) {
		await env.KV.put('queue:' + message.body.id, 'processed');
		message.ack();
	}
}

export async function scheduled(controller, env) {
	const current = Number((await env.KV.get('scheduled')) ?? 0);
	await env.KV.put('scheduled', String(current + 1));
	await env.KV.put('scheduled-cron', controller.cron);
}

export class Counter extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER)');
	}

	increment() {
		const row = this.ctx.storage.sql
			.exec('INSERT INTO counter (id, value) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1 RETURNING value')
			.one();
		return row.value;
	}

	async fetch(request) {
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	webSocketMessage(socket, data) {
		socket.send(VERSION + ':' + String(data) + ':' + this.increment());
	}
}
`;
}

export async function writeWorker(root: string, version: string) {
	await writeFile(path.join(root, 'src/worker.ts'), workerSource(version));
}

export async function readFixtureFile(root: string, file: string) {
	return readFile(path.join(root, file), 'utf-8');
}

export async function buildFixture(root: string) {
	const result = await runProcess(root, [
		path.join(root, 'node_modules/vite/bin/vite.js'),
		'build'
	]);
	return result;
}

export function startDevServer(root: string, port: number) {
	return startServer(root, [
		path.join(root, 'node_modules/vite/bin/vite.js'),
		'dev',
		'--host',
		'127.0.0.1',
		'--port',
		String(port),
		'--strictPort'
	]);
}

export function startWranglerDev(root: string, port: number) {
	return startServer(root, [
		path.join(root, 'node_modules/wrangler/bin/wrangler.js'),
		'dev',
		'--local',
		'--ip',
		'127.0.0.1',
		'--port',
		String(port),
		'--test-scheduled',
		'--show-interactive-dev-session=false'
	]);
}

function startServer(root: string, args: string[]): Server {
	const child: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, args, {
		cwd: root,
		env: childEnv({ CLOUDFLARE_ENV: '' }),
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	let output = '';
	let exited = false;
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on('exit', (code, signal) => {
			exited = true;
			resolve({ code, signal });
		});
	});
	child.stdout.on('data', (chunk) => (output += chunk.toString()));
	child.stderr.on('data', (chunk) => (output += chunk.toString()));

	const server: Server = {
		exit,
		getOutput: () => output,
		hasExited: () => exited,
		async stop() {
			if (exited) return;
			try {
				// Kill the whole process group so workerd children stop too.
				process.kill(-(child.pid as number), 'SIGTERM');
			} catch {
				child.kill('SIGTERM');
			}
			const timeout = setTimeout(() => {
				try {
					process.kill(-(child.pid as number), 'SIGKILL');
				} catch {
					child.kill('SIGKILL');
				}
			}, 5_000);
			await exit;
			clearTimeout(timeout);
		}
	};
	servers.push(server);
	return server;
}

function runProcess(root: string, args: string[]) {
	return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: root,
			env: childEnv(),
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let output = '';
		child.stdout.on('data', (chunk) => (output += chunk.toString()));
		child.stderr.on('data', (chunk) => (output += chunk.toString()));
		child.once('error', reject);
		child.once('exit', (code) => resolve({ code, output }));
	});
}

/** Environment for spawned Vite/Wrangler processes: not a Vitest worker. */
function childEnv(extra: Record<string, string> = {}) {
	const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', FORCE_COLOR: '0', ...extra };
	for (const key of Object.keys(env)) {
		if (key === 'VITEST' || key.startsWith('VITEST_')) delete env[key];
	}
	return env;
}

export async function getAvailablePort() {
	return new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				reject(new Error('No port'));
				return;
			}
			server.close(() => resolve(address.port));
		});
	});
}

export async function waitFor<T>(server: Server, check: () => Promise<T>, timeoutMs = 90_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (server.hasExited()) {
			throw new Error(`Server exited early.\n${server.getOutput()}`);
		}
		try {
			return await check();
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(
		`Timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${server.getOutput()}`
	);
}

export async function fetchOk(url: string, init?: RequestInit) {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
	if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
	return response;
}

export async function fetchJson<T>(url: string) {
	return (await (await fetchOk(url)).json()) as T;
}

export async function waitForJson<T>(
	server: Server,
	url: string,
	predicate: (body: T) => boolean,
	timeoutMs?: number
) {
	return waitFor(
		server,
		async () => {
			const body = await fetchJson<T>(url);
			if (!predicate(body)) throw new Error(`${url} returned ${JSON.stringify(body)}`);
			return body;
		},
		timeoutMs
	);
}

/** Open a WebSocket, send one message and resolve with the first reply. */
export async function webSocketRoundTrip(url: string, message: string) {
	const socket = new WebSocket(url);
	try {
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener('open', () => resolve(), { once: true });
			socket.addEventListener('error', () => reject(new Error(`WebSocket ${url} failed`)), {
				once: true
			});
		});
		const reply = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('WebSocket reply timed out')), 10_000);
			socket.addEventListener(
				'message',
				(event) => {
					clearTimeout(timer);
					resolve(String(event.data));
				},
				{ once: true }
			);
		});
		socket.send(message);
		return await reply;
	} finally {
		socket.close();
	}
}

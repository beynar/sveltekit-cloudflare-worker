import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { writeHmrEndpoint, writeWorkerdSsrFixtureFiles } from './workerd-ssr-files.js';

export type DevServer = {
	child: ChildProcessByStdio<null, Readable, Readable>;
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	getOutput(): string;
	hasExited(): boolean;
	writeHmrEndpoint(version: string): Promise<void>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoots: string[] = [];
const devServers: DevServer[] = [];

export async function cleanupWorkerdSsrFixtures() {
	await Promise.all(devServers.splice(0).map(stopDevServer));
	if (process.env.SKCW_KEEP_INTEGRATION_FIXTURES) return;
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
}

export async function createWorkerdSsrFixture() {
	const root = await mkdtemp(path.join(tmpdir(), 'sveltekit-cloudflare-worker-integration-'));
	temporaryRoots.push(root);

	await symlink(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
	await mkdir(path.join(root, 'src/routes'), { recursive: true });
	await mkdir(path.join(root, 'src/params'), { recursive: true });
	await mkdir(path.join(root, 'static'), { recursive: true });

	await writeWorkerdSsrFixtureFiles(root, repoRoot);

	return root;
}

export function startDevServer(root: string, port: number): DevServer {
	const child = spawn(
		process.execPath,
		[
			path.join(root, 'node_modules/vite/bin/vite.js'),
			'dev',
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
			'--strictPort'
		],
		{
			cwd: root,
			env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
	let output = '';
	let exited = false;
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on('exit', (code, signal) => {
			exited = true;
			resolve({ code, signal });
		});
	});
	child.stdout.on('data', (chunk) => {
		output += chunk.toString();
	});
	child.stderr.on('data', (chunk) => {
		output += chunk.toString();
	});

	const server = {
		child,
		exit,
		getOutput: () => output,
		hasExited: () => exited,
		writeHmrEndpoint: (version: string) => writeHmrEndpoint(root, version)
	};
	devServers.push(server);
	return server;
}

export async function waitForResponse(server: DevServer, url: string) {
	return waitFor(server, async () => {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
		return response;
	});
}

export async function waitForJson<T>(
	server: DevServer,
	url: string,
	predicate: (body: T) => boolean
) {
	return waitFor(server, async () => {
		const body = await readJson<T>(url);
		if (!predicate(body)) throw new Error(`${url} returned an unexpected body`);
		return body;
	});
}

export async function readJson<T>(url: string) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
	return (await response.json()) as T;
}

export async function getAvailablePort() {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Could not allocate a TCP port.');
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
	return address.port;
}

async function stopDevServer(server: DevServer) {
	if (server.hasExited()) return;

	server.child.kill('SIGTERM');
	await Promise.race([
		server.exit,
		delay(5_000).then(() => {
			if (!server.hasExited()) server.child.kill('SIGKILL');
		})
	]);
}

async function waitFor<T>(server: DevServer, callback: () => Promise<T>) {
	const started = Date.now();
	let lastError: unknown;

	while (Date.now() - started < 30_000) {
		if (server.hasExited()) {
			throw new Error(`Dev server exited before the probe passed.\n${server.getOutput()}`);
		}

		try {
			return await callback();
		} catch (error) {
			lastError = error;
			await delay(250);
		}
	}

	const message = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Timed out waiting for dev server probe: ${message}\n${server.getOutput()}`);
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

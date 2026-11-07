import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
	writeConnectHandler,
	writeHmrEndpoint,
	writeWorkerdSsrFixtureFiles,
	writeWorkerVersion
} from './workerd-ssr-files.js';

export type DevServer = {
	child: ChildProcessByStdio<null, Readable, Readable>;
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	getOutput(): string;
	hasExited(): boolean;
	writeHmrEndpoint(version: string): Promise<void>;
	writeConnectHandler(enabled: boolean): Promise<void>;
	writeWorkerVersion(version: string): Promise<void>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requestTimeoutMs = 5_000;
const temporaryRoots: string[] = [];
const devServers: DevServer[] = [];

export async function cleanupWorkerdSsrFixtures() {
	await Promise.all(devServers.splice(0).map(stopDevServer));
	if (process.env.SKCW_KEEP_INTEGRATION_FIXTURES) return;
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
}

export async function createWorkerdSsrFixture(
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
	const root = await mkdtemp(path.join(tmpdir(), 'sveltekit-cloudflare-worker-integration-'));
	temporaryRoots.push(root);

	await symlink(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
	await mkdir(path.join(root, 'src/routes'), { recursive: true });
	await mkdir(path.join(root, 'static'), { recursive: true });

	await writeWorkerdSsrFixtureFiles(root, repoRoot, options);

	return root;
}

export async function buildWorkerdSsrFixture(root: string) {
	const { code, signal, output } = await runProcess(root, [
		path.join(root, 'node_modules/vite/bin/vite.js'),
		'build'
	]);

	if (code !== 0) {
		throw new Error(`Fixture build failed with code ${code} and signal ${signal}.\n${output}`);
	}
	return output;
}

export function startDevServer(root: string, port: number): DevServer {
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

export function startPreviewServer(root: string, port: number): DevServer {
	return startServer(root, [
		path.join(root, 'node_modules/vite/bin/vite.js'),
		'preview',
		'--host',
		'127.0.0.1',
		'--port',
		String(port),
		'--strictPort'
	]);
}

export function startWranglerServer(root: string, port: number): DevServer {
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

function startServer(root: string, args: string[]): DevServer {
	const child = spawn(process.execPath, args, {
		cwd: root,
		env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
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
		writeHmrEndpoint: (version: string) => writeHmrEndpoint(root, version),
		writeConnectHandler: (enabled: boolean) => writeConnectHandler(root, enabled),
		writeWorkerVersion: (version: string) => writeWorkerVersion(root, version)
	};
	devServers.push(server);
	return server;
}

function runProcess(root: string, args: string[]) {
	return new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		output: string;
	}>((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: root,
			env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let output = '';
		child.stdout.on('data', (chunk) => {
			output += chunk.toString();
		});
		child.stderr.on('data', (chunk) => {
			output += chunk.toString();
		});
		child.once('error', reject);
		child.once('exit', (code, signal) => resolve({ code, signal, output }));
	});
}

export async function waitForResponse(server: DevServer, url: string) {
	return waitFor(server, async () => {
		const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
		if (!response.ok)
			throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
		return response;
	});
}

export async function waitForResponseWhere(
	server: DevServer,
	url: string,
	predicate: (response: Response) => boolean
) {
	return waitFor(server, async () => {
		const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
		if (!response.ok) {
			throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
		}
		if (!predicate(response)) throw new Error(`${url} returned unexpected response headers`);
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
	const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
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

export async function stopDevServer(server: DevServer) {
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

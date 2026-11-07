import { stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	cleanupWorkerdSsrFixtures,
	createWorkerdSsrFixture,
	getAvailablePort,
	readJson,
	startDevServer,
	stopDevServer,
	waitForJson,
	waitForResponse,
	waitForResponseWhere
} from './workerd-ssr-fixture.js';
import { writeApplicationHooks } from './workerd-ssr-files.js';

afterEach(cleanupWorkerdSsrFixtures);

describe('workerd SSR dev mode', () => {
	it('loads a default hook created after startup and unloads it after deletion', async () => {
		const root = await createWorkerdSsrFixture({ useDefaultHooks: true, withHooks: false });
		const port = await getAvailablePort();
		const server = startDevServer(root, port);
		const url = `http://127.0.0.1:${port}/`;

		const before = await waitForResponse(server, url);
		expect(before.headers.get('x-application-hook')).toBeNull();

		await writeApplicationHooks(root, true, 'src/hooks.server.ts');
		const created = await waitForResponseWhere(
			server,
			url,
			(response) => response.headers.get('x-application-hook') === 'true'
		);
		expect(created.headers.get('x-application-hook')).toBe('true');

		await writeApplicationHooks(root, false, 'src/hooks.server.ts');
		const deleted = await waitForResponseWhere(
			server,
			url,
			(response) => response.headers.get('x-application-hook') === null
		);
		expect(deleted.headers.get('x-application-hook')).toBeNull();
	});

	it('keeps Node RPC and Worker WebSockets on one live Durable Object after Worker HMR', async () => {
		const root = await createWorkerdSsrFixture();
		const port = await getAvailablePort();
		const server = startDevServer(root, port);
		const baseUrl = `http://127.0.0.1:${port}`;
		const name = `hmr-${crypto.randomUUID()}`;
		await waitForResponse(server, `${baseUrl}/`);

		const before = await openVersionedSocket(
			`${baseUrl}/api/do/socket?mode=hmr&name=${encodeURIComponent(name)}`,
			{ version: 'one' }
		);
		const nodeBefore = await readJson<{ count: number }>(
			`${baseUrl}/__probe-sveltekit-bindings?name=${encodeURIComponent(name)}`
		);
		expect(nodeBefore.count).toBe(1);
		expect(
			await readJson<{ connections: number }>(
				`${baseUrl}/api/do/broadcast?name=${encodeURIComponent(name)}&message=before-hmr`
			)
		).toEqual({ connections: 1 });
		await expect(before.messages.next()).resolves.toEqual({
			broadcast: 'before-hmr',
			version: 'one'
		});

		await server.writeWorkerVersion('two');
		await waitForJson<{ version: string }>(
			server,
			`${baseUrl}/api/worker-version`,
			(body) => body.version === 'two'
		);
		const nodeAfter = await readJson<{ count: number }>(
			`${baseUrl}/__probe-sveltekit-bindings?name=${encodeURIComponent(name)}`
		);
		expect(nodeAfter.count).toBe(2);
		expect(
			await readJson<{ connections: number }>(
				`${baseUrl}/api/do/broadcast?name=${encodeURIComponent(name)}&message=after-hmr`
			)
		).toEqual({ connections: 1 });
		await expect(before.messages.next()).resolves.toEqual({
			broadcast: 'after-hmr',
			version: 'two'
		});
		before.socket.close();
	});

	it('routes the Worker connect handler to an owned Durable Object', async () => {
		const connectPort = await getAvailablePort();
		const root = await createWorkerdSsrFixture({ wranglerConnectPort: connectPort });
		const httpPort = await getAvailablePort();
		const server = startDevServer(root, httpPort);
		const baseUrl = `http://127.0.0.1:${httpPort}`;
		await waitForResponse(server, `${baseUrl}/`);

		let response: string;
		try {
			response = await exchangeTcp(
				connectPort,
				'from-tcp-client',
				'durable-object:1\nfrom-tcp-client'
			);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\n${server.getOutput()}`,
				{ cause: error }
			);
		}
		expect(response).toBe('durable-object:1\nfrom-tcp-client');

		const sameObject = await readJson<{ count: number }>(
			`${baseUrl}/api/do/increment?name=tcp-connect`
		);
		expect(sameObject.count).toBe(2);
	});

	it('activates a connect export added during development without a manual restart', async () => {
		const connectPort = await getAvailablePort();
		const root = await createWorkerdSsrFixture({
			wranglerConnectPort: connectPort,
			withConnect: false
		});
		const httpPort = await getAvailablePort();
		const server = startDevServer(root, httpPort);
		await waitForResponse(server, `http://127.0.0.1:${httpPort}/`);

		await server.writeConnectHandler(true);
		const response = await waitForTcpExchange(
			server,
			connectPort,
			'after-export-hmr',
			'durable-object:1\nafter-export-hmr'
		);
		expect(response).toBe('durable-object:1\nafter-export-hmr');
		expect(server.getOutput()).not.toMatch(/server restarted/i);
	});

	it('serves SvelteKit SSR inside workerd with native Worker bindings', async () => {
		const root = await createWorkerdSsrFixture();
		const port = await getAvailablePort();
		const server = startDevServer(root, port);
		const baseUrl = `http://127.0.0.1:${port}`;

		const home = await waitForResponse(server, `${baseUrl}/`);
		expect(home.headers.get('x-application-hook')).toBe('true');
		const homeHtml = await home.text();
		expect(homeHtml).toContain('fixture home');
		expect(homeHtml).toContain('<style data-sveltekit>');
		expect(homeHtml).toContain('.layout-style-probe');
		expect(homeHtml).toContain('.page-style-probe');
		expect(homeHtml).toContain('.dynamic-style-probe');

		const instrumentation = await readJson<{ value: string }>(`${baseUrl}/api/instrumentation`);
		expect(instrumentation.value).toBe('loaded');
		const context = await fetch(`${baseUrl}/api/context-brand`);
		expect(context.status, server.getOutput()).toBe(200);
		await expect(context.text()).resolves.toBe('context-ok');
		expect(await readJson(`${baseUrl}/api/module-resolution`)).toEqual({
			aliasValue: 'alias',
			bytes: 2,
			internalHelper: 42
		});

		const workerCounter = await readJson<{ count: number }>(`${baseUrl}/api/do/increment`);
		expect(workerCounter.count).toBeGreaterThan(0);

		const svelteKitProbe = await readJson<{
			ok: boolean;
			count: number;
			keys: string[];
		}>(`${baseUrl}/__probe-sveltekit-bindings`);
		expect(svelteKitProbe.ok).toBe(true);
		expect(svelteKitProbe.count).toBe(workerCounter.count + 1);
		expect(svelteKitProbe.keys).toContain('COUNTER_DO');
		expect(svelteKitProbe.keys).toContain('ASSETS');

		const runtimeEnv = await readJson<{ sameEnv: boolean }>(`${baseUrl}/api/runtime-env`);
		expect(runtimeEnv.sameEnv).toBe(true);

		const chain = await readJson<{ before: number; kit: number; after: number }>(
			`${baseUrl}/__probe-middleware-chain?name=${crypto.randomUUID()}`
		);
		expect(chain).toEqual({ before: 1, kit: 2, after: 3 });

		const socketName = `socket-${crypto.randomUUID()}`;
		const firstHttp = await readJson<{ count: number }>(
			`${baseUrl}/api/do/increment?name=${encodeURIComponent(socketName)}`
		);
		expect(firstHttp.count).toBe(1);
		const socketMessage = await exchangeWebSocket(
			`${baseUrl}/api/do/socket?name=${encodeURIComponent(socketName)}`,
			'from-browser'
		);
		expect(socketMessage).toEqual({ count: 2, message: 'from-browser' });
		const afterSocket = await readJson<{ count: number }>(
			`${baseUrl}/__probe-sveltekit-bindings?name=${encodeURIComponent(socketName)}`
		);
		expect(afterSocket.count).toBe(3);

		const workerWorkflow = await readJson<{ id: string }>(`${baseUrl}/api/workflow/start`);
		const workerWorkflowStatus = await waitForJson<WorkflowStatus>(
			server,
			`${baseUrl}/api/workflow/status/${workerWorkflow.id}`,
			(body) => body.status === 'complete'
		);
		expect(workerWorkflowStatus.output?.source).toBe('worker');
		expect(workerWorkflowStatus.output?.count).toBeGreaterThan(0);

		const svelteKitWorkflowResponse = await fetch(`${baseUrl}/__probe-workflow`, {
			method: 'POST',
			headers: { origin: baseUrl }
		});
		const svelteKitWorkflow = (await svelteKitWorkflowResponse.json()) as { id: string };
		expect(svelteKitWorkflowResponse.status, server.getOutput()).toBe(200);
		const svelteKitWorkflowStatus = await waitForJson<WorkflowStatus>(
			server,
			`${baseUrl}/__probe-workflow?id=${svelteKitWorkflow.id}`,
			(body) => body.status === 'complete'
		);
		expect(svelteKitWorkflowStatus.output?.source).toBe('sveltekit');
		expect(svelteKitWorkflowStatus.output?.count).toBeGreaterThan(0);

		const scheduledResponse = await fetch(
			`${baseUrl}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('* * * * *')}`
		);
		expect(scheduledResponse.status, await scheduledResponse.text()).toBe(200);
		const scheduledCount = await waitForJson<{ count: number }>(
			server,
			`${baseUrl}/api/scheduled/count`,
			(body) => body.count > 0
		);
		expect(scheduledCount.count).toBeGreaterThan(0);

		const remoteProbeResponse = await fetch(`${baseUrl}/__probe-remotes`);
		const remoteProbeText = await remoteProbeResponse.text();
		expect(remoteProbeResponse.status, `${remoteProbeText}\n${server.getOutput()}`).toBe(200);
		const remoteProbe = JSON.parse(remoteProbeText) as {
			body: { value: string; hasCounter: boolean };
		};
		expect(remoteProbe.body.value, `${remoteProbeText}\n${server.getOutput()}`).toBe('available');
		expect(remoteProbe.body.hasCounter, `${remoteProbeText}\n${server.getOutput()}`).toBe(true);

		const serverReadProbeResponse = await fetch(`${baseUrl}/__probe-server-read`);
		const serverReadProbeText = await serverReadProbeResponse.text();
		expect(serverReadProbeResponse.status, `${serverReadProbeText}\n${server.getOutput()}`).toBe(
			200
		);
		const serverReadProbe = JSON.parse(serverReadProbeText) as {
			body: string;
			contentLength: string | null;
			url: string;
		};
		expect(serverReadProbe.body).toBe('server readable asset');
		expect(serverReadProbe.contentLength).toBe(String('server readable asset'.length));
		expect(serverReadProbe.url).toContain('readable.txt');

		const matchedRoute = await readJson<{ id: string }>(`${baseUrl}/42`);
		expect(matchedRoute.id).toBe('42');

		const unmatchedRoute = await fetch(`${baseUrl}/not-a-number`);
		const unmatchedText = await unmatchedRoute.text();
		expect(unmatchedRoute.status, `${unmatchedText}\n${server.getOutput()}`).toBe(404);

		const noSsr = await fetch(`${baseUrl}/no-ssr`);
		expect(noSsr.status).toBe(200);

		const staticAsset = await fetch(`${baseUrl}/fixture.txt`);
		await expect(staticAsset.text()).resolves.toBe('asset fixture');

		const serviceWorker = await fetch(`${baseUrl}/service-worker.js`);
		const serviceWorkerSource = await serviceWorker.text();
		expect(serviceWorker.status, serviceWorkerSource).toBe(200);
		expect(serviceWorker.headers.get('content-type')).toContain('application/javascript');
		expect(serviceWorkerSource).toContain('service-worker.ts');

		const firstHmr = await readJson<{ version: string }>(`${baseUrl}/hmr`);
		expect(firstHmr.version).toBe('one');
		await server.writeHmrEndpoint('two');
		const secondHmr = await waitForJson<{ version: string }>(
			server,
			`${baseUrl}/hmr`,
			(body) => body.version === 'two'
		);
		expect(secondHmr.version).toBe('two');

		const output = server.getOutput();
		expect(output).not.toMatch(/no such Durable Object class is exported/i);
		expect(output).not.toMatch(/invoke was called before connect/i);
		expect(output).not.toMatch(/outsideEmitter/i);
	});

	it('preserves SvelteKit base paths for pages, assets, and the service worker', async () => {
		const root = await createWorkerdSsrFixture({ basePath: '/app' });
		const port = await getAvailablePort();
		const server = startDevServer(root, port);
		const baseUrl = `http://127.0.0.1:${port}`;

		const home = await waitForResponse(server, `${baseUrl}/app/`);
		await expect(home.text()).resolves.toContain('fixture home');

		const staticAsset = await fetch(`${baseUrl}/app/fixture.txt`);
		expect(staticAsset.status).toBe(200);
		await expect(staticAsset.text()).resolves.toBe('asset fixture');

		const serviceWorker = await fetch(`${baseUrl}/app/service-worker.js`);
		const serviceWorkerSource = await serviceWorker.text();
		expect(serviceWorker.status, serviceWorkerSource).toBe(200);
		expect(serviceWorkerSource).toContain('/app/@fs/');
	});

	it('persists one Durable Object across a complete dev-server restart', async () => {
		const root = await createWorkerdSsrFixture();
		const name = crypto.randomUUID();
		const firstPort = await getAvailablePort();
		const firstServer = startDevServer(root, firstPort);
		const firstUrl = `http://127.0.0.1:${firstPort}/__probe-middleware-chain?name=${name}`;

		const first = await waitForJson<{ before: number; kit: number; after: number }>(
			firstServer,
			firstUrl,
			(body) => body.after === 3
		);
		expect(first).toEqual({ before: 1, kit: 2, after: 3 });
		await stopDevServer(firstServer);
		expect(
			(await stat(path.join(root, '.sveltekit-cloudflare-worker', 'local'))).isDirectory()
		).toBe(true);

		const secondPort = await getAvailablePort();
		const secondServer = startDevServer(root, secondPort);
		const secondUrl = `http://127.0.0.1:${secondPort}/__probe-middleware-chain?name=${name}`;
		const second = await waitForJson<{ before: number; kit: number; after: number }>(
			secondServer,
			secondUrl,
			(body) => body.after === 6
		);
		expect(second).toEqual({ before: 4, kit: 5, after: 6 });
	});
});

function exchangeWebSocket(url: string, message: string) {
	const websocketUrl = new URL(url);
	websocketUrl.protocol = 'ws:';
	return new Promise<{ count: number; message: string }>((resolve, reject) => {
		const socket = new WebSocket(websocketUrl);
		const timeout = setTimeout(() => {
			socket.close();
			reject(new Error(`Timed out waiting for ${websocketUrl}`));
		}, 5_000);
		socket.addEventListener('open', () => socket.send(message));
		socket.addEventListener('message', (event) => {
			clearTimeout(timeout);
			socket.close();
			resolve(JSON.parse(String(event.data)) as { count: number; message: string });
		});
		socket.addEventListener('error', () => {
			clearTimeout(timeout);
			reject(new Error(`WebSocket failed for ${websocketUrl}`));
		});
	});
}

async function openVersionedSocket(url: string, expected: Record<string, string>) {
	const websocketUrl = new URL(url);
	websocketUrl.protocol = 'ws:';
	const deadline = Date.now() + 30_000;

	while (Date.now() < deadline) {
		const socket = new WebSocket(websocketUrl);
		const messages = webSocketMessageQueue(socket);
		await waitForWebSocketOpen(socket);
		const greeting = await messages.next();
		if (Object.entries(expected).every(([name, value]) => greeting[name] === value)) {
			return { socket, messages };
		}
		socket.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(
		`Timed out waiting for Worker state ${JSON.stringify(expected)} at ${websocketUrl}`
	);
}

function webSocketMessageQueue(socket: WebSocket) {
	const values: Record<string, unknown>[] = [];
	const waiters: Array<(value: Record<string, unknown>) => void> = [];
	socket.addEventListener('message', (event) => {
		const value = JSON.parse(String(event.data)) as Record<string, unknown>;
		const waiter = waiters.shift();
		if (waiter) waiter(value);
		else values.push(value);
	});
	return {
		next() {
			const value = values.shift();
			if (value) return Promise.resolve(value);
			return new Promise<Record<string, unknown>>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Timed out waiting for WebSocket message')),
					5_000
				);
				waiters.push((message) => {
					clearTimeout(timeout);
					resolve(message);
				});
			});
		}
	};
}

function waitForWebSocketOpen(socket: WebSocket) {
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Timed out opening WebSocket')), 5_000);
		socket.addEventListener(
			'open',
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true }
		);
		socket.addEventListener(
			'error',
			() => {
				clearTimeout(timeout);
				reject(new Error('WebSocket failed before opening'));
			},
			{ once: true }
		);
	});
}

function exchangeTcp(port: number, message: string, expected: string) {
	return new Promise<string>((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1');
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			const response = Buffer.concat(chunks).toString();
			socket.destroy();
			if (error) reject(new Error(`${error.message}; received ${JSON.stringify(response)}`));
			else resolve(response);
		};
		const timeout = setTimeout(() => {
			finish(new Error(`Timed out waiting for tcp://127.0.0.1:${port}`));
		}, 5_000);
		socket.once('connect', () => socket.write(message));
		socket.on('data', (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			if (Buffer.concat(chunks).toString() === expected) finish();
		});
		socket.once('end', () =>
			finish(new Error('TCP connection ended before the expected response'))
		);
		socket.once('error', finish);
	});
}

async function waitForTcpExchange(
	server: { getOutput(): string; hasExited(): boolean },
	port: number,
	message: string,
	expected: string
) {
	const deadline = Date.now() + 30_000;
	let lastError = 'TCP listener did not start';
	while (Date.now() < deadline) {
		if (server.hasExited()) throw new Error(`Dev server exited.\n${server.getOutput()}`);
		try {
			return await exchangeTcp(port, message, expected);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
	throw new Error(`${lastError}\n${server.getOutput()}`);
}

type WorkflowStatus = {
	status: string;
	output?: {
		source: string;
		count: number;
	};
};

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
	cleanupFixtures,
	createFixture,
	fetchJson,
	fetchOk,
	getAvailablePort,
	startDevServer,
	waitFor,
	waitForJson,
	webSocketRoundTrip,
	writeWorker
} from './fixture.js';

afterEach(cleanupFixtures);

describe('vite dev', () => {
	it('runs src/worker.ts in workerd in front of SvelteKit and shares its bindings', async () => {
		const root = await createFixture();
		const port = await getAvailablePort();
		const server = startDevServer(root, port);
		const base = `http://127.0.0.1:${port}`;

		await waitForJson<{ version: string }>(
			server,
			`${base}/api/version`,
			(body) => body.version === 'v1'
		);

		// Worker routes short-circuit, everything else falls through to SvelteKit.
		const home = await fetchOk(`${base}/`);
		await expect(home.text()).resolves.toContain('fixture home');
		const wrapped = await fetchOk(`${base}/wrapped`);
		expect(wrapped.headers.get('x-worker-after')).toBe('v1');
		expect(wrapped.status).toBe(200);

		// $lib, #lib, node:crypto and bare `crypto` resolve inside workerd.
		expect(await fetchJson(`${base}/api/modules`)).toEqual({
			message: 'hello from $lib',
			hash: 'f16d05ec',
			uuidLength: 36
		});

		// One SQLite Durable Object namespace for the Worker and SvelteKit (cloudflare:workers env).
		const name = crypto.randomUUID();
		const fromWorker = await fetchJson<{ count: number }>(`${base}/api/counter?name=${name}`);
		const fromKit = await fetchJson<{ count: number; source: string; greeting: string }>(
			`${base}/kit/counter?name=${name}`
		);
		expect(fromWorker.count).toBe(1);
		expect(fromKit).toEqual({ source: 'sveltekit', count: 2, greeting: 'hello from vars' });

		// WebSocket upgrades reach the Durable Object on the same origin.
		const reply = await webSocketRoundTrip(
			`ws://127.0.0.1:${port}/api/socket?name=${name}`,
			'ping'
		);
		expect(reply).toBe('v1:ping:3');

		// Queue producer -> consumer, scheduled handler, waitUntil.last.
		const job = crypto.randomUUID();
		await fetchOk(`${base}/api/enqueue?id=${job}`);
		await waitForJson<{ value: string | null }>(
			server,
			`${base}/kit/kv?key=queue:${job}`,
			(body) => body.value === 'processed',
			30_000
		);

		await fetchOk(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('*/5 * * * *')}`);
		await waitForJson<{ value: string | null }>(
			server,
			`${base}/kit/kv?key=scheduled-cron`,
			(body) => body.value === '*/5 * * * *'
		);

		await fetchOk(`${base}/api/wait-until-last`);
		await waitForJson<{ value: string | null }>(
			server,
			`${base}/kit/kv?key=wait-until-last`,
			(body) => body.value === 'first,last'
		);

		expect(server.getOutput()).not.toMatch(/error/i);
	});

	it('applies src/worker.ts edits with HMR and keeps Durable Object state', async () => {
		const root = await createFixture();
		const port = await getAvailablePort();
		const server = startDevServer(root, port);
		const base = `http://127.0.0.1:${port}`;
		await waitForJson<{ version: string }>(
			server,
			`${base}/api/version`,
			(body) => body.version === 'v1'
		);

		const name = crypto.randomUUID();
		expect((await fetchJson<{ count: number }>(`${base}/api/counter?name=${name}`)).count).toBe(1);

		await writeWorker(root, 'v2');
		await waitForJson<{ version: string }>(
			server,
			`${base}/api/version`,
			(body) => body.version === 'v2'
		);

		// The Durable Object picks up the new class and keeps its SQLite storage.
		const reply = await webSocketRoundTrip(
			`ws://127.0.0.1:${port}/api/socket?name=${name}`,
			'after-hmr'
		);
		expect(reply).toBe('v2:after-hmr:2');
		expect((await fetchJson<{ count: number }>(`${base}/kit/counter?name=${name}`)).count).toBe(3);

		// HMR, not a dev-server restart.
		expect(server.getOutput()).not.toContain('server restarted');
		expect(server.getOutput()).not.toContain('Worker exports changed');
	});

	it('reloads workerd when the Worker export shape changes', async () => {
		const root = await createFixture();
		const port = await getAvailablePort();
		const server = startDevServer(root, port);
		const base = `http://127.0.0.1:${port}`;
		await waitForJson<{ version: string }>(
			server,
			`${base}/api/version`,
			(body) => body.version === 'v1'
		);

		const name = crypto.randomUUID();
		await fetchJson(`${base}/api/counter?name=${name}`);

		const workerPath = `${root}/src/worker.ts`;
		const source = await readFile(workerPath, 'utf-8');
		await writeFile(
			workerPath,
			source
				.replace(
					"import { DurableObject } from 'cloudflare:workers';",
					"import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';"
				)
				.replace('export const VERSION = "v1";', 'export const VERSION = "v3";') +
				'\nexport class Extra extends WorkerEntrypoint {\n\tping() {\n\t\treturn "pong";\n\t}\n}\n'
		);

		await waitFor(server, async () => {
			if (!server.getOutput().includes('Worker exports changed')) throw new Error('not reloaded');
		});
		await waitForJson<{ version: string }>(
			server,
			`${base}/api/version`,
			(body) => body.version === 'v3'
		);
		expect((await fetchJson<{ count: number }>(`${base}/api/counter?name=${name}`)).count).toBe(2);
	});

	it('persists local state in .wrangler/state across dev-server restarts', async () => {
		const root = await createFixture();
		const name = crypto.randomUUID();

		const firstPort = await getAvailablePort();
		const first = startDevServer(root, firstPort);
		await waitForJson<{ count: number }>(
			first,
			`http://127.0.0.1:${firstPort}/api/counter?name=${name}`,
			(body) => body.count === 1
		);
		await first.stop();

		expect(existsSync(`${root}/.wrangler/state/v3`)).toBe(true);

		const secondPort = await getAvailablePort();
		const second = startDevServer(root, secondPort);
		const body = await waitForJson<{ count: number }>(
			second,
			`http://127.0.0.1:${secondPort}/kit/counter?name=${name}`,
			() => true
		);
		expect(body.count).toBe(2);
	});
});

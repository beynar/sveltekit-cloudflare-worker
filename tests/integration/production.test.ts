import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	buildFixture,
	cleanupFixtures,
	createFixture,
	fetchJson,
	fetchOk,
	expectEntrypoints,
	getAvailablePort,
	readFixtureFile,
	startWranglerDev,
	waitForJson,
	webSocketRoundTrip
} from './fixture.js';

afterEach(cleanupFixtures);

describe('vite build + wrangler dev', () => {
	it('composes one Worker with the SvelteKit app, handlers and Durable Object classes', async () => {
		const root = await createFixture();
		const build = await buildFixture(root);
		expect(build.code, build.output).toBe(0);

		const entry = await readFixtureFile(root, '.svelte-kit/cloudflare/_worker.js');
		expect(entry).toContain("export { Counter } from './_user-worker.js';");
		expect(entry).toMatch(/async queue\(/);
		expect(entry).toMatch(/async scheduled\(/);
		expect(entry).not.toContain('VERSION');
		const ignore = await readFixtureFile(root, '.svelte-kit/cloudflare/.assetsignore');
		expect(ignore).toContain('_user-worker.js');
		expect(ignore).toContain('_sveltekit-worker.js');
		expect(existsSync(path.join(root, '.svelte-kit/cloudflare/_sveltekit-worker.js'))).toBe(true);

		const port = await getAvailablePort();
		const server = startWranglerDev(root, port);
		const base = `http://127.0.0.1:${port}`;

		await waitForJson<{ version: string }>(
			server,
			`${base}/api/version`,
			(body) => body.version === 'v1'
		);
		await expect((await fetchOk(`${base}/`)).text()).resolves.toContain('fixture home');
		expect((await fetchOk(`${base}/wrapped`)).headers.get('x-worker-after')).toBe('v1');
		expect(await fetchJson(`${base}/api/modules`)).toEqual({
			message: 'hello from $lib',
			hash: 'f16d05ec',
			uuidLength: 36
		});

		const name = crypto.randomUUID();
		expect((await fetchJson<{ count: number }>(`${base}/api/counter?name=${name}`)).count).toBe(1);
		expect(
			await fetchJson<{ count: number; source: string }>(`${base}/kit/counter?name=${name}`)
		).toMatchObject({ source: 'sveltekit', count: 2 });
		expect(await webSocketRoundTrip(`ws://127.0.0.1:${port}/api/socket?name=${name}`, 'ping')).toBe(
			'v1:ping:3'
		);

		const job = crypto.randomUUID();
		await fetchOk(`${base}/api/enqueue?id=${job}`);
		await waitForJson<{ value: string | null }>(
			server,
			`${base}/kit/kv?key=queue:${job}`,
			(body) => body.value === 'processed',
			30_000
		);

		expect(await fetchJson(`${base}/kit/lazy`)).toEqual({ value: 'lazy:1' });
		await expectEntrypoints(server, base, 'v1');

		await fetchOk(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('*/5 * * * *')}`);
		await waitForJson<{ value: string | null }>(
			server,
			`${base}/kit/kv?key=scheduled-cron`,
			(body) => body.value === '*/5 * * * *'
		);

		// Internal modules are not served as static assets.
		const privateModule = await fetch(`${base}/_user-worker.js`);
		await expect(privateModule.text()).resolves.not.toContain('webSocketMessage');
	});
});

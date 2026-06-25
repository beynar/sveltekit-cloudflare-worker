import { afterEach, describe, expect, it } from 'vitest';
import {
	cleanupWorkerdSsrFixtures,
	createWorkerdSsrFixture,
	getAvailablePort,
	readJson,
	startDevServer,
	waitForJson,
	waitForResponse
} from './workerd-ssr-fixture.js';

afterEach(cleanupWorkerdSsrFixtures);

describe('workerd SSR dev mode', () => {
	it('serves SvelteKit SSR inside workerd with native Worker bindings', async () => {
		const root = await createWorkerdSsrFixture();
		const port = await getAvailablePort();
		const server = startDevServer(root, port);
		const baseUrl = `http://127.0.0.1:${port}`;

		const home = await waitForResponse(server, `${baseUrl}/`);
		const homeHtml = await home.text();
		expect(homeHtml).toContain('fixture home');
		expect(homeHtml).toContain('<style data-sveltekit>');
		expect(homeHtml).toContain('.layout-style-probe');
		expect(homeHtml).toContain('.page-style-probe');
		expect(homeHtml).toContain('.dynamic-style-probe');

		const workerCounter = await readJson<{ count: number }>(`${baseUrl}/api/do/increment`);
		expect(workerCounter.count).toBeGreaterThan(0);

		const svelteKitProbe = await readJson<{
			ok: boolean;
			count: number;
			keys: string[];
		}>(`${baseUrl}/__probe-sveltekit-bindings`);
		expect(svelteKitProbe.ok).toBe(true);
		expect(svelteKitProbe.count).toBeGreaterThan(0);
		expect(svelteKitProbe.keys).toContain('COUNTER_DO');
		expect(svelteKitProbe.keys).toContain('ASSETS');

		const remoteProbeResponse = await fetch(`${baseUrl}/__probe-remotes`);
		const remoteProbeText = await remoteProbeResponse.text();
		expect(remoteProbeResponse.status, `${remoteProbeText}\n${server.getOutput()}`).toBe(200);
		const remoteProbe = JSON.parse(remoteProbeText) as {
			status: number;
			body: { type: string; result?: string; error?: unknown };
		};
		expect(remoteProbe.status, `${remoteProbeText}\n${server.getOutput()}`).toBe(200);
		expect(remoteProbe.body.type, `${remoteProbeText}\n${server.getOutput()}`).toBe('result');
		expect(JSON.stringify(remoteProbe.body), `${remoteProbeText}\n${server.getOutput()}`).toContain(
			'available'
		);
		expect(JSON.stringify(remoteProbe.body), `${remoteProbeText}\n${server.getOutput()}`).toContain(
			'hasCounter'
		);

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
});

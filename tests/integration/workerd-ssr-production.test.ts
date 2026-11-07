import { afterEach, describe, expect, it } from 'vitest';
import {
	buildWorkerdSsrFixture,
	cleanupWorkerdSsrFixtures,
	createWorkerdSsrFixture,
	getAvailablePort,
	readJson,
	startPreviewServer,
	startWranglerServer,
	waitForJson,
	waitForResponse
} from './workerd-ssr-fixture.js';

afterEach(cleanupWorkerdSsrFixtures);

describe('workerd SSR production output', () => {
	it('starts the standard SvelteKit preview server', async () => {
		const root = await createWorkerdSsrFixture();
		await buildWorkerdSsrFixture(root);
		const port = await getAvailablePort();
		const server = startPreviewServer(root, port);
		const baseUrl = `http://127.0.0.1:${port}`;
		const home = await waitForResponse(server, `${baseUrl}/`);
		await expect(home.text()).resolves.toContain('fixture home');
		const bindingResponse = await fetch(`${baseUrl}/__probe-sveltekit-bindings`);
		expect(bindingResponse.status).toBe(500);
		expect(server.getOutput()).toContain(
			'Run Wrangler after a build to preview the composed Worker and Cloudflare bindings.'
		);
		expect(server.getOutput()).not.toContain('Cannot find the built worker entry');
	});

	it('prerenders with a production-only Wrangler binding', async () => {
		const root = await createWorkerdSsrFixture({
			prerenderHome: true,
			productionOnlyBinding: true
		});
		const buildOutput = await buildWorkerdSsrFixture(root);
		expect(buildOutput).toContain('Using sveltekit-cloudflare-worker');
		expect(buildOutput).not.toContain('Distilled local development does not yet support');
	});

	it('serves the built SvelteKit Worker with native bindings and handlers', async () => {
		const root = await createWorkerdSsrFixture();
		const buildOutput = await buildWorkerdSsrFixture(root);
		expect(buildOutput).not.toMatch(
			/(?:handleFetch|handleError|init) is not exported by .*application-hooks\.server/i
		);
		expect(buildOutput).not.toContain('Reading `config.kit` inside adapters is deprecated');
		const port = await getAvailablePort();
		const server = startWranglerServer(root, port);
		const baseUrl = `http://127.0.0.1:${port}`;

		const home = await waitForResponse(server, `${baseUrl}/`);
		await expect(home.text()).resolves.toContain('fixture home');

		const privateWorkerModule = await fetch(`${baseUrl}/_user-worker.js`);
		expect(privateWorkerModule.status).toBe(404);
		await expect(privateWorkerModule.text()).resolves.not.toContain('CounterDurableObject');

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

		const svelteKitCounter = await readJson<{ ok: boolean; count: number }>(
			`${baseUrl}/__probe-sveltekit-bindings`
		);
		expect(svelteKitCounter.ok).toBe(true);
		expect(svelteKitCounter.count).toBe(workerCounter.count + 1);

		const runtimeEnv = await readJson<{ sameEnv: boolean }>(`${baseUrl}/api/runtime-env`);
		expect(runtimeEnv.sameEnv).toBe(true);

		const chain = await readJson<{ before: number; kit: number; after: number }>(
			`${baseUrl}/__probe-middleware-chain?name=${crypto.randomUUID()}`
		);
		expect(chain).toEqual({ before: 1, kit: 2, after: 3 });

		const workerWorkflow = await readJson<{ id: string }>(`${baseUrl}/api/workflow/start`);
		const workerWorkflowStatus = await waitForJson<WorkflowStatus>(
			server,
			`${baseUrl}/api/workflow/status/${workerWorkflow.id}`,
			(body) => body.status === 'complete'
		);
		expect(workerWorkflowStatus.output?.source).toBe('worker');

		const svelteKitWorkflowResponse = await fetch(`${baseUrl}/__probe-workflow`, {
			method: 'POST',
			headers: { origin: baseUrl }
		});
		const svelteKitWorkflowText = await svelteKitWorkflowResponse.text();
		expect(svelteKitWorkflowResponse.status, svelteKitWorkflowText).toBe(200);
		const svelteKitWorkflow = JSON.parse(svelteKitWorkflowText) as { id: string };
		const svelteKitWorkflowStatus = await waitForJson<WorkflowStatus>(
			server,
			`${baseUrl}/__probe-workflow?id=${svelteKitWorkflow.id}`,
			(body) => body.status === 'complete'
		);
		expect(svelteKitWorkflowStatus.output?.source).toBe('sveltekit');

		const scheduledResponse = await fetch(
			`${baseUrl}/__scheduled?cron=${encodeURIComponent('* * * * *')}`
		);
		expect(scheduledResponse.status, await scheduledResponse.text()).toBe(200);
		const scheduledCount = await waitForJson<{ count: number }>(
			server,
			`${baseUrl}/api/scheduled/count`,
			(body) => body.count > 0
		);
		expect(scheduledCount.count).toBeGreaterThan(0);

		const output = server.getOutput();
		expect(output).not.toMatch(/no such Durable Object class is exported/i);
	});
});

type WorkflowStatus = {
	status: string;
	output?: {
		source: string;
		count: number;
	};
};

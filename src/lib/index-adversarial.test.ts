import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Builder } from '@sveltejs/kit';
import type { ViteDevServer } from 'vite';
import { cloudflareWorker } from './index.js';

const adapterCalls = vi.hoisted(() => [] as Array<{ config?: string }>);

vi.mock('@sveltejs/adapter-cloudflare', () => ({
	default: (options: { config?: string }) => {
		adapterCalls.push(options);
		return {
			name: '@sveltejs/adapter-cloudflare',
			adapt: async () => {},
			vite: { plugins: { pre: [], post: [] } }
		};
	}
}));

const temporaryRoots: string[] = [];

afterEach(async () => {
	adapterCalls.length = 0;
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('adversarial adapter boundaries', () => {
	it('keeps unsupported local-only bindings out of the production build path', async () => {
		const root = await createFixture({
			main: '.svelte-kit/cloudflare/_worker.js',
			compatibility_date: '2026-08-24',
			vectorize: [{ binding: 'VECTOR', index_name: 'documents' }]
		});
		const adapter = cloudflareWorker({}, { root, typesFile: false }).adapter;

		await expect(adapter.adapt({ config: {} } as Builder)).resolves.toBeUndefined();
		const emulator = await adapter.emulate?.();
		if (!emulator?.platform) throw new Error('Expected an adapter platform emulator.');
		const prerenderPlatform = await emulator.platform({ config: {}, prerender: true });
		expect(() => Reflect.get(prerenderPlatform.env, 'VECTOR')).toThrow(
			'Cannot access platform.env.VECTOR in a prerenderable route'
		);
		await expect(emulator.platform({ config: {}, prerender: false })).rejects.toThrow(
			'Distilled local development does not yet support these Wrangler bindings: Vectorize.'
		);

		const runtime = adapter.vite?.plugins?.pre?.find(
			(plugin) => plugin.name === 'sveltekit-cloudflare-worker:distilled-runtime'
		);
		expect(runtime).toBeDefined();
		await expect(runHook(runtime?.configureServer, {} as ViteDevServer)).rejects.toThrow(
			'Distilled local development does not yet support these Wrangler bindings: Vectorize.'
		);
	});

	it('requires an explicit adapter root when Vite uses a different project root', async () => {
		const root = await createFixture({
			main: '.svelte-kit/cloudflare/_worker.js',
			compatibility_date: '2026-08-24'
		});
		const otherRoot = path.join(root, 'nested-app');
		await mkdir(otherRoot, { recursive: true });
		const adapter = cloudflareWorker({}, { root, typesFile: false }).adapter;
		expect(adapterCalls.at(-1)?.config).toBe(path.join(root, 'wrangler.jsonc'));
		const entry = adapter.vite?.plugins?.pre?.find(
			(plugin) => plugin.name === 'sveltekit-cloudflare-worker:dev-entry'
		);

		await expect(
			runHook(entry?.config, { root: otherRoot }, { command: 'serve', mode: 'test' })
		).rejects.toThrow('Pass the same path as cloudflareWorker({}, { root })');
	});

	it('resolves internal asset exclusions from a nested Wrangler config', async () => {
		const root = await createFixture({
			main: '.svelte-kit/cloudflare/_worker.js',
			compatibility_date: '2026-08-24'
		});
		await mkdir(path.join(root, 'config'), { recursive: true });
		await writeFile(
			path.join(root, 'config/wrangler.jsonc'),
			JSON.stringify({
				main: '../public-output/nested/_worker.js',
				compatibility_date: '2026-08-24',
				assets: { directory: '../public-output', binding: 'ASSETS', run_worker_first: true }
			})
		);
		await mkdir(path.join(root, 'public-output/nested'), { recursive: true });
		await writeFile(
			path.join(root, 'public-output/nested/_worker.js'),
			'export default { fetch: () => new Response("kit") };\n'
		);
		await writeFile(path.join(root, 'public-output/.assetsignore'), 'nested/_worker.js\n');

		const adapter = cloudflareWorker(
			{},
			{ root, config: 'config/wrangler.jsonc', typesFile: false }
		).adapter;
		expect(adapterCalls.at(-1)?.config).toBe(path.join(root, 'config/wrangler.jsonc'));
		await adapter.adapt({ config: {} } as Builder);

		const ignore = await readFile(path.join(root, 'public-output/.assetsignore'), 'utf8');
		expect(ignore).toContain('nested/_sveltekit-worker.js');
		expect(ignore).toContain('nested/_user-worker.js');
	});
});

async function createFixture(config: Record<string, unknown>) {
	const root = await mkdtemp(path.join(tmpdir(), 'sveltekit-worker-adversarial-'));
	temporaryRoots.push(root);
	await mkdir(path.join(root, 'src'), { recursive: true });
	await mkdir(path.join(root, '.svelte-kit/cloudflare'), { recursive: true });
	await writeFile(path.join(root, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
	await writeFile(
		path.join(root, 'src/worker.ts'),
		'export const fetch = () => new Response("ok");'
	);
	await writeFile(
		path.join(root, '.svelte-kit/cloudflare/_worker.js'),
		'export default { fetch: () => new Response("kit") };\n'
	);
	return root;
}

type Hook<Arguments extends unknown[]> =
	| ((...args: Arguments) => unknown | Promise<unknown>)
	| { handler: (...args: Arguments) => unknown | Promise<unknown> };

async function runHook<Arguments extends unknown[]>(
	hook: Hook<Arguments> | undefined,
	...args: Arguments
) {
	if (!hook) throw new Error('Expected a Vite hook.');
	if (typeof hook === 'function') return hook(...args);
	return hook.handler(...args);
}

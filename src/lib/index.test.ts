import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { writeAppEnvTypes } from './binding-types.js';
import { composeBuildOutput } from './build-output.js';
import { cloudflareWorker, cloudflareWorkerAdapter } from './index.js';
import { __sveltekitCloudflareWorkerWaitUntilLast } from './wait-until-last.js';
import { bundleWorker, createWorkerFacade } from './worker-composition.js';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(files: Record<string, string>) {
	const root = await mkdtemp(path.join(tmpdir(), 'skcw-unit-'));
	roots.push(root);
	for (const [file, contents] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await writeFile(path.join(root, file), contents);
	}
	return root;
}

const WRANGLER = JSON.stringify({
	name: 'unit',
	main: '.svelte-kit/cloudflare/_worker.js',
	compatibility_date: '2026-10-01',
	assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' }
});

const ADAPTER_OUTPUT = `import { server } from './../cloudflare-tmp/server.js';
export default {
	async fetch(req, env) {
		return server.respond(req);
	}
};
`;

const WORKER = `import { DurableObject } from 'cloudflare:workers';
export const helper = 1;
export const fetch = async () => undefined;
export const queue = async () => {};
export const scheduled = async () => {};
export class Room extends DurableObject {}
`;

function plugins(adapter: ReturnType<typeof cloudflareWorkerAdapter>): Plugin[] {
	const vite = adapter.vite;
	if (!vite || typeof vite === 'function' || !vite.plugins || Array.isArray(vite.plugins)) {
		throw new Error('expected { plugins: { pre } }');
	}
	return vite.plugins.pre ?? [];
}

function applies(plugin: Plugin, command: 'serve' | 'build', isPreview = false) {
	const apply = plugin.apply;
	if (apply === undefined) return true;
	if (typeof apply === 'string') return apply === command;
	return apply({}, { command, mode: 'development', isPreview, isSsrBuild: false });
}

describe('cloudflareWorker()', () => {
	it('installs the adapter on the SvelteKit options and rejects a second adapter', async () => {
		const root = await project({ 'wrangler.jsonc': WRANGLER, 'src/worker.ts': WORKER });
		const config = cloudflareWorker({ appDir: '_app' }, { root });
		expect(config.appDir).toBe('_app');
		expect(config.adapter.name).toBe('sveltekit-cloudflare-worker');
		expect(() => cloudflareWorker({ adapter: config.adapter }, { root })).toThrow(
			/installs its own adapter/
		);
	});

	it('keeps adapter-cloudflare plugins for build and preview only, and its own runtime for dev', async () => {
		const root = await project({ 'wrangler.jsonc': WRANGLER, 'src/worker.ts': WORKER });
		const list = plugins(cloudflareWorkerAdapter({ root }));
		const adapterPlugin = list.find((plugin) => plugin.name.includes('adapter-cloudflare'));
		expect(adapterPlugin).toBeDefined();
		expect(applies(adapterPlugin!, 'build')).toBe(true);
		expect(applies(adapterPlugin!, 'serve', true)).toBe(true);
		expect(applies(adapterPlugin!, 'serve')).toBe(false);

		const devServer = list.find(
			(plugin) => plugin.name === 'sveltekit-cloudflare-worker:dev-server'
		);
		// Vitest's own Vite server does not boot workerd.
		expect(applies(devServer!, 'serve')).toBe(false);
		const vitest = process.env.VITEST;
		delete process.env.VITEST;
		try {
			expect(applies(devServer!, 'serve')).toBe(true);
		} finally {
			process.env.VITEST = vitest;
		}
		expect(applies(devServer!, 'serve', true)).toBe(false);
		expect(applies(devServer!, 'build')).toBe(false);
	});
});

describe('composeBuildOutput()', () => {
	it('composes the adapter Worker and src/worker.ts behind one entry', async () => {
		const root = await project({
			'wrangler.jsonc': WRANGLER,
			'src/worker.ts': WORKER,
			'.svelte-kit/cloudflare/_worker.js': ADAPTER_OUTPUT,
			'.svelte-kit/cloudflare/.assetsignore': '_worker.js\n'
		});
		const { exports } = await composeBuildOutput({
			root,
			workerFile: 'src/worker.ts',
			log: () => {}
		});
		expect(exports).toEqual({ handlers: ['fetch', 'queue', 'scheduled'], classes: ['Room'] });

		const output = path.join(root, '.svelte-kit/cloudflare');
		const entry = await readFile(path.join(output, '_worker.js'), 'utf-8');
		expect(entry).toContain("import worker_default from './_sveltekit-worker.js';");
		expect(entry).toContain("export { Room } from './_user-worker.js';");
		expect(entry).not.toContain('helper');
		expect(entry).toMatch(/async queue\(batch, env, ctx\)/);
		expect(await readFile(path.join(output, '_sveltekit-worker.js'), 'utf-8')).toBe(ADAPTER_OUTPUT);
		expect(await readFile(path.join(output, '.assetsignore'), 'utf-8')).toBe(
			'_worker.js\n_sveltekit-worker.js\n_user-worker.js\n'
		);
	});

	it('fails when adapter-cloudflare did not write the Wrangler entry', async () => {
		const root = await project({ 'wrangler.jsonc': WRANGLER, 'src/worker.ts': WORKER });
		await expect(
			composeBuildOutput({ root, workerFile: 'src/worker.ts', log: () => {} })
		).rejects.toThrow(/did not write the Worker entry/);
	});

	it('fails on an adapter output without a default fetch export', async () => {
		const root = await project({
			'wrangler.jsonc': WRANGLER,
			'src/worker.ts': WORKER,
			'.svelte-kit/cloudflare/_worker.js': 'export const worker = {};\n'
		});
		await expect(
			composeBuildOutput({ root, workerFile: 'src/worker.ts', log: () => {} })
		).rejects.toThrow(/no default export with a fetch handler/);
	});

	it('refuses to compose an entry twice', async () => {
		const root = await project({
			'wrangler.jsonc': WRANGLER,
			'src/worker.ts': WORKER,
			'.svelte-kit/cloudflare/_worker.js': createWorkerFacade({ handlers: ['fetch'], classes: [] })
		});
		await expect(
			composeBuildOutput({ root, workerFile: 'src/worker.ts', log: () => {} })
		).rejects.toThrow(/already a composed entry/);
	});
});

describe('bundleWorker()', () => {
	it('resolves Vite aliases, package.json #imports and Node built-ins like the application', async () => {
		const root = await project({
			'package.json': JSON.stringify({ imports: { '#lib/*': './src/lib/*' } }),
			'src/lib/a.ts': "export const a = 'a';\n",
			'src/lib/nested/index.ts': "export const nested = 'nested';\n",
			'src/shared/b.ts': "export const b = 'b';\n",
			'src/worker.ts': `import { a } from '#lib/a';
import { nested } from '#lib/nested';
import { b } from '$shared/b';
import { createHash } from 'crypto';
import { Buffer } from 'node:buffer';
export const fetch = () => Response.json([a, nested, b, typeof createHash, typeof Buffer]);
`
		});
		const { content, exports } = await bundleWorker(path.join(root, 'src/worker.ts'), {
			aliases: [{ find: '$shared', replacement: path.join(root, 'src/shared') }]
		});
		expect(exports.handlers).toEqual(['fetch']);
		expect(content).toContain('"nested"');
		expect(content).toContain('"b"');
		expect(content).toMatch(/from "node:crypto"/);
		expect(content).toMatch(/from "node:buffer"/);
	});
});

describe('ctx.waitUntil.last()', () => {
	it('starts the last task after the other waitUntil promises settle', async () => {
		const registered: Promise<unknown>[] = [];
		const ctx = { waitUntil: (promise: Promise<unknown>) => registered.push(promise) };
		const order: string[] = [];
		const wrapped = __sveltekitCloudflareWorkerWaitUntilLast(ctx);
		wrapped.ctx.waitUntil(
			new Promise((resolve) => setTimeout(resolve, 10)).then(() => order.push('a'))
		);
		wrapped.ctx.waitUntil.last(() => order.push('last'));
		wrapped.flush();
		await Promise.all(registered);
		expect(order).toEqual(['a', 'last']);
		expect(() => wrapped.ctx.waitUntil.last(() => {})).toThrow(/before the handler returns/);
	});
});

describe('writeAppEnvTypes()', () => {
	it('augments the global Cloudflare.Env with Wrangler bindings and Worker classes', async () => {
		const root = await project({
			'wrangler.jsonc': JSON.stringify({
				name: 'types',
				main: '.svelte-kit/cloudflare/_worker.js',
				compatibility_date: '2026-10-01',
				durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
				kv_namespaces: [{ binding: 'KV', id: 'x' }]
			}),
			'src/worker.ts': WORKER
		});
		await writeAppEnvTypes({
			root,
			workerFile: 'src/worker.ts',
			typesFile: 'src/app.d.ts',
			classExports: ['Room'],
			configPath: path.join(root, 'wrangler.jsonc'),
			log: () => {}
		});
		const types = await readFile(path.join(root, 'src/app.d.ts'), 'utf-8');
		expect(types).toContain('declare global {\n\tnamespace Cloudflare {');
		expect(types).toContain("ROOM: DurableObjectNamespace<import('./worker').Room>;");
		expect(types).toContain('KV: KVNamespace;');
		expect(types).not.toContain('App.Platform');
	});
});

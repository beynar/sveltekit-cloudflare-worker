import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeWorkerBundle } from './worker-composition.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('composeWorkerBundle', () => {
	it('does not expose ordinary named values as Worker entrypoints', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'sveltekit-worker-composition-'));
		temporaryRoots.push(root);
		const workerPath = path.join(root, 'worker.ts');
		await writeFile(
			workerPath,
			`export const helper = 42;
export function utility() { return helper; }
export class Counter {}`
		);

		const { bundle, exports } = await composeWorkerBundle(
			{
				files: [
					{
						path: 'server/index.js',
						content: 'export default { fetch: () => new Response("kit") };',
						hash: 'entry-hash'
					}
				],
				hash: 'original-hash'
			},
			workerPath
		);

		expect(exports).toEqual({ handlers: [], classes: ['Counter'] });
		expect(bundle.files[0].content).toContain('export { Counter }');
		expect(bundle.files[0].content).not.toContain('export { helper }');
		expect(bundle.files[0].content).not.toContain('export { utility }');
	});

	it('keeps the bundle entry first and adds middleware and class exports', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'sveltekit-worker-composition-'));
		temporaryRoots.push(root);
		const workerPath = path.join(root, 'worker.ts');
		await writeFile(
			workerPath,
			`export const fetch = async (request, env, ctx, next) => {
  if (new URL(request.url).pathname === '/worker') return new Response('worker');
  return next();
};
export const connect = async () => undefined;
export class Counter {}`
		);

		const originalEntry = 'export default { fetch: () => new Response("sveltekit") };';
		const originalChunk = 'export const shared = true;';
		const { bundle, exports } = await composeWorkerBundle(
			{
				files: [
					{ path: 'server/index.js', content: originalEntry, hash: 'entry-hash' },
					{ path: 'server/chunks/shared.js', content: originalChunk, hash: 'chunk-hash' }
				],
				hash: 'original-hash'
			},
			workerPath
		);

		expect(exports).toEqual({ handlers: ['connect', 'fetch'], classes: ['Counter'] });
		expect(bundle.hash).not.toBe('original-hash');
		expect(bundle.files.map((file) => file.path)).toEqual([
			'server/index.js',
			'server/_sveltekit-worker.js',
			'server/_user-worker.js',
			'server/chunks/shared.js'
		]);
		expect(bundle.files[0].content).toContain("export { Counter } from './_user-worker.js';");
		expect(bundle.files[0].content).toContain('async fetch(request, env, ctx)');
		expect(bundle.files[0].content).toContain('async connect(socket, env, ctx)');
		expect(bundle.files[1].content).toBe(originalEntry);
		expect(bundle.files[3].content).toBe(originalChunk);
	});

	it('resolves the standard SvelteKit alias and preserves node compatibility imports', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'sveltekit-worker-composition-'));
		temporaryRoots.push(root);
		await mkdir(path.join(root, '.svelte-kit'), { recursive: true });
		await mkdir(path.join(root, 'src/lib'), { recursive: true });
		await writeFile(
			path.join(root, '.svelte-kit/tsconfig.json'),
			JSON.stringify({ compilerOptions: { paths: { '$lib/*': ['../src/lib/*'] } } })
		);
		await writeFile(
			path.join(root, 'src/lib/value.ts'),
			"export const value = 'resolved-alias';\n"
		);
		const workerPath = path.join(root, 'src/worker.ts');
		await writeFile(
			workerPath,
			`import { Buffer } from 'node:buffer';
import { value } from '$lib/value';

export class Counter {
  static bytes = Buffer.from(value);
}`
		);

		const { bundle } = await composeWorkerBundle(
			{
				files: [{ path: 'index.js', content: 'export default { fetch() {} };', hash: 'entry' }],
				hash: 'bundle'
			},
			workerPath
		);

		expect(bundle.files[2].content).toContain('node:buffer');
		expect(bundle.files[2].content).toContain('resolved-alias');
	});
});

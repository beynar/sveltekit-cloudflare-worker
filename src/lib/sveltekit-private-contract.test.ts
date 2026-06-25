import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSvelteKitPrivateContract } from './sveltekit-private-contract.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('SvelteKit private contract', () => {
	it('accepts the installed SvelteKit dev manifest contract', () => {
		const require = createRequire(import.meta.url);
		const kitRoot = path.dirname(require.resolve('@sveltejs/kit/package.json'));

		expect(() => assertSvelteKitPrivateContract({ kitRoot })).not.toThrow();
	});

	it('fails loudly when SvelteKit private source moves', async () => {
		const kitRoot = await createFixture();

		expect(() => assertSvelteKitPrivateContract({ kitRoot })).toThrow(
			/Private SvelteKit contract changed in src\/exports\/vite\/dev\/index\.js: missing manifest refresh/
		);
	});
});

async function createFixture() {
	const root = await mkdtemp(path.join(tmpdir(), 'sveltekit-private-contract-'));
	temporaryRoots.push(root);
	const devDir = path.join(root, 'src/exports/vite/dev');
	await mkdir(devDir, { recursive: true });
	await writeFile(path.join(devDir, 'index.js'), 'export const changed = true;\n');
	return root;
}

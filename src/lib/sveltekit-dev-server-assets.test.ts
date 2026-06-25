import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSvelteKitDevServerAssets } from './sveltekit-dev-server-assets.js';
import { toFsPath } from './sveltekit-dev-ssr-strings.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('SvelteKit dev server assets', () => {
	it('maps source and static files to the keys SvelteKit read() can receive', async () => {
		const root = await createFixture();
		const sourceFile = path.join(root, 'src/lib/readable.txt');
		const staticFile = path.join(root, 'static/public.txt');

		const serverAssets = collectSvelteKitDevServerAssets({
			root,
			config: {
				kit: {
					files: {
						assets: path.join(root, 'static'),
						src: path.join(root, 'src')
					}
				}
			}
		});

		expect(serverAssets['src/lib/readable.txt']).toBe('source asset'.length);
		expect(serverAssets[toFsPath(sourceFile)]).toBe('source asset'.length);
		expect(serverAssets['public.txt']).toBe('static asset'.length);
		expect(serverAssets['static/public.txt']).toBe('static asset'.length);
		expect(serverAssets[toFsPath(staticFile)]).toBe('static asset'.length);
	});

	it('tolerates a missing static directory', async () => {
		const root = await createFixture({ staticDir: false });

		const serverAssets = collectSvelteKitDevServerAssets({
			root,
			config: {
				kit: {
					files: {
						assets: path.join(root, 'static'),
						src: path.join(root, 'src')
					}
				}
			}
		});

		expect(serverAssets['src/lib/readable.txt']).toBe('source asset'.length);
	});
});

async function createFixture({ staticDir = true }: { staticDir?: boolean } = {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'sveltekit-dev-server-assets-'));
	temporaryRoots.push(root);
	await mkdir(path.join(root, 'src/lib'), { recursive: true });
	await writeFile(path.join(root, 'src/lib/readable.txt'), 'source asset');

	if (staticDir) {
		await mkdir(path.join(root, 'static'), { recursive: true });
		await writeFile(path.join(root, 'static/public.txt'), 'static asset');
	}

	return root;
}

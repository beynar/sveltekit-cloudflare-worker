import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { collectSvelteKitDevRemotes } from './sveltekit-dev-remotes.js';
import { collectSvelteKitDevServerAssets } from './sveltekit-dev-server-assets.js';
import { buildSvelteKitDevSsrModule } from './sveltekit-dev-ssr-module.js';
import { loadSvelteKitInternals, withCwd } from './sveltekit-internals.js';

/**
 * @param {{
 *   root: string,
 *   outputDir: string,
 *   inlineStyleEndpoint: string,
 *   log: (...args: unknown[]) => void
 * }} options
 * @returns {Promise<{
 *   outputPath: string,
 *   manifestData: import('./sveltekit-dev-manifest.js').SvelteKitManifestData
 * }>}
 */
export async function writeSvelteKitDevSsr({ root, outputDir, inlineStyleEndpoint, log }) {
	const internals = await loadSvelteKitInternals({ root });

	const { config, cwd, manifestData } = await withCwd(root, async () => {
		const config = await internals.loadConfig();
		const { manifest_data: manifestData } = internals.sync.create(config);
		return { config, cwd: process.cwd(), manifestData };
	});

	const remotes = collectSvelteKitDevRemotes({
		root: cwd,
		config,
		hash: internals.hash
	});
	const serverAssets = collectSvelteKitDevServerAssets({
		root: cwd,
		config
	});
	const dir = path.resolve(root, outputDir);
	const outputPath = path.join(dir, '_sveltekit-dev-ssr.ts');
	const source = buildSvelteKitDevSsrModule({
		root,
		dir,
		kitRoot: internals.kitRoot,
		config,
		manifestData,
		remotes,
		serverAssets,
		inlineStyleEndpoint
	});

	mkdirSync(dir, { recursive: true });
	writeFileSync(outputPath, source);
	log(
		`Generated SvelteKit dev SSR entry at ${path.relative(
			root,
			outputPath
		)} with @sveltejs/kit ${internals.kitVersion}.`
	);

	return { outputPath, manifestData };
}

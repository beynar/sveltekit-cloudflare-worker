import { existsSync } from 'node:fs';
import path from 'node:path';
import { unstable_readConfig } from 'wrangler';

export const LOG_PREFIX = '[sveltekit-cloudflare-worker]';

/** @param {string} root */
export function findWranglerConfig(root) {
	return ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']
		.map((file) => path.resolve(root, file))
		.find((file) => existsSync(file));
}

/**
 * Wrangler's normalized config: every binding list is present, `main` is absolute.
 * @param {string | undefined} configPath
 * @param {string | undefined} environment
 * @returns {any}
 */
export function readWranglerConfig(configPath, environment) {
	return unstable_readConfig({ config: configPath, env: environment }, { hideWarnings: true });
}

/** @param {string} root @param {string} workerFile */
export function resolveWorkerFile(root, workerFile) {
	const workerPath = path.resolve(root, workerFile);
	if (!existsSync(workerPath)) {
		throw new Error(`${LOG_PREFIX} could not find the Worker entry at ${workerFile}.`);
	}
	return workerPath;
}

import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * @param {string} root
 * @param {(...args: unknown[]) => void} log
 * @param {string} [configFile]
 * @param {string} [environment]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readWranglerConfig(root, log, configFile, environment) {
	const configPath = configFile ? path.resolve(root, configFile) : findWranglerConfig(root);
	if (!configPath) return {};

	try {
		const { unstable_readConfig } = await import('wrangler');
		return unstable_readConfig({ config: configPath, env: environment }, { hideWarnings: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`Failed to read Wrangler config: ${message}`);
		throw error;
	}
}

/**
 * @param {string} root
 * @returns {string | null}
 */
export function findWranglerConfig(root) {
	for (const filename of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
		const configPath = path.resolve(root, filename);
		if (existsSync(configPath)) return configPath;
	}
	return null;
}

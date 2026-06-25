import { readdirSync } from 'node:fs';
import path from 'node:path';
import { toPosix } from './sveltekit-dev-ssr-strings.js';

/**
 * @typedef {{
 *   kit: {
 *     experimental: { remoteFunctions: boolean },
 *     files: { src: string },
 *     moduleExtensions: string[]
 *   }
 * }} SvelteKitConfig
 *
 * @typedef {{
 *   file: string,
 *   hash: string
 * }} SvelteKitRemote
 */

/**
 * @param {{
 *   root: string,
 *   config: SvelteKitConfig,
 *   hash: (value: string) => string
 * }} options
 * @returns {SvelteKitRemote[]}
 */
export function collectSvelteKitDevRemotes({ root, config, hash }) {
	if (!config.kit.experimental.remoteFunctions) return [];

	const remoteSuffixes = config.kit.moduleExtensions.map((extension) => `.remote${extension}`);
	const files = listRemoteFiles({
		dir: config.kit.files.src,
		remoteSuffixes
	});

	return files
		.map((absolutePath) => {
			const file = toPosix(path.relative(root, absolutePath));
			return {
				file,
				hash: hash(file)
			};
		})
		.sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * @param {{
 *   dir: string,
 *   remoteSuffixes: string[]
 * }} options
 * @returns {string[]}
 */
function listRemoteFiles({ dir, remoteSuffixes }) {
	const entries = readDirectory(dir);
	const files = [];

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listRemoteFiles({ dir: entryPath, remoteSuffixes }));
			continue;
		}

		if (entry.isFile() && remoteSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
			files.push(entryPath);
		}
	}

	return files;
}

/**
 * @param {string} dir
 */
function readDirectory(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not scan SvelteKit remote functions in ${dir}: ${message}`);
	}
}

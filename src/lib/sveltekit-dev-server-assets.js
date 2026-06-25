import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { toFsPath, toPosix } from './sveltekit-dev-ssr-strings.js';

/**
 * @typedef {{
 *   kit: {
 *     files: {
 *       assets: string,
 *       src: string
 *     }
 *   }
 * }} SvelteKitConfig
 */

/**
 * @param {{
 *   root: string,
 *   config: SvelteKitConfig
 * }} options
 * @returns {Record<string, number>}
 */
export function collectSvelteKitDevServerAssets({ root, config }) {
	/** @type {Record<string, number>} */
	const serverAssets = {};
	addSourceFiles({ root, dir: config.kit.files.src, serverAssets });
	addStaticAssetFiles({
		root,
		assetsDir: config.kit.files.assets,
		serverAssets
	});
	return Object.fromEntries(
		Object.entries(serverAssets).sort(([left], [right]) => left.localeCompare(right))
	);
}

/**
 * @param {{
 *   root: string,
 *   dir: string,
 *   serverAssets: Record<string, number>
 * }} options
 */
function addSourceFiles({ root, dir, serverAssets }) {
	for (const filePath of listFiles(dir)) {
		const size = getFileSize(filePath);
		const rootRelativePath = toPosix(path.relative(root, filePath));
		serverAssets[rootRelativePath] = size;
		serverAssets[toFsPath(filePath)] = size;
	}
}

/**
 * @param {{
 *   root: string,
 *   assetsDir: string,
 *   serverAssets: Record<string, number>
 * }} options
 */
function addStaticAssetFiles({ root, assetsDir, serverAssets }) {
	for (const filePath of listFiles(assetsDir)) {
		const size = getFileSize(filePath);
		const assetPath = toPosix(path.relative(assetsDir, filePath));
		serverAssets[assetPath] = size;
		serverAssets[toPosix(path.relative(root, filePath))] = size;
		serverAssets[toFsPath(filePath)] = size;
	}
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
	const entries = readDirectory(dir);
	const files = [];

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listFiles(entryPath));
			continue;
		}

		if (entry.isFile()) {
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
		if (isNotFoundError(error)) return [];
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not scan SvelteKit server assets in ${dir}: ${message}`);
	}
}

/**
 * @param {string} filePath
 */
function getFileSize(filePath) {
	try {
		return statSync(filePath).size;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read SvelteKit server asset metadata for ${filePath}: ${message}`);
	}
}

/**
 * @param {unknown} error
 */
function isNotFoundError(error) {
	return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

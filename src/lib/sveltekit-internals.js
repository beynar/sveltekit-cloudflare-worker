import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSvelteKitPrivateContract } from './sveltekit-private-contract.js';

const REQUIRED_SVELTEKIT_FILES = [
	'src/core/config/index.js',
	'src/core/sync/sync.js',
	'src/exports/vite/dev/index.js',
	'src/exports/vite/index.js',
	'src/runtime/server/remote.js',
	'src/utils/hash.js',
	'src/runtime/server/index.js',
	'src/runtime/shared-server.js'
];

/**
 * @param {{ root: string }} options
 */
export async function loadSvelteKitInternals({ root }) {
	const kitPackage = resolvePackage(root, '@sveltejs/kit');
	assertSupportedPackageVersion({
		name: '@sveltejs/kit',
		version: kitPackage.version,
		major: 2,
		minor: 67,
		feature: 'sveltekit-cloudflare-worker dev SSR'
	});
	assertPrivateFiles(kitPackage.root, REQUIRED_SVELTEKIT_FILES, '@sveltejs/kit');
	assertSvelteKitPrivateContract({ kitRoot: kitPackage.root });

	const configModule = await importPrivate(kitPackage.root, 'src/core/config/index.js');
	const sync = await importPrivate(kitPackage.root, 'src/core/sync/sync.js');
	const hashModule = await importPrivate(kitPackage.root, 'src/utils/hash.js');

	return {
		kitRoot: kitPackage.root,
		kitVersion: kitPackage.version,
		hash: hashModule.hash,
		loadConfig: configModule.load_config,
		sync
	};
}

/**
 * @param {{ root: string }} options
 */
export function assertWorkerdSsrSupport({ root }) {
	const cloudflarePlugin = resolvePackage(root, '@cloudflare/vite-plugin');
	assertSupportedPackageVersion({
		name: '@cloudflare/vite-plugin',
		version: cloudflarePlugin.version,
		major: 1,
		minor: 42,
		feature: 'sveltekit-cloudflare-worker dev SSR'
	});

	const vite = resolvePackage(root, 'vite');
	assertSupportedPackageVersion({
		name: 'vite',
		version: vite.version,
		major: 8,
		minor: 0,
		feature: 'sveltekit-cloudflare-worker dev SSR'
	});

	return { cloudflarePlugin, vite };
}

/**
 * @template T
 * @param {string} cwd
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withCwd(cwd, callback) {
	const previous = process.cwd();
	process.chdir(cwd);
	try {
		return await callback();
	} finally {
		process.chdir(previous);
	}
}

/**
 * @param {string} root
 * @param {string} packageName
 */
function resolvePackage(root, packageName) {
	const packageJsonPath = resolvePackageJsonPath(root, packageName);
	const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
	if (packageJson.name !== packageName) {
		throw new Error(
			`Expected ${packageJsonPath} to describe ${packageName}, got ${packageJson.name}.`
		);
	}

	return {
		root: path.dirname(packageJsonPath),
		version: String(packageJson.version)
	};
}

/**
 * @param {string} root
 * @param {string} packageName
 */
function resolvePackageJsonPath(root, packageName) {
	const directPath = path.join(root, 'node_modules', ...packageName.split('/'), 'package.json');
	if (existsSync(directPath)) return directPath;

	const appRequire = createRequire(path.join(root, 'package.json'));
	try {
		return appRequire.resolve(`${packageName}/package.json`);
	} catch (error) {
		if (!isPackageResolutionError(error)) throw error;
	}

	const packageRequire = createRequire(import.meta.url);
	try {
		return packageRequire.resolve(`${packageName}/package.json`);
	} catch (error) {
		if (!isPackageResolutionError(error)) throw error;
	}

	const localRoot = findNearestPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
	if (localRoot) {
		const localPath = path.join(
			localRoot,
			'node_modules',
			...packageName.split('/'),
			'package.json'
		);
		if (existsSync(localPath)) return localPath;
	}

	throw new Error(
		`sveltekit-cloudflare-worker dev SSR requires ${packageName}, but it could not be resolved from ${root}.`
	);
}

/**
 * @param {string} packageRoot
 * @param {string[]} files
 * @param {string} packageName
 */
function assertPrivateFiles(packageRoot, files, packageName) {
	const missing = files.filter((file) => !existsSync(path.join(packageRoot, file)));
	if (missing.length === 0) return;

	throw new Error(
		`sveltekit-cloudflare-worker dev SSR cannot run with this ${packageName} install. Missing private files: ${missing.join(
			', '
		)}. Update ${packageName}.`
	);
}

/**
 * @param {{
 *   name: string,
 *   version: string,
 *   major: number,
 *   minor: number,
 *   feature: string
 * }} options
 */
function assertSupportedPackageVersion({ name, version, major, minor, feature }) {
	const parsed = parseMajorMinor(version);
	if (!parsed || parsed.major !== major || parsed.minor < minor) {
		throw new Error(
			`${feature} requires ${name} >= ${major}.${minor}.0 < ${major + 1}.0.0. Found ${version}.`
		);
	}
}

/**
 * @param {string} version
 */
function parseMajorMinor(version) {
	const match = /^(\d+)\.(\d+)\./.exec(version);
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2])
	};
}

/**
 * @param {unknown} error
 */
function isPackageResolutionError(error) {
	if (!error || typeof error !== 'object' || !('code' in error)) return false;
	return error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
}

/**
 * @param {string} start
 */
function findNearestPackageRoot(start) {
	let current = start;
	while (true) {
		if (existsSync(path.join(current, 'package.json'))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * @param {string} packageRoot
 * @param {string} file
 */
function importPrivate(packageRoot, file) {
	return import(pathToFileURL(path.join(packageRoot, file)).href);
}

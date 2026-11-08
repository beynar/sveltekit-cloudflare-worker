import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import { LOG_PREFIX, readWranglerConfig } from './project.js';
import {
	SVELTEKIT_WORKER,
	USER_WORKER,
	bundleWorker,
	createWorkerFacade
} from './worker-composition.js';

/**
 * Compose adapter-cloudflare's `_worker.js` and the bundled `src/worker.ts` into one Worker
 * entry. An unexpected adapter output is a build error: skipping the composition would deploy a
 * Worker without the Durable Object classes and handlers.
 *
 * @param {{
 *   workerPath: string,
 *   configPath?: string,
 *   cloudflareEnv?: string,
 *   aliases?: readonly import('./worker-composition.js').Alias[],
 *   log?: (...args: unknown[]) => void
 * }} input
 */
export async function composeBuildOutput({
	workerPath,
	configPath,
	cloudflareEnv,
	aliases = [],
	log = () => {}
}) {
	const config = readWranglerConfig(configPath, cloudflareEnv);
	if (!config.main) {
		throw new Error(
			`${LOG_PREFIX} Wrangler "main" must point at adapter-cloudflare's output, for example ".svelte-kit/cloudflare/_worker.js".`
		);
	}
	const entry = path.resolve(config.main);
	if (!existsSync(entry)) {
		throw new Error(`${LOG_PREFIX} adapter-cloudflare did not write the Worker entry ${entry}.`);
	}
	const svelteKitWorker = readFileSync(entry, 'utf-8');
	if (!hasDefaultFetchExport(svelteKitWorker)) {
		throw new Error(
			`${LOG_PREFIX} ${entry} has no default export with a fetch handler. This adapter-cloudflare output is not supported.`
		);
	}

	const { content, exports, modules } = await bundleWorker(workerPath, { aliases });
	const directory = path.dirname(entry);
	writeFileSync(path.join(directory, USER_WORKER), content);
	for (const { name, file } of modules) copyFileSync(file, path.join(directory, name));
	writeFileSync(path.join(directory, SVELTEKIT_WORKER), svelteKitWorker);
	writeFileSync(entry, createWorkerFacade(exports));

	const assetsDirectory = path.resolve(path.dirname(config.configPath), config.assets.directory);
	ignoreInternalModules(
		assetsDirectory,
		directory,
		modules.map(({ name }) => name)
	);

	log(
		`Composed ${entry}: handlers=[${exports.handlers.join(', ')}] classes=[${exports.classes.join(', ')}]`
	);
	return { entry, exports };
}

/**
 * Check the contract the facade relies on, on the actual output rather than on generated text.
 * @param {string} source
 */
function hasDefaultFetchExport(source) {
	const { body } = /** @type {any} */ (
		parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
	);
	const hasDefault = body.some(
		(/** @type {any} */ node) =>
			node.type === 'ExportDefaultDeclaration' ||
			(node.type === 'ExportNamedDeclaration' &&
				node.specifiers.some(
					(/** @type {any} */ specifier) =>
						(specifier.exported.name ?? specifier.exported.value) === 'default'
				))
	);
	return hasDefault && /\bfetch\b/.test(source);
}

/**
 * The internal modules sit next to `_worker.js`, usually inside the assets directory: keep them
 * out of the public assets.
 * @param {string} assetsDirectory
 * @param {string} modulesDirectory
 * @param {string[]} extraModules
 */
function ignoreInternalModules(assetsDirectory, modulesDirectory, extraModules) {
	const relative = path.relative(assetsDirectory, modulesDirectory).split(path.sep).join('/');
	if (relative.startsWith('..')) return;
	const file = path.join(assetsDirectory, '.assetsignore');
	const current = existsSync(file) ? readFileSync(file, 'utf-8').trimEnd() : '';
	const entries = [SVELTEKIT_WORKER, USER_WORKER, ...extraModules].map((name) =>
		path.posix.join(relative, name)
	);
	writeFileSync(file, `${current}\n${entries.join('\n')}\n`.trimStart());
}

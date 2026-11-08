import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 *   lazySvelteKit?: boolean,
 *   splitting?: boolean,
 *   log?: (...args: unknown[]) => void
 * }} input
 */
export async function composeBuildOutput({
	workerPath,
	configPath,
	cloudflareEnv,
	aliases = [],
	lazySvelteKit = false,
	splitting = false,
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
	writeFileSync(entry, createWorkerFacade(exports, { lazySvelteKit }));
	if (splitting) await splitWorker(entry, config);

	const assetsDirectory = path.resolve(path.dirname(config.configPath), config.assets.directory);
	ignoreInternalModules(assetsDirectory, directory, [
		...modules.map(({ name }) => name),
		...(splitting ? [CHUNKS, `${CHUNKS}.map`, `${path.basename(entry)}.map`] : [])
	]);

	log(
		`Composed ${entry}: handlers=[${exports.handlers.join(', ')}] classes=[${exports.classes.join(', ')}]`
	);
	return { entry, exports };
}

const CHUNKS = '_chunk-*.js';

/**
 * Re-bundle the composed entry with code splitting: every `import()` (SvelteKit's routes, lazy
 * Durable Object implementations, and SvelteKit itself with `lazySvelteKit`) becomes its own
 * module, so a fresh isolate only evaluates what a request needs. Wrangler uploads the chunks as
 * modules only when a rule says so; the build fails with the rule to add otherwise.
 * @param {string} entry
 * @param {any} config
 */
async function splitWorker(entry, config) {
	const sample = CHUNKS.replace('*', '0123abcd');
	const covered = (config.rules ?? []).some(
		(/** @type {{ type: string, globs: string[] }} */ rule) =>
			rule.type === 'ESModule' && rule.globs.some((glob) => path.matchesGlob(sample, glob))
	);
	if (!covered) {
		throw new Error(
			`${LOG_PREFIX} splitting: true writes ${CHUNKS} modules next to the Worker. Add this rule to the Wrangler config so they are uploaded as modules:\n` +
				`"rules": [{ "type": "ESModule", "globs": ["${CHUNKS}"], "fallthrough": true }]`
		);
	}
	const directory = path.dirname(entry);
	const { build } = await import('esbuild');
	await build({
		entryPoints: { [path.basename(entry, '.js')]: entry },
		outdir: directory,
		allowOverwrite: true,
		bundle: true,
		splitting: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2024',
		conditions: ['workerd', 'worker'],
		external: ['cloudflare:*', 'node:*', '*.wasm'],
		chunkNames: CHUNKS.replace('*', '[hash]').replace(/\.js$/, ''),
		minify: config.minify === true,
		keepNames: config.keep_names !== false,
		sourcemap: config.upload_source_maps ? 'linked' : false,
		logLevel: 'warning'
	});
	// Both are now inside the entry or its chunks.
	rmSync(path.join(directory, SVELTEKIT_WORKER));
	rmSync(path.join(directory, USER_WORKER));
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

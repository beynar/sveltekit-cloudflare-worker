import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const KNOWN_HANDLERS = ['fetch', 'scheduled', 'queue', 'email', 'tail', 'trace', 'tailStream'];

/**
 * @param {import('./index.js').CloudflareWorkerOptions} [options]
 * @returns {Promise<import('vite').Plugin[]>}
 */
export async function cloudflareWorker(options = {}) {
	const workerFile = options.workerFile ?? 'src/worker.ts';
	const verbose = options.verbose ?? false;
	const log = verbose
		? (...args) => console.log('[sveltekit-cloudflare-worker]', ...args)
		: () => {};

	// Eagerly import @cloudflare/vite-plugin for dev mode.
	// The config customizer defers actual work until Vite resolves config.
	let devEntryPath = '';

	/** @type {import('vite').Plugin[]} */
	let cfPlugins = [];
	try {
		const { cloudflare } = await import('@cloudflare/vite-plugin');
		cfPlugins = cloudflare({
			config: (config) => {
				// devEntryPath is set by our devSetupPlugin's config hook before
				// the cloudflare plugin's config hook runs (plugin order matters)
				if (devEntryPath) {
					config.main = devEntryPath;
				}
				if (!config.assets) {
					config.assets = { binding: 'ASSETS', run_worker_first: true };
				} else {
					if (!config.assets.binding) config.assets.binding = 'ASSETS';
					config.assets.run_worker_first = true;
				}
				// Deduplicate compatibility_flags to avoid workerd "specified multiple times" error
				if (config.compatibility_flags) {
					config.compatibility_flags = [...new Set(config.compatibility_flags)];
				}
				// Don't return config — mutate in place only.
				// Returning it causes defu() to merge the object with itself,
				// duplicating arrays like migrations.
			}
		});
		// Filter cloudflare plugins to only run in dev
		cfPlugins = cfPlugins.map((p) => ({ ...p, apply: 'serve' }));
	} catch (e) {
		const isNotFound = e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND';
		if (!isNotFound) throw e;
		// @cloudflare/vite-plugin not installed — dev mode without workerd
	}

	// Plugin that generates the dev entry file early in the config phase
	/** @type {import('vite').Plugin} */
	const devSetupPlugin = {
		name: 'sveltekit-cloudflare-worker:dev-setup',
		apply: 'serve',
		// Use enforce: 'pre' to run our config hook before cloudflare's
		enforce: 'pre',
		async config(userConfig) {
			const root = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
			const workerPath = path.resolve(root, workerFile);

			if (!existsSync(workerPath)) {
				return;
			}

			const exports = await detectExports(workerPath);
			devEntryPath = generateDevEntry(root, workerFile, exports, log);
		}
	};

	return [devSetupPlugin, ...cfPlugins, buildPlugin(workerFile, log)];
}

/**
 * Build-mode plugin: patches _worker.js after adapter-cloudflare generates it.
 * @param {string} workerFile
 * @param {(...args: any[]) => void} log
 * @returns {import('vite').Plugin}
 */
function buildPlugin(workerFile, log) {
	/** @type {string} */
	let root;

	return {
		name: 'sveltekit-cloudflare-worker:build',
		apply: 'build',

		configResolved(config) {
			root = config.root;
		},

		closeBundle: {
			sequential: true,
			order: 'post',
			async handler() {
				const workerPath = path.resolve(root, workerFile);
				if (!existsSync(workerPath)) {
					return;
				}

				const workerDest = await findWorkerDest(root, log);
				if (!existsSync(workerDest)) {
					return;
				}

				// Check if already patched (avoid double-patching across multiple Vite builds)
				const workerContent = readFileSync(workerDest, 'utf-8');
				const exportPattern = /export\s*\{\s*worker_default\s+as\s+default\s*\}\s*;?\s*$/;
				if (!exportPattern.test(workerContent)) {
					return;
				}

				// Bundle user worker and detect exports in one esbuild pass
				const workerDestDir = path.dirname(workerDest);
				const userWorkerDest = path.join(workerDestDir, '_user-worker.js');

				const { build } = await import('esbuild');
				const result = await build({
					entryPoints: [workerPath],
					write: false,
					metafile: true,
					format: 'esm',
					platform: 'browser',
					bundle: true,
					external: ['cloudflare:*'],
					conditions: ['workerd'],
					logLevel: 'warning'
				});

				const outputKey = Object.keys(result.metafile.outputs)[0];
				const exports = classifyExports(result.metafile.outputs[outputKey].exports);

				if (exports.classes.length === 0 && exports.handlers.length === 0) {
					log('No exports found in worker file, skipping.');
					return;
				}

				// Write the bundled user worker
				writeFileSync(userWorkerDest, result.outputFiles[0].text);

				// Patch _worker.js
				const importLine = `import * as __userWorker from './_user-worker.js';\n`;
				const exportBlock = buildExportBlock(exports);
				const patched = importLine + workerContent.replace(exportPattern, exportBlock);

				writeFileSync(workerDest, patched);

				log(
					`Patched ${path.basename(workerDest)} with:` +
						(exports.handlers.length ? ` handlers=[${exports.handlers.join(', ')}]` : '') +
						(exports.classes.length ? ` classes=[${exports.classes.join(', ')}]` : '')
				);
			}
		}
	};
}

/**
 * Generate the dev entry file that re-exports DOs/Workflows from user's worker
 * and wraps fetch to fall through to SvelteKit via env.ASSETS.
 * @param {string} root
 * @param {string} workerFile
 * @param {{ handlers: string[], classes: string[] }} exports
 * @param {(...args: any[]) => void} log
 * @returns {string} Absolute path to the generated entry file
 */
function generateDevEntry(root, workerFile, exports, log) {
	const dir = path.resolve(root, '.svelte-kit/cloudflare-worker');
	mkdirSync(dir, { recursive: true });

	const entryPath = path.join(dir, '_dev-entry.ts');

	// Build the relative import path from the generated entry to the user's worker
	const workerAbsolute = path.resolve(root, workerFile);
	let importPath = path.relative(dir, workerAbsolute);
	if (!importPath.startsWith('.')) {
		importPath = './' + importPath;
	}
	// Remove .ts extension for the import (Vite handles resolution)
	importPath = importPath.replace(/\.ts$/, '');
	// Escape special characters for safe string interpolation in generated code
	const safeImportPath = importPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

	const lines = [];

	// Import all from user's worker
	lines.push(`import * as __userWorker from '${safeImportPath}';`);
	lines.push('');

	// Re-export classes (DOs, Workflows, WorkerEntrypoints)
	for (const cls of exports.classes) {
		lines.push(`export { ${cls} } from '${safeImportPath}';`);
	}

	if (exports.classes.length > 0) {
		lines.push('');
	}

	// Default export with all handlers
	const hasFetch = exports.handlers.includes('fetch');
	const otherHandlers = exports.handlers.filter((h) => h !== 'fetch');

	const defaultEntries = [];

	if (hasFetch) {
		defaultEntries.push(
			`  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {\n` +
				`    let _nextResponse: Promise<Response> | undefined;\n` +
				`    const next = () => { _nextResponse = env.ASSETS.fetch(request); return _nextResponse; };\n` +
				`    const response = await __userWorker.fetch(request, env, ctx, next);\n` +
				`    if (response) return response;\n` +
				`    return _nextResponse ?? next();\n` +
				`  }`
		);
	} else {
		defaultEntries.push(
			`  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {\n` +
				`    return env.ASSETS.fetch(request);\n` +
				`  }`
		);
	}

	for (const handler of otherHandlers) {
		defaultEntries.push(`  ${handler}: __userWorker.${handler}`);
	}

	lines.push(`export default {`);
	lines.push(defaultEntries.join(',\n'));
	lines.push(`};`);

	lines.push('');

	writeFileSync(entryPath, lines.join('\n'));
	log(`Generated dev entry at ${path.relative(root, entryPath)}`);

	return entryPath;
}

/**
 * Reads the wrangler config, adds script_name to DO bindings to suppress
 * workerd warnings, writes it to a temp file, and returns the temp path.
 *
 * @param {string} [configPath]
 * @returns {Promise<string>}
 */
export async function proxyConfig(configPath) {
	const { unstable_readConfig } = await import('wrangler');
	const config = unstable_readConfig({ config: configPath }, { hideWarnings: true });

	const excludedFields = new Set([
		'configPath',
		'userConfigPath',
		'topLevelName',
		'definedEnvironments',
		'targetEnvironment',
		'unsafe'
	]);
	const rawConfig = Object.fromEntries(
		Object.entries(config).filter(([key]) => !excludedFields.has(key))
	);

	if (rawConfig.durable_objects?.bindings) {
		for (const binding of rawConfig.durable_objects.bindings) {
			binding.script_name = 'self';
		}
	}

	const dir = path.resolve('.svelte-kit/cloudflare-worker');
	mkdirSync(dir, { recursive: true });
	const outPath = path.join(dir, 'wrangler.proxy.json');
	writeFileSync(outPath, JSON.stringify(rawConfig, null, '\t'));

	return outPath;
}

// --- Shared utilities ---

/**
 * Detect exports from the user's worker file using esbuild's metafile.
 * @param {string} workerPath
 * @returns {Promise<{ handlers: string[], classes: string[] }>}
 */
async function detectExports(workerPath) {
	const { build } = await import('esbuild');
	const result = await build({
		entryPoints: [workerPath],
		write: false,
		metafile: true,
		bundle: true,
		format: 'esm',
		platform: 'browser',
		external: ['cloudflare:*'],
		conditions: ['workerd'],
		logLevel: 'silent'
	});

	const outputKey = Object.keys(result.metafile.outputs)[0];
	return classifyExports(result.metafile.outputs[outputKey].exports);
}

/**
 * Classify export names into handlers and classes.
 * @param {string[]} exportNames
 * @returns {{ handlers: string[], classes: string[] }}
 */
function classifyExports(exportNames) {
	const handlers = [];
	const classes = [];

	for (const name of exportNames) {
		if (name === 'default') continue;
		if (KNOWN_HANDLERS.includes(name)) {
			handlers.push(name);
		} else {
			classes.push(name);
		}
	}

	return { handlers, classes };
}

/**
 * Build the replacement export block for build mode patching.
 * @param {{ handlers: string[], classes: string[] }} exports
 * @returns {string}
 */
function buildExportBlock(exports) {
	const lines = [];

	for (const cls of exports.classes) {
		lines.push(`export { ${cls} } from './_user-worker.js';`);
	}

	const hasFetch = exports.handlers.includes('fetch');
	const otherHandlers = exports.handlers.filter((h) => h !== 'fetch');

	const defaultEntries = [];

	if (hasFetch) {
		defaultEntries.push(
			`  async fetch(req, env, ctx) {\n` +
				`    let _nextResponse;\n` +
				`    const next = () => { _nextResponse = worker_default.fetch(req, env, ctx); return _nextResponse; };\n` +
				`    const res = await __userWorker.fetch(req, env, ctx, next);\n` +
				`    if (res) return res;\n` +
				`    return _nextResponse ?? next();\n` +
				`  }`
		);
	} else {
		defaultEntries.push(`  fetch: worker_default.fetch`);
	}

	for (const handler of otherHandlers) {
		defaultEntries.push(`  ${handler}: __userWorker.${handler}`);
	}

	lines.push(`export default {\n${defaultEntries.join(',\n')}\n};`);

	return lines.join('\n') + '\n';
}

/**
 * Find the generated _worker.js path by reading wrangler config.
 * Uses wrangler's own config parser to handle JSONC, JSON, and TOML.
 * @param {string} root
 * @param {(...args: any[]) => void} log
 * @returns {Promise<string>}
 */
async function findWorkerDest(root, log) {
	try {
		const { unstable_readConfig } = await import('wrangler');
		const config = unstable_readConfig({}, { hideWarnings: true });
		if (config.main) {
			return path.resolve(root, config.main);
		}
	} catch (e) {
		log(`Warning: Failed to read wrangler config: ${e.message}`);
	}

	return path.resolve(root, '.svelte-kit/cloudflare/_worker.js');
}

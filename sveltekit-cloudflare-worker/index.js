import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const KNOWN_HANDLERS = ['fetch', 'scheduled', 'queue', 'email', 'tail', 'trace'];

/**
 * @param {import('./index.js').CloudflareWorkerOptions} [options]
 * @returns {Promise<import('vite').Plugin[]>}
 */
export async function cloudflareWorker(options = {}) {
	const workerFile = options.workerFile ?? 'src/worker.ts';

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
				// Strip script_name from DO bindings so the vite plugin treats them
				// as local (handled by the wrapper module). Without this, users who
				// add script_name to suppress wrangler warnings get "Couldn't find
				// the durable Object" errors from the vite plugin.
				if (config.durable_objects?.bindings) {
					for (const binding of config.durable_objects.bindings) {
						delete binding.script_name;
					}
				}
				// Don't return config — mutate in place only.
				// Returning it causes defu() to merge the object with itself,
				// duplicating arrays like migrations.
			}
		});
		// Filter cloudflare plugins to only run in dev
		cfPlugins = cfPlugins.map((p) => ({ ...p, apply: 'serve' }));
	} catch {
		// @cloudflare/vite-plugin not installed — dev mode without workerd
	}

	// Plugin that generates the dev entry file early in the config phase
	/** @type {import('vite').Plugin} */
	const devSetupPlugin = {
		name: 'sveltekit-cloudflare-worker:dev-setup',
		apply: 'serve',
		// Use enforce: 'pre' to run our config hook before cloudflare's
		enforce: 'pre',
		config(userConfig) {
			const root = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
			const workerPath = path.resolve(root, workerFile);

			if (!existsSync(workerPath)) {
				return;
			}

			const source = readFileSync(workerPath, 'utf-8');
			const exports = parseExports(source);
			devEntryPath = generateDevEntry(root, workerFile, exports);
		}
	};

	return [devSetupPlugin, ...cfPlugins, buildPlugin(workerFile)];
}

/**
 * Build-mode plugin: patches _worker.js after adapter-cloudflare generates it.
 * @param {string} workerFile
 * @returns {import('vite').Plugin}
 */
function buildPlugin(workerFile) {
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

				const workerDest = findWorkerDest(root);
				if (!existsSync(workerDest)) {
					return;
				}

				// Check if already patched (avoid double-patching across multiple Vite builds)
				const workerContent = readFileSync(workerDest, 'utf-8');
				const exportPattern = /export\s*\{\s*worker_default\s+as\s+default\s*\}\s*;?\s*$/;
				if (!exportPattern.test(workerContent)) {
					return;
				}

				const source = readFileSync(workerPath, 'utf-8');
				const exports = parseExports(source);

				if (exports.classes.length === 0 && exports.handlers.length === 0) {
					console.log('[sveltekit-cloudflare-worker] No exports found in worker file, skipping.');
					return;
				}

				// Bundle user worker
				const workerDestDir = path.dirname(workerDest);
				const userWorkerDest = path.join(workerDestDir, '_user-worker.js');

				await build({
					entryPoints: [workerPath],
					outfile: userWorkerDest,
					format: 'esm',
					platform: 'browser',
					bundle: true,
					external: ['cloudflare:*'],
					conditions: ['workerd'],
					logLevel: 'warning'
				});

				// Patch _worker.js
				const importLine = `import * as __userWorker from './_user-worker.js';\n`;
				const exportBlock = buildExportBlock(exports);
				const patched = importLine + workerContent.replace(exportPattern, exportBlock);

				writeFileSync(workerDest, patched);

				console.log(
					`[sveltekit-cloudflare-worker] Patched ${path.basename(workerDest)} with:` +
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
 * @returns {string} Absolute path to the generated entry file
 */
function generateDevEntry(root, workerFile, exports) {
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

	const lines = [];

	// Import all from user's worker
	lines.push(`import * as __userWorker from '${importPath}';`);
	lines.push('');

	// Re-export classes (DOs, Workflows, WorkerEntrypoints)
	for (const cls of exports.classes) {
		lines.push(`export { ${cls} } from '${importPath}';`);
	}

	if (exports.classes.length > 0) {
		lines.push('');
	}

	// Re-export non-fetch handlers directly
	const otherHandlers = exports.handlers.filter((h) => h !== 'fetch');
	for (const handler of otherHandlers) {
		lines.push(`export { ${handler} } from '${importPath}';`);
	}

	if (otherHandlers.length > 0) {
		lines.push('');
	}

	// Default export with fetch wrapper
	const hasFetch = exports.handlers.includes('fetch');

	if (hasFetch) {
		lines.push(`export default {`);
		lines.push(
			`  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {`
		);
		lines.push(`    const response = await __userWorker.fetch(request, env, ctx);`);
		lines.push(`    if (response) return response;`);
		lines.push(`    // Fall through to SvelteKit via the ASSETS binding`);
		lines.push(`    return env.ASSETS.fetch(request);`);
		lines.push(`  }`);
		lines.push(`};`);
	} else {
		lines.push(`export default {`);
		lines.push(
			`  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {`
		);
		lines.push(`    return env.ASSETS.fetch(request);`);
		lines.push(`  }`);
		lines.push(`};`);
	}

	lines.push('');

	writeFileSync(entryPath, lines.join('\n'));
	console.log(
		`[sveltekit-cloudflare-worker] Generated dev entry at ${path.relative(root, entryPath)}`
	);

	return entryPath;
}

// --- Shared utilities ---

/**
 * Parse exports from the user's worker source file.
 * @param {string} source
 * @returns {{ handlers: string[], classes: string[] }}
 */
function parseExports(source) {
	const handlers = [];
	const classes = [];

	const classRegex = /export\s+class\s+(\w+)/g;
	let match;
	while ((match = classRegex.exec(source)) !== null) {
		classes.push(match[1]);
	}

	const fnRegex = /export\s+(?:const|let|var|(?:async\s+)?function)\s+(\w+)/g;
	while ((match = fnRegex.exec(source)) !== null) {
		const name = match[1];
		if (KNOWN_HANDLERS.includes(name)) {
			handlers.push(name);
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
				`    const res = await __userWorker.fetch(req, env, ctx);\n` +
				`    if (res) return res;\n` +
				`    return worker_default.fetch(req, env, ctx);\n` +
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
 * @param {string} root
 * @returns {string}
 */
function findWorkerDest(root) {
	const configPaths = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

	for (const configPath of configPaths) {
		const fullPath = path.resolve(root, configPath);
		if (!existsSync(fullPath)) continue;

		if (configPath.endsWith('.toml')) {
			break;
		}

		try {
			const raw = readFileSync(fullPath, 'utf-8');
			const json = raw.replace(/^\s*\/\/.*$/gm, '');
			const config = JSON.parse(json);
			if (config.main) {
				return path.resolve(root, config.main);
			}
		} catch {
			// Fall through to default
		}
	}

	return path.resolve(root, '.svelte-kit/cloudflare/_worker.js');
}

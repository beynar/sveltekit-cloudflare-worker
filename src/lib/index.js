import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeAppEnvTypes } from './binding-types.js';
import {
	createInlineStylesMiddleware,
	INLINE_STYLES_ENDPOINT
} from './sveltekit-dev-inline-styles.js';
import { writeSvelteKitDevSsr } from './sveltekit-dev-ssr.js';
import { assertWorkerdSsrSupport } from './sveltekit-internals.js';

const KNOWN_HANDLERS = ['fetch', 'scheduled', 'queue', 'email', 'tail', 'trace', 'tailStream'];
const DEV_OUTPUT_DIR = '.svelte-kit/cloudflare-worker';
const DEV_ENTRY_FILE = '_dev-entry.ts';
const APP_SERVER_READ_MODULE = '\0sveltekit-cloudflare-worker/app-server-read';
const WAIT_UNTIL_LAST_HELPER = `function __sveltekitCloudflareWorkerWaitUntilLast(ctx) {
  if (!ctx || typeof ctx.waitUntil !== 'function') {
    return { ctx, flush() {} };
  }

  const waitUntil = ctx.waitUntil.bind(ctx);
  const pending = [];
  const last = [];
  let flushed = false;

  function wrappedWaitUntil(promise) {
    const tracked = Promise.resolve(promise);
    pending.push(tracked);
    waitUntil(tracked);
  }

  wrappedWaitUntil.last = (task) => {
    if (typeof task !== 'function') {
      throw new TypeError('ctx.waitUntil.last() expects a function so the work can start after other waitUntil promises.');
    }
    if (flushed) {
      throw new Error('ctx.waitUntil.last() must be called before the handler returns.');
    }
    last.push(task);
  };

  async function runLastTasks() {
    const results = await Promise.allSettled(last.map((task) => Promise.resolve().then(task)));
    const failures = results.filter((result) => result.status === 'rejected');

    if (failures.length === 1) {
      throw failures[0].reason;
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'ctx.waitUntil.last() callbacks failed.'
      );
    }
  }

  return {
    ctx: Object.assign(Object.create(ctx), { waitUntil: wrappedWaitUntil }),
    flush() {
      if (flushed || last.length === 0) return;
      flushed = true;
      waitUntil(Promise.allSettled(pending).then(runLastTasks));
    }
  };
}`;

/**
 * @param {import('./index.js').CloudflareWorkerOptions} [options]
 * @returns {Promise<import('vite').Plugin[]>}
 */
export async function cloudflareWorker(options = {}) {
	const workerFile = options.workerFile ?? 'src/worker.ts';
	const typesFile = options.typesFile === undefined ? 'src/app.d.ts' : options.typesFile;
	const verbose = options.verbose ?? false;
	const log = verbose
		? (...args) => console.log('[sveltekit-cloudflare-worker]', ...args)
		: () => {};

	const devEntryPath = path.resolve(process.cwd(), DEV_OUTPUT_DIR, DEV_ENTRY_FILE);

	/** @type {import('vite').Plugin[]} */
	let cfPlugins = [];
	try {
		const { cloudflare } = await import('@cloudflare/vite-plugin');
		cfPlugins = cloudflare({
			viteEnvironment: { name: 'ssr' },
			config: (config) => {
				config.main = devEntryPath;
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
		throw new Error(
			'sveltekit-cloudflare-worker requires @cloudflare/vite-plugin for local workerd dev. Install @cloudflare/vite-plugin.',
			{ cause: e }
		);
	}

	/** @type {import('vite').Plugin} */
	const workerdSsrConfigPlugin = {
		name: 'sveltekit-cloudflare-worker:workerd-ssr-config',
		apply: 'serve',
		config() {
			return {
				define: {
					__SVELTEKIT_SERVER_TRACING_ENABLED__: 'false'
				},
				environments: {
					ssr: {
						define: {
							__SVELTEKIT_SERVER_TRACING_ENABLED__: 'false'
						}
					}
				}
			};
		},
		configResolved(config) {
			const ssrEnvironment = config.environments?.ssr;
			if (!ssrEnvironment?.resolve) {
				throw new Error(
					'sveltekit-cloudflare-worker expected Vite to expose an ssr environment with resolve options.'
				);
			}
			ssrEnvironment.resolve.external = [];
		}
	};

	/** @type {import('vite').Plugin} */
	const typesPlugin = {
		name: 'sveltekit-cloudflare-worker:types',
		enforce: 'pre',
		async config(userConfig) {
			const root = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
			const workerPath = path.resolve(root, workerFile);
			const exports = existsSync(workerPath) ? await detectExports(workerPath) : { classes: [] };
			await writeAppEnvTypes({
				root,
				workerFile,
				typesFile,
				classExports: exports.classes,
				log
			});
		}
	};

	/** @type {import('./sveltekit-dev-manifest.js').SvelteKitManifestData | undefined} */
	let devManifestData;

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

			assertWorkerdSsrSupport({ root });

			const exports = await detectExports(workerPath);
			const { outputPath, manifestData } = await writeSvelteKitDevSsr({
				root,
				outputDir: DEV_OUTPUT_DIR,
				inlineStyleEndpoint: INLINE_STYLES_ENDPOINT,
				log
			});
			devManifestData = manifestData;
			generateDevEntry(root, workerFile, exports, log, outputPath);
		},
		configureServer(vite) {
			if (!devManifestData) return;
			vite.middlewares.use(
				createInlineStylesMiddleware({
					root: vite.config.root,
					vite,
					manifestData: devManifestData
				})
			);
		}
	};

	return [
		typesPlugin,
		remoteSsrSourcePlugin(),
		devSetupPlugin,
		workerdSsrConfigPlugin,
		...cfPlugins,
		buildPlugin(workerFile, log)
	];
}

/**
 * @returns {import('vite').Plugin}
 */
function remoteSsrSourcePlugin() {
	/** @type {string} */
	let root;

	return {
		name: 'sveltekit-cloudflare-worker:remote-ssr-source',
		apply: 'serve',
		enforce: 'pre',
		configResolved(config) {
			root = config.root;
		},
		resolveId(id, importer) {
			if (id === APP_SERVER_READ_MODULE) return id;
			if (id.includes('.skcw-remote.')) return id;
		},
		load(id) {
			if (id === APP_SERVER_READ_MODULE) {
				return buildAppServerReadModule();
			}

			const [pathname] = id.split('?');
			if (!pathname.includes('.skcw-remote.')) return;

			const sourcePath = path.resolve(
				root,
				pathname.replace(/^\//, '').replace('.skcw-remote.', '.remote.')
			);
			return readFileSync(sourcePath, 'utf-8');
		},
		transform(code, id) {
			if (!code.includes('$app/server')) return;
			if (!id.includes('.skcw-remote.') && !isAppSourceId(root, id)) return;
			return rewriteRemoteServerImports({ root, code });
		}
	};
}

function buildAppServerReadModule() {
	return `import { read_implementation, manifest } from '__sveltekit/server';
import { base } from '$app/paths/internal/server';

export function read(asset) {
\t__SVELTEKIT_TRACK__('$app/server:read');

\tif (!read_implementation) {
\t\tthrow new Error('No \`read\` implementation was provided. Please ensure that your adapter is up to date and supports this feature');
\t}

\tconst match = /^data:([^;,]+)?(;base64)?,/.exec(asset);
\tif (match) {
\t\tconst type = match[1] ?? 'application/octet-stream';
\t\tconst data = asset.slice(match[0].length);
\t\tif (match[2] !== undefined) {
\t\t\tconst binary = atob(data);
\t\t\tconst decoded = new Uint8Array(binary.length);
\t\t\tfor (let i = 0; i < binary.length; i += 1) decoded[i] = binary.charCodeAt(i);
\t\t\treturn new Response(decoded, {
\t\t\t\theaders: {
\t\t\t\t\t'Content-Length': decoded.byteLength.toString(),
\t\t\t\t\t'Content-Type': type
\t\t\t\t}
\t\t\t});
\t\t}

\t\tconst decoded = decodeURIComponent(data);
\t\treturn new Response(decoded, {
\t\t\theaders: {
\t\t\t\t'Content-Length': decoded.length.toString(),
\t\t\t\t'Content-Type': type
\t\t\t}
\t\t});
\t}

\tconst file = decodeURIComponent(__SVELTEKIT_DEV__ && asset.startsWith('/@fs') ? asset : asset.slice(base.length + 1));
\tif (file in manifest._.server_assets) {
\t\tconst length = manifest._.server_assets[file];
\t\tconst type = manifest.mimeTypes[file.slice(file.lastIndexOf('.'))];
\t\treturn new Response(read_implementation(file), {
\t\t\theaders: {
\t\t\t\t'Content-Length': '' + length,
\t\t\t\t'Content-Type': type
\t\t\t}
\t\t});
\t}

\tthrow new Error(\`Asset does not exist: \${file}\`);
}
`;
}

/**
 * @param {string} root
 * @param {string} id
 */
function isAppSourceId(root, id) {
	const [pathname] = id.split('?');
	const filePath = pathname.startsWith('/@fs') ? pathname.slice('/@fs'.length) : pathname;
	return path.isAbsolute(filePath)
		? filePath.startsWith(path.join(root, 'src') + path.sep)
		: filePath.startsWith('/src/');
}

/**
 * @param {{ root: string, code: string }} options
 */
function rewriteRemoteServerImports({ root, code }) {
	const serverRuntime = `/@fs${path.join(root, 'node_modules/@sveltejs/kit/src/runtime/app/server')}`;
	const internalServer = '@sveltejs/kit/internal/server';

	return code.replace(
		/import\s*{([^}]+)}\s*from\s*(['"])\$app\/server\2\s*;?/g,
		(_match, specifiers) => {
			const imports = parseNamedImports(specifiers);
			const lines = [];

			pushMappedImport(lines, imports, 'getRequestEvent', internalServer);
			pushMappedImport(lines, imports, 'query', `${serverRuntime}/remote/query.js`);
			pushMappedImport(lines, imports, 'command', `${serverRuntime}/remote/command.js`);
			pushMappedImport(lines, imports, 'form', `${serverRuntime}/remote/form.js`);
			pushMappedImport(lines, imports, 'prerender', `${serverRuntime}/remote/prerender.js`);
			pushMappedImport(lines, imports, 'requested', `${serverRuntime}/remote/requested.js`);
			pushMappedImport(lines, imports, 'read', APP_SERVER_READ_MODULE);

			if (lines.length !== imports.length) {
				const unsupported = imports
					.filter((imported) => !lines.some((line) => line.includes(` ${imported.local} `)))
					.map((imported) => imported.imported)
					.join(', ');
				throw new Error(`Unsupported $app/server remote import(s): ${unsupported}`);
			}

			return lines.join('\n');
		}
	);
}

/**
 * @param {string} specifiers
 */
function parseNamedImports(specifiers) {
	return specifiers
		.split(',')
		.map((specifier) => specifier.trim())
		.filter(Boolean)
		.map((specifier) => {
			const [imported, local = imported] = specifier.split(/\s+as\s+/);
			return {
				imported: imported.trim(),
				local: local.trim()
			};
		});
}

/**
 * @param {string[]} lines
 * @param {{ imported: string, local: string }[]} imports
 * @param {string} importedName
 * @param {string} moduleId
 */
function pushMappedImport(lines, imports, importedName, moduleId) {
	const match = imports.find((specifier) => specifier.imported === importedName);
	if (!match) return;

	const imported = match.local === importedName ? importedName : `${importedName} as ${match.local}`;
	lines.push(`import { ${imported} } from '${moduleId}';`);
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
 * and wraps fetch to fall through to SvelteKit inside workerd.
 * @param {string} root
 * @param {string} workerFile
 * @param {{ handlers: string[], classes: string[] }} exports
 * @param {(...args: any[]) => void} log
 * @param {string} svelteKitDevSsrPath
 * @returns {string} Absolute path to the generated entry file
 */
function generateDevEntry(root, workerFile, exports, log, svelteKitDevSsrPath) {
	const dir = path.resolve(root, '.svelte-kit/cloudflare-worker');
	mkdirSync(dir, { recursive: true });

	const entryPath = path.join(dir, DEV_ENTRY_FILE);

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
	lines.push(
		`import { respond as __sveltekitCloudflareWorkerRespond } from '${toSafeImportPath(
			dir,
			svelteKitDevSsrPath
		)}';`
	);
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
	const needsWaitUntilLast = hasFetch || otherHandlers.some((handler) => handler !== 'tailStream');

	const defaultEntries = [];

	if (hasFetch) {
		defaultEntries.push(
			`  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {\n` +
				`    const __waitUntilLast = __sveltekitCloudflareWorkerWaitUntilLast(ctx);\n` +
				`    try {\n` +
				`      let _nextResponse: Promise<Response> | undefined;\n` +
				`      const next = () => { _nextResponse = ${buildNextCall(
					'request',
					'env',
					'__waitUntilLast.ctx'
				)}; return _nextResponse; };\n` +
				`      const response = await __userWorker.fetch(request, env, __waitUntilLast.ctx, next);\n` +
				`      if (response) return response;\n` +
				`      return await (_nextResponse ?? next());\n` +
				`    } finally {\n` +
				`      __waitUntilLast.flush();\n` +
				`    }\n` +
				`  }`
		);
	} else {
		defaultEntries.push(
			`  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {\n` +
				`    return ${buildNextCall('request', 'env', 'ctx')};\n` +
				`  }`
		);
	}

	for (const handler of otherHandlers) {
		defaultEntries.push(buildDevHandlerEntry(handler));
	}

	if (needsWaitUntilLast) {
		lines.push(WAIT_UNTIL_LAST_HELPER);
		lines.push('');
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
 * @param {string} requestName
 * @param {string} envName
 * @param {string} ctxName
 */
function buildNextCall(requestName, envName, ctxName) {
	return `__sveltekitCloudflareWorkerRespond(${requestName}, ${envName}, ${ctxName})`;
}

/**
 * @param {string} from
 * @param {string} to
 */
function toSafeImportPath(from, to) {
	let importPath = path.relative(from, to);
	if (!importPath.startsWith('.')) {
		importPath = './' + importPath;
	}
	importPath = importPath.replace(/\.ts$/, '');
	return importPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
	const needsWaitUntilLast = hasFetch || otherHandlers.some((handler) => handler !== 'tailStream');

	const defaultEntries = [];

	if (hasFetch) {
		defaultEntries.push(
			`  async fetch(req, env, ctx) {\n` +
				`    const __waitUntilLast = __sveltekitCloudflareWorkerWaitUntilLast(ctx);\n` +
				`    try {\n` +
				`      let _nextResponse;\n` +
				`      const next = () => { _nextResponse = worker_default.fetch(req, env, __waitUntilLast.ctx); return _nextResponse; };\n` +
				`      const res = await __userWorker.fetch(req, env, __waitUntilLast.ctx, next);\n` +
				`      if (res) return res;\n` +
				`      return await (_nextResponse ?? next());\n` +
				`    } finally {\n` +
				`      __waitUntilLast.flush();\n` +
				`    }\n` +
				`  }`
		);
	} else {
		defaultEntries.push(`  fetch: worker_default.fetch`);
	}

	for (const handler of otherHandlers) {
		defaultEntries.push(buildHandlerEntry(handler));
	}

	if (needsWaitUntilLast) {
		lines.push(`${WAIT_UNTIL_LAST_HELPER}\n`);
	}
	lines.push(`export default {\n${defaultEntries.join(',\n')}\n};`);

	return lines.join('\n') + '\n';
}

/**
 * @param {string} handler
 * @returns {string}
 */
function buildHandlerEntry(handler) {
	if (handler === 'tailStream') {
		return `  tailStream: __userWorker.tailStream`;
	}

	const firstArg = {
		scheduled: 'controller',
		queue: 'batch',
		email: 'message',
		tail: 'events',
		trace: 'traces'
	}[handler];

	return (
		`  async ${handler}(${firstArg}, env, ctx) {\n` +
		`    const __waitUntilLast = __sveltekitCloudflareWorkerWaitUntilLast(ctx);\n` +
		`    try {\n` +
		`      return await __userWorker.${handler}(${firstArg}, env, __waitUntilLast.ctx);\n` +
		`    } finally {\n` +
		`      __waitUntilLast.flush();\n` +
		`    }\n` +
		`  }`
	);
}

/**
 * @param {string} handler
 * @returns {string}
 */
function buildDevHandlerEntry(handler) {
	if (handler === 'tailStream') {
		return `  tailStream: __userWorker.tailStream`;
	}

	const firstArg = {
		scheduled: 'controller',
		queue: 'batch',
		email: 'message',
		tail: 'events',
		trace: 'traces'
	}[handler];
	const firstType = {
		scheduled: 'ScheduledController',
		queue: 'MessageBatch',
		email: 'ForwardableEmailMessage',
		tail: 'TraceItem[]',
		trace: 'TraceItem[]'
	}[handler];

	return (
		`  async ${handler}(${firstArg}: ${firstType}, env: any, ctx: ExecutionContext) {\n` +
		`    const __waitUntilLast = __sveltekitCloudflareWorkerWaitUntilLast(ctx);\n` +
		`    try {\n` +
		`      return await __userWorker.${handler}(${firstArg}, env, __waitUntilLast.ctx);\n` +
		`    } finally {\n` +
		`      __waitUntilLast.flush();\n` +
		`    }\n` +
		`  }`
	);
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

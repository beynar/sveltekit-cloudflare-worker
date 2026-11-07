import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { writeAppEnvTypes } from './binding-types.js';
import { distilledDevRuntime } from './distilled-dev.js';
import { NODE_DEV_HOOK_BRIDGE, nodeDevIntegration } from './node-dev.js';
import {
	BUILD_ENTRY_MARKER,
	WAIT_UNTIL_LAST_HELPER,
	bundleWorker,
	createWorkerFacade,
	detectWorkerExports
} from './worker-composition.js';
import { findWranglerConfig, readWranglerConfig } from './wrangler-config.js';

const DEV_OUTPUT_DIR = '.svelte-kit/cloudflare-worker';
const DEV_ENTRY_FILE = '_dev-entry.ts';

/**
 * Add the Cloudflare Worker adapter and its server-hook bridge to a SvelteKit configuration.
 *
 * @param {import('@sveltejs/kit/vite').Config} [config]
 * @param {import('./index.js').CloudflareWorkerOptions} [options]
 * @returns {import('@sveltejs/kit/vite').Config}
 */
export function cloudflareWorker(config = {}, options = {}) {
	const sourceDirectory = config.files?.src ?? 'src';
	const userHooksFile = config.files?.hooks?.server ?? path.join(sourceDirectory, 'hooks.server');

	return {
		...config,
		adapter: createCloudflareWorkerAdapter(options, userHooksFile),
		files: {
			...config.files,
			hooks: {
				...config.files?.hooks,
				server: NODE_DEV_HOOK_BRIDGE
			}
		}
	};
}

/**
 * @param {import('./index.js').CloudflareWorkerOptions} options
 * @param {string} userHooksFile
 * @returns {import('@sveltejs/kit').Adapter}
 */
function createCloudflareWorkerAdapter(options, userHooksFile) {
	const workerFile = options.workerFile ?? 'src/worker.ts';
	const typesFile = options.typesFile === undefined ? 'src/app.d.ts' : options.typesFile;
	const runtimeRoot = path.resolve(options.root ?? process.cwd());
	const configPath = options.config
		? path.resolve(runtimeRoot, options.config)
		: (findWranglerConfig(runtimeRoot) ?? undefined);
	const connectPort = options.connectPort;
	if (
		connectPort !== undefined &&
		(!Number.isInteger(connectPort) || connectPort < 0 || connectPort > 65_535)
	) {
		throw new TypeError('connectPort must be an integer between 0 and 65535.');
	}
	const adapter = adapterCloudflare({
		config: configPath,
		fallback: options.fallback,
		routes: options.routes
	});
	/** @type {(...args: unknown[]) => void} */
	const log = options.verbose
		? (...args) => console.log('[sveltekit-cloudflare-worker]', ...args)
		: () => {};

	let root = runtimeRoot;
	let isBuild = false;
	let isPreview = false;
	const devEntryPath = path.resolve(runtimeRoot, DEV_OUTPUT_DIR, DEV_ENTRY_FILE);
	const cloudflareRuntime = distilledDevRuntime({
		root: runtimeRoot,
		main: devEntryPath,
		configFile: configPath,
		connectPort,
		verbose: options.verbose
	});
	/** @type {{ handlers: string[], classes: string[] } | undefined} */
	let currentDevExports;
	const updateWorkerEntry = async () => {
		const workerPath = path.resolve(runtimeRoot, workerFile);
		assertWorkerFile(workerPath, workerFile);
		const nextExports = await detectWorkerExports(workerPath);
		cloudflareRuntime.enableConnect(nextExports.handlers.includes('connect'));
		if (!currentDevExports || !sameWorkerExports(currentDevExports, nextExports)) {
			generateDevEntry(runtimeRoot, workerFile, nextExports, log);
		}
		currentDevExports = nextExports;
	};
	const nodePlugins = nodeDevIntegration({
		root: runtimeRoot,
		workerFile,
		userHooksFile,
		refreshPlatformProxy: cloudflareRuntime.refreshPlatformProxy,
		updateWorkerEntry
	});

	/** @type {import('vite').Plugin} */
	const typesPlugin = {
		name: 'sveltekit-cloudflare-worker:types',
		enforce: 'pre',
		async config(userConfig, environment) {
			isBuild = environment.command === 'build';
			isPreview = environment.isPreview === true;
			root = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
			const workerPath = path.resolve(root, workerFile);
			assertWorkerFile(workerPath, workerFile);
			const exports = await detectWorkerExports(workerPath);
			await writeAppEnvTypes({
				root,
				workerFile,
				typesFile,
				classExports: exports.classes,
				configPath,
				log
			});
		}
	};

	/** @type {import('vite').Plugin} */
	const devEntryPlugin = {
		name: 'sveltekit-cloudflare-worker:dev-entry',
		apply: 'serve',
		async config(userConfig) {
			root = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
			if (root !== runtimeRoot) {
				throw new Error(
					`SvelteKit uses the Vite root ${root}, but sveltekit-cloudflare-worker initialized from ${runtimeRoot}. ` +
						'Pass the same path as cloudflareWorker({}, { root }) so the local Worker and SvelteKit share one project root.'
				);
			}
			await updateWorkerEntry();
		}
	};

	return {
		...adapter,
		name: 'sveltekit-cloudflare-worker',
		async emulate() {
			const prerenderPlatform = createUnavailablePlatform(
				(binding) => `Cannot access platform.env.${binding} in a prerenderable route`
			);
			const previewPlatform = createUnavailablePlatform(
				(binding) =>
					`Cannot access platform.env.${binding} in Vite preview. ` +
					'Run Wrangler after a build to preview the composed Worker and Cloudflare bindings.'
			);
			return {
				platform: ({ prerender }) => {
					if (isBuild || prerender) return prerenderPlatform;
					if (isPreview) return previewPlatform;
					return cloudflareRuntime.platform();
				}
			};
		},
		async adapt(builder) {
			// The delegated adapter still reads the pre-SvelteKit 3 `config.kit` alias.
			const legacyConfig = new Proxy(builder.config, {
				get(target, property, receiver) {
					return property === 'kit' ? receiver : Reflect.get(target, property, receiver);
				}
			});
			const cloudflareBuilder = new Proxy(builder, {
				get(target, property, receiver) {
					return property === 'config' ? legacyConfig : Reflect.get(target, property, receiver);
				}
			});
			await adapter.adapt(cloudflareBuilder);
			await composeBuildOutput(root, workerFile, configPath, log);
		},
		vite: {
			plugins: {
				pre: [
					...(adapter.vite?.plugins?.pre ?? []),
					typesPlugin,
					devEntryPlugin,
					...nodePlugins,
					workerdRuntimePlugin(),
					...cloudflareRuntime.plugins
				],
				post: [...(adapter.vite?.plugins?.post ?? [])]
			}
		}
	};
}

/**
 * @param {(binding: string) => string} bindingError
 * @returns {App.Platform}
 */
function createUnavailablePlatform(bindingError) {
	const env = new Proxy(
		{},
		{
			get(_target, binding) {
				if (typeof binding === 'symbol') return undefined;
				throw new Error(bindingError(binding));
			}
		}
	);
	return /** @type {App.Platform} */ (/** @type {unknown} */ ({ env }));
}

/** @returns {import('vite').Plugin} */
function workerdRuntimePlugin() {
	const workerdEsmEnv = '\0sveltekit-cloudflare-worker:esm-env';

	return {
		name: 'sveltekit-cloudflare-worker:workerd-runtime',
		apply: 'serve',
		enforce: 'pre',
		configEnvironment: {
			order: 'pre',
			handler(name, config) {
				if (name !== 'worker') return;
				config.optimizeDeps ??= {};
				config.optimizeDeps.exclude = [...(config.optimizeDeps.exclude ?? []), 'svelte'];
			}
		},
		applyToEnvironment(environment) {
			return environment.name === 'worker';
		},
		resolveId(id) {
			if (id === 'esm-env') return workerdEsmEnv;
		},
		load(id) {
			if (id === workerdEsmEnv) {
				return 'export const BROWSER = false; export const DEV = true; export const NODE = false;';
			}
		}
	};
}

/**
 * @param {string} root
 * @param {string} workerFile
 * @param {string | undefined} configFile
 * @param {(...args: unknown[]) => void} log
 */
async function composeBuildOutput(root, workerFile, configFile, log) {
	const workerPath = path.resolve(root, workerFile);
	assertWorkerFile(workerPath, workerFile);

	const { workerDest, assetsDirectory } = await findBuildOutput(root, configFile, log);
	if (!existsSync(workerDest)) return;

	const workerContent = readFileSync(workerDest, 'utf-8');
	if (workerContent.startsWith(BUILD_ENTRY_MARKER)) return;

	const userWorker = await bundleWorker(workerPath);
	const exports = userWorker.exports;
	if (exports.classes.length === 0 && exports.handlers.length === 0) return;

	const workerDestDir = path.dirname(workerDest);
	const userWorkerDest = path.join(workerDestDir, '_user-worker.js');
	const svelteKitWorkerDest = path.join(workerDestDir, '_sveltekit-worker.js');
	rmSync(userWorkerDest, { force: true });
	rmSync(svelteKitWorkerDest, { force: true });
	writeFileSync(userWorkerDest, userWorker.content);
	copyFileSync(workerDest, svelteKitWorkerDest);
	writeFileSync(workerDest, createWorkerFacade(exports));
	appendInternalAssetsIgnore(assetsDirectory, [svelteKitWorkerDest, userWorkerDest]);

	log(
		`Composed ${path.basename(workerDest)} with:` +
			(exports.handlers.length ? ` handlers=[${exports.handlers.join(', ')}]` : '') +
			(exports.classes.length ? ` classes=[${exports.classes.join(', ')}]` : '')
	);
}

/**
 * @param {string} root
 * @param {string} workerFile
 * @param {{ handlers: string[], classes: string[] }} exports
 * @param {(...args: unknown[]) => void} log
 */
function generateDevEntry(root, workerFile, exports, log) {
	const dir = path.resolve(root, DEV_OUTPUT_DIR);
	mkdirSync(dir, { recursive: true });
	const entryPath = path.join(dir, DEV_ENTRY_FILE);
	const workerImport = toSafeImportPath(dir, path.resolve(root, workerFile));
	const lines = [];
	lines.push(`import * as __userWorker from '${workerImport}';`, '');
	if (exports.handlers.includes('connect')) {
		lines.push(
			`import { WorkerEntrypoint as __SvelteKitCloudflareWorkerEntrypoint } from 'cloudflare:workers';`,
			`export class __SvelteKitCloudflareWorkerConnectEntrypoint extends __SvelteKitCloudflareWorkerEntrypoint {}`,
			''
		);
	}

	for (const className of exports.classes) {
		lines.push(`export { ${className} } from '${workerImport}';`);
	}
	if (exports.classes.length > 0) lines.push('');

	const hasFetch = exports.handlers.includes('fetch');
	const otherHandlers = exports.handlers.filter((handler) => handler !== 'fetch');
	const needsWaitUntilLast = hasFetch || otherHandlers.length > 0;
	const defaultEntries = [];

	if (hasFetch) {
		defaultEntries.push(
			`  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {\n` +
				`    const __waitUntilLast = __sveltekitCloudflareWorkerWaitUntilLast(ctx);\n` +
				`    try {\n` +
				`      let nextResponse: Promise<Response> | undefined;\n` +
				`      const next = () => { nextResponse ??= Promise.resolve(new Response('Not Found', { status: 404 })); return nextResponse; };\n` +
				`      const response = await __userWorker.fetch(request, env, __waitUntilLast.ctx, next);\n` +
				`      if (response) return response;\n` +
				`      return await (nextResponse ?? next());\n` +
				`    } finally {\n` +
				`      __waitUntilLast.flush();\n` +
				`    }\n` +
				`  }`
		);
	} else {
		defaultEntries.push(
			`  async fetch(): Promise<Response> {\n` +
				`    return new Response('Not Found', { status: 404 });\n` +
				`  }`
		);
	}

	for (const handler of otherHandlers) {
		defaultEntries.push(buildDevHandlerEntry(handler));
	}

	if (needsWaitUntilLast) lines.push(WAIT_UNTIL_LAST_HELPER, '');
	lines.push('export default {', defaultEntries.join(',\n'), '};', '');
	writeFileSync(entryPath, lines.join('\n'));
	log(`Generated dev entry at ${path.relative(root, entryPath)}`);
	return entryPath;
}

/** @param {string} from @param {string} to */
function toSafeImportPath(from, to) {
	let importPath = path.relative(from, to);
	if (!importPath.startsWith('.')) importPath = './' + importPath;
	importPath = importPath.replace(/\.(?:js|ts)$/, '');
	return importPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** @param {string} handler */
function buildDevHandlerEntry(handler) {
	const firstArg = getHandlerArgument(handler);
	const firstType = {
		connect: 'Socket',
		scheduled: 'ScheduledController',
		queue: 'MessageBatch',
		email: 'ForwardableEmailMessage',
		tail: 'TraceItem[]',
		trace: 'TraceItem[]',
		tailStream: 'TailStream.TailEvent<TailStream.Onset>',
		test: 'TestController'
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

/** @param {string} handler */
function getHandlerArgument(handler) {
	return {
		connect: 'socket',
		scheduled: 'controller',
		queue: 'batch',
		email: 'message',
		tail: 'events',
		trace: 'traces',
		tailStream: 'event',
		test: 'controller'
	}[handler];
}

/**
 * @param {string} root
 * @param {string | undefined} configFile
 * @param {(...args: unknown[]) => void} log
 */
async function findBuildOutput(root, configFile, log) {
	const config = await readWranglerConfig(root, log, configFile);
	const configRoot =
		typeof config.configPath === 'string' ? path.dirname(path.resolve(config.configPath)) : root;
	const workerDest =
		typeof config.main === 'string'
			? path.resolve(root, config.main)
			: path.resolve(root, '.svelte-kit/cloudflare/_worker.js');
	const assets =
		config.assets && typeof config.assets === 'object' && !Array.isArray(config.assets)
			? /** @type {Record<string, unknown>} */ (config.assets)
			: {};
	const assetsDirectory =
		typeof assets.directory === 'string'
			? path.resolve(configRoot, assets.directory)
			: path.dirname(workerDest);
	return { workerDest, assetsDirectory };
}

/** @param {string} assetsDirectory @param {string[]} files */
function appendInternalAssetsIgnore(assetsDirectory, files) {
	const assetsIgnorePath = path.join(assetsDirectory, '.assetsignore');
	if (!existsSync(assetsIgnorePath)) return;

	const content = readFileSync(assetsIgnorePath, 'utf-8');
	const entries = files.flatMap((file) => {
		const relative = path.relative(assetsDirectory, file);
		if (relative.startsWith('..') || path.isAbsolute(relative)) return [];
		return [relative.replace(/\\/g, '/')];
	});
	const missing = entries.filter((file) => !content.split(/\r?\n/).includes(file));
	if (missing.length === 0) return;
	writeFileSync(assetsIgnorePath, `${content.trimEnd()}\n${missing.join('\n')}\n`);
}

/** @param {{ handlers: string[], classes: string[] }} left @param {{ handlers: string[], classes: string[] }} right */
function sameWorkerExports(left, right) {
	return (
		left.handlers.length === right.handlers.length &&
		left.classes.length === right.classes.length &&
		left.handlers.every((handler, index) => handler === right.handlers[index]) &&
		left.classes.every((className, index) => className === right.classes[index])
	);
}

/** @param {string} workerPath @param {string} workerFile */
function assertWorkerFile(workerPath, workerFile) {
	if (existsSync(workerPath)) return;
	throw new Error(`sveltekit-cloudflare-worker could not find the Worker entry at ${workerFile}.`);
}

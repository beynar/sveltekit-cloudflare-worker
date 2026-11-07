import { existsSync } from 'node:fs';
import path from 'node:path';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { getRequest } from '@sveltejs/kit/node';
import { writeAppEnvTypes } from './binding-types.js';
import { composeBuildOutput } from './build-output.js';
import { devRequestCf, devRuntimePlugins } from './dev/runtime.js';
import { detectWorkerExports, detectWorkerExportsShallow } from './worker-composition.js';
import { findWranglerConfig } from './wrangler-config.js';

const LOG_PREFIX = '[sveltekit-cloudflare-worker]';

/**
 * Add the Cloudflare Worker adapter to a SvelteKit 3 configuration (the options object passed
 * to `sveltekit()` in `vite.config.ts`).
 *
 * @param {import('@sveltejs/kit/vite').Config} [config]
 * @param {import('./index.js').CloudflareWorkerOptions} [options]
 * @returns {import('@sveltejs/kit/vite').Config & { adapter: import('@sveltejs/kit').Adapter }}
 */
export function cloudflareWorker(config = {}, options = {}) {
	if (config.adapter) {
		throw new Error(
			`${LOG_PREFIX} cloudflareWorker() installs its own adapter. Remove "adapter" from the SvelteKit options and pass adapter-cloudflare options as the second argument.`
		);
	}
	return { ...config, adapter: cloudflareWorkerAdapter(options) };
}

/**
 * The SvelteKit adapter used by {@link cloudflareWorker}. Use it directly when you assemble the
 * SvelteKit options yourself: `sveltekit({ adapter: cloudflareWorkerAdapter() })`.
 *
 * @param {import('./index.js').CloudflareWorkerOptions} [options]
 * @returns {import('@sveltejs/kit').Adapter}
 */
export function cloudflareWorkerAdapter(options = {}) {
	const workerFile = options.workerFile ?? 'src/worker.ts';
	const typesFile = options.typesFile === undefined ? 'src/app.d.ts' : options.typesFile;
	const cloudflareEnv = options.environment ?? process.env.CLOUDFLARE_ENV;
	/** @type {(...args: unknown[]) => void} */
	const log = options.verbose ? (...args) => console.log(LOG_PREFIX, ...args) : () => {};

	/**
	 * Shared with the development runtime. Without an explicit `root`, the project root follows
	 * Vite's root (tools such as svelte-check load vite.config from another working directory).
	 * @type {import('./dev/runtime.js').DevRuntimeOptions}
	 */
	const settings = {
		root: '',
		workerFile,
		configPath: undefined,
		cloudflareEnv,
		persistState: options.persistState ?? true,
		remoteBindings: options.remoteBindings ?? true,
		log
	};
	/** @param {string} root */
	const setRoot = (root) => {
		settings.root = root;
		settings.configPath = options.config
			? path.resolve(root, options.config)
			: (findWranglerConfig(root) ?? undefined);
	};
	setRoot(path.resolve(options.root ?? process.cwd()));

	const adapter = adapterCloudflare({
		config: options.config ? path.resolve(settings.root, options.config) : undefined,
		fallback: options.fallback,
		routes: options.routes,
		platformProxy: {
			configPath: settings.configPath,
			environment: cloudflareEnv,
			persist: options.persistState
		}
	});
	const adapterPlugins = normalizeAdapterPlugins(adapter.vite);

	/** @type {readonly import('./worker-composition.js').Alias[]} */
	let aliases = [];

	/** @type {import('vite').Plugin} */
	const projectPlugin = {
		name: 'sveltekit-cloudflare-worker:project',
		enforce: 'pre',
		config(userConfig) {
			if (options.root === undefined) {
				setRoot(userConfig.root ? path.resolve(userConfig.root) : process.cwd());
			}
			assertWorkerFile(path.resolve(settings.root, workerFile), workerFile);
		},
		async configResolved(config) {
			aliases = config.resolve.alias;
			if (typesFile === false) return;
			const workerPath = path.resolve(settings.root, workerFile);
			const exports = await detectWorkerExports(workerPath, { aliases }).catch(() =>
				detectWorkerExportsShallow(workerPath)
			);
			await writeAppEnvTypes({
				root: settings.root,
				workerFile,
				typesFile,
				classExports: exports.classes,
				configPath: settings.configPath,
				log
			});
		}
	};

	// adapter-cloudflare's own plugin emulates `cloudflare:workers` with getPlatformProxy() and
	// rewrites the import for production. The development runtime replaces it during `vite dev`;
	// it stays active for `vite build` and `vite preview`.
	const buildAndPreviewPlugins = adapterPlugins.map((plugin) => ({
		...plugin,
		/** @type {import('vite').Plugin['apply']} */
		apply: (_config, env) => env.command === 'build' || env.isPreview === true
	}));

	return {
		name: 'sveltekit-cloudflare-worker',
		supports: adapter.supports,
		async adapt(builder) {
			await adapter.adapt(builder);
			await composeBuildOutput({
				root: settings.root,
				workerFile,
				configPath: settings.configPath,
				cloudflareEnv,
				aliases,
				log
			});
		},
		vite: {
			getRequest(requestOptions) {
				const request = /** @type {Request & { cf?: unknown }} */ (getRequest(requestOptions));
				const cf =
					devRequestCf() ?? /** @type {any} */ (globalThis).__sveltekit_cloudflare_platform?.cf;
				if (cf) request.cf = cf;
				return request;
			},
			plugins: {
				pre: [projectPlugin, ...buildAndPreviewPlugins, ...devRuntimePlugins(settings)]
			}
		}
	};
}

/** @param {import('@sveltejs/kit').Adapter['vite']} vite @returns {import('vite').Plugin[]} */
function normalizeAdapterPlugins(vite) {
	if (!vite || typeof vite === 'function') return [];
	const plugins = vite.plugins;
	if (!plugins) return [];
	if (Array.isArray(plugins)) return plugins;
	return [...(plugins.pre ?? []), ...(plugins.post ?? [])];
}

/** @param {string} workerPath @param {string} workerFile */
function assertWorkerFile(workerPath, workerFile) {
	if (existsSync(workerPath)) return;
	throw new Error(`${LOG_PREFIX} could not find the Worker entry at ${workerFile}.`);
}

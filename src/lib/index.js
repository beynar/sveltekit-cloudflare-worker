import path from 'node:path';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { writeAppEnvTypes } from './binding-types.js';
import { composeBuildOutput } from './build-output.js';
import { devRequestCf, devRuntimePlugins } from './dev/runtime.js';
import { LOG_PREFIX, findWranglerConfig, resolveWorkerFile } from './project.js';
import { detectWorkerExports, detectWorkerExportsShallow } from './worker-composition.js';

/**
 * Add the Cloudflare Worker adapter to the SvelteKit options passed to `sveltekit()`.
 *
 * @param {import('@sveltejs/kit/vite').Config} [config]
 * @param {import('./index.js').CloudflareWorkerOptions} [options]
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
 * The adapter installed by {@link cloudflareWorker}: adapter-cloudflare, then the composition of
 * `src/worker.ts` into its Worker, plus the `vite dev` runtime.
 *
 * @param {import('./index.js').CloudflareWorkerOptions} [options]
 * @returns {import('@sveltejs/kit').Adapter}
 */
export function cloudflareWorkerAdapter(options = {}) {
	const typesFile = options.typesFile ?? 'src/app.d.ts';
	/** @type {import('./dev/runtime.js').DevRuntimeOptions} */
	const settings = {
		root: '',
		workerFile: options.workerFile ?? 'src/worker.ts',
		cloudflareEnv: options.environment ?? process.env.CLOUDFLARE_ENV,
		persistState: options.persistState ?? true,
		remoteBindings: options.remoteBindings ?? true,
		log: options.verbose ? (...args) => console.log(LOG_PREFIX, ...args) : () => {}
	};
	/** @param {string} root */
	const setRoot = (root) => {
		settings.root = root;
		settings.configPath = options.config
			? path.resolve(root, options.config)
			: findWranglerConfig(root);
	};
	setRoot(path.resolve(options.root ?? process.cwd()));

	const adapter = adapterCloudflare({
		config: settings.configPath,
		fallback: options.fallback,
		routes: options.routes,
		platformProxy: {
			configPath: settings.configPath,
			environment: settings.cloudflareEnv,
			persist: options.persistState
		}
	});
	const adapterVite = /** @type {Required<import('@sveltejs/kit').AdapterViteConfig>} */ (
		adapter.vite
	);
	/** @type {readonly import('./worker-composition.js').Alias[]} */
	let aliases = [];

	/** @type {import('vite').Plugin} */
	const projectPlugin = {
		name: 'sveltekit-cloudflare-worker:project',
		enforce: 'pre',
		config(userConfig) {
			// Follow Vite's root unless one was given: svelte-check, for example, loads vite.config
			// from another working directory.
			if (options.root === undefined) setRoot(path.resolve(userConfig.root ?? process.cwd()));
			resolveWorkerFile(settings.root, settings.workerFile);
		},
		async configResolved(config) {
			aliases = config.resolve.alias;
			if (typesFile === false) return;
			const workerPath = resolveWorkerFile(settings.root, settings.workerFile);
			const { classes } = await detectWorkerExports(workerPath, aliases).catch(() =>
				detectWorkerExportsShallow(workerPath)
			);
			writeAppEnvTypes({ ...settings, typesFile, classExports: classes });
		}
	};

	return {
		name: 'sveltekit-cloudflare-worker',
		supports: adapter.supports,
		async adapt(builder) {
			await adapter.adapt(builder);
			await composeBuildOutput({
				workerPath: resolveWorkerFile(settings.root, settings.workerFile),
				configPath: settings.configPath,
				cloudflareEnv: settings.cloudflareEnv,
				aliases,
				log: settings.log
			});
		},
		vite: {
			getRequest(requestOptions) {
				const request = /** @type {Request & { cf?: unknown }} */ (
					adapterVite.getRequest(requestOptions)
				);
				request.cf = devRequestCf() ?? request.cf;
				return request;
			},
			plugins: {
				pre: [
					projectPlugin,
					// adapter-cloudflare emulates `cloudflare:workers` with getPlatformProxy() and rewrites
					// it for production. The dev runtime replaces it in `vite dev` only.
					.../** @type {import('vite').Plugin[]} */ (adapterVite.plugins).map((plugin) => ({
						...plugin,
						/** @type {import('vite').Plugin['apply']} */
						apply: (_config, env) => env.command === 'build' || env.isPreview === true
					})),
					...devRuntimePlugins(settings)
				]
			}
		}
	};
}

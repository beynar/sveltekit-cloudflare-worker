import path from 'node:path';
import cloudflare from '@distilled.cloud/cloudflare-vite-plugin';
import * as Credentials from '@distilled.cloud/cloudflare/Credentials';
import * as RuntimeServices from '@distilled.cloud/cloudflare-runtime/RuntimeServices';
import * as Plugin from '@distilled.cloud/cloudflare-runtime/Plugin';
import * as PluginContext from '@distilled.cloud/cloudflare-runtime/PluginContext';
import { getPlatformProxy } from '@distilled.cloud/cloudflare-runtime/platform-proxy';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Scope from 'effect/Scope';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import { resolveDistilledDevConfiguration } from './distilled-wrangler.js';
import { DEV_ASSET_REQUEST_HEADER } from './dev-constants.js';

const runtimeContexts = new Map();
const TCP_INGRESS_SOCKET = 'sveltekit-cloudflare-worker:connect';
const DISTILLED_USER_WORKER_SERVICE = 'user-worker';
const TcpIngress = Plugin.Service()(
	'cloudflare-runtime/plugin/SvelteKitCloudflareWorkerTcpIngress'
);

/**
 * @param {{ root: string, main: string, configFile?: string, connectPort?: number, verbose?: boolean }} input
 * @returns {{
 *   plugins: import('vite').Plugin[],
 *   platform(): Promise<App.Platform>,
 *   refreshPlatformProxy(): Promise<void>,
 *   enableConnect(enabled: boolean): void
 * }}
 */
export function distilledDevRuntime({ root, main, configFile, connectPort, verbose }) {
	/** @type {Error | undefined} */
	let startupError;
	let configuration;
	try {
		configuration = resolveDistilledDevConfiguration(root, main, configFile, verbose);
	} catch (error) {
		startupError = error instanceof Error ? error : new Error(String(error));
		configuration = fallbackDevConfiguration(main, verbose);
	}
	const { workerOptions, platformProxyOptions, assetsBinding, workflowBindings, tcpListener } =
		configuration;
	if (tcpListener && connectPort !== undefined && !startupError) {
		startupError = new Error(
			'Configure the local TCP listener in Wrangler connect, or use the deprecated connectPort adapter option, but not both.'
		);
	}
	const tcpIngress = {
		enabled: false,
		ownerName: workerOptions.worker?.name,
		address: tcpListener?.address ?? '127.0.0.1',
		port: tcpListener?.port ?? connectPort ?? 8788,
		verbose: verbose === true
	};
	/** @type {Promise<import('@distilled.cloud/cloudflare-runtime/platform-proxy').PlatformProxy<Record<string, unknown>>> | undefined} */
	let platformProxy;
	/** @type {Record<string, unknown> | undefined} */
	let platformEnv;

	const disposePlatformProxy = async () => {
		const proxy = platformProxy;
		platformProxy = undefined;
		platformEnv = undefined;
		if (proxy) await (await proxy).dispose();
	};
	const lifecycle = runtimeContextPlugin(
		root,
		workerOptions,
		tcpIngress,
		disposePlatformProxy,
		startupError
	);
	const plugins = flattenPlugins(cloudflare(workerOptions));
	const devPlugin = plugins.find((plugin) => plugin.name === 'distilled-cloudflare:dev');
	if (!devPlugin) throw new Error('The Distilled development plugin is missing.');
	suppressHttpProxy(devPlugin);
	const optionsPlugin = plugins.find((plugin) => plugin.name === 'distilled-cloudflare:options');
	if (!optionsPlugin) throw new Error('The Distilled options plugin is missing.');
	preserveNodeSsr(optionsPlugin);

	const getOrCreatePlatformProxy = () => {
		return (platformProxy ??= (async () => {
			const services = workerOptions.context ?? (await acquireRuntimeContext(root, tcpIngress));
			return getPlatformProxy({ ...platformProxyOptions, services });
		})());
	};

	return {
		plugins: [
			{ ...lifecycle, apply: developmentOnly },
			...plugins.map((plugin) => ({ ...plugin, apply: developmentOnly }))
		],
		async platform() {
			if (startupError) throw startupError;
			const proxy = await getOrCreatePlatformProxy();
			platformEnv ??= addNodeBindings(proxy.env, assetsBinding, workflowBindings);
			return /** @type {App.Platform} */ (
				/** @type {unknown} */ ({
					env: platformEnv,
					ctx: proxy.ctx,
					caches: proxy.caches,
					cf: proxy.cf
				})
			);
		},
		async refreshPlatformProxy() {
			await disposePlatformProxy();
			await getOrCreatePlatformProxy();
		},
		enableConnect(enabled) {
			tcpIngress.enabled = enabled;
		}
	};
}

/** @type {Exclude<import('vite').Plugin['apply'], string | undefined>} */
const developmentOnly = (_config, environment) =>
	environment.command === 'serve' && environment.isPreview !== true;

/**
 * @param {string} root
 * @param {import('@distilled.cloud/cloudflare-vite-plugin').CloudflareVitePluginOptions} options
 * @param {{ enabled: boolean, ownerName: string | undefined, address: string, port: number, verbose: boolean }} tcpIngress
 * @param {() => Promise<void>} beforeClose
 * @param {Error | undefined} startupError
 * @returns {import('vite').Plugin}
 */
function runtimeContextPlugin(root, options, tcpIngress, beforeClose, startupError) {
	return {
		name: 'sveltekit-cloudflare-worker:distilled-runtime',
		apply: 'serve',
		enforce: 'pre',
		async configureServer(server) {
			if (startupError) throw startupError;
			const contextRoot = server.config.root ?? root;
			let closed = false;
			options.context = await acquireRuntimeContext(contextRoot, tcpIngress);
			const close = async () => {
				if (closed) return;
				closed = true;
				await beforeClose();
				await releaseRuntimeContext(contextRoot);
			};
			server.httpServer?.once('close', close);
		}
	};
}

/**
 * Distilled plugins must exist while Vite resolves its plugin graph. If a Wrangler feature cannot
 * be represented locally, keep build mode inert and surface the original error only when dev starts.
 * @param {string} main
 * @param {boolean | undefined} verbose
 */
function fallbackDevConfiguration(main, verbose) {
	return {
		workerOptions:
			/** @type {import('@distilled.cloud/cloudflare-vite-plugin').CloudflareVitePluginOptions} */ (
				/** @type {unknown} */ ({
					main,
					viteEnvironments: { entry: 'worker' },
					skipEnvironments: ['ssr'],
					worker: {
						name: 'sveltekit-cloudflare-worker:invalid-dev-config',
						bindings: [],
						logging: { verbose: verbose === true }
					}
				})
			),
		platformProxyOptions:
			/** @type {import('@distilled.cloud/cloudflare-runtime/platform-proxy').PlatformProxyOptions} */ ({
				bindings: []
			}),
		assetsBinding: undefined,
		workflowBindings: [],
		tcpListener: undefined
	};
}

/** @param {import('vite').PluginOption} option @returns {import('vite').Plugin[]} */
function flattenPlugins(option) {
	if (!option) return [];
	if (Array.isArray(option)) return option.flatMap(flattenPlugins);
	if (option instanceof Promise) {
		throw new Error('The Distilled Vite plugin unexpectedly returned an asynchronous plugin.');
	}
	return [option];
}

/** @param {import('vite').Plugin} plugin */
function suppressHttpProxy(plugin) {
	const hook = plugin.configureServer;
	if (!hook) throw new Error('The Distilled development plugin has no server hook.');

	plugin.configureServer = async function configureWebSocketOnly(server) {
		let installProxy;
		if (typeof hook === 'function') {
			installProxy = await hook.call(this, server);
		} else {
			installProxy = await hook.handler.call(this, server);
		}
		// Distilled attaches its WebSocket listener before returning the HTTP proxy middleware.
		// Keep only its reserved handler routes; SvelteKit retains ordinary HTTP ownership in Node.
		if (typeof installProxy !== 'function') return;
		return () => {
			installProxy();
			const stack = server.middlewares.stack;
			const index = stack.findLastIndex(
				(entry) =>
					/** @type {{ name?: string }} */ (entry.handle).name ===
					'distilledCloudflareProxyMiddleware'
			);
			if (index === -1) {
				throw new Error('Distilled did not install its expected HTTP proxy middleware.');
			}
			const [proxy] = stack.splice(index, 1);
			const proxyHandler = /** @type {import('vite').Connect.NextHandleFunction} */ (proxy.handle);
			server.middlewares.use((request, response, next) => {
				const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
				if (pathname.startsWith('/cdn-cgi/handler/')) {
					return proxyHandler(request, response, next);
				}
				next();
			});
		};
	};
}

/** @param {import('vite').Plugin} plugin */
function preserveNodeSsr(plugin) {
	const hook = plugin.config;
	if (!hook) throw new Error('The Distilled options plugin has no config hook.');

	plugin.config = async function configureWorkerEnvironment(config, environment) {
		const resolved =
			typeof hook === 'function'
				? await hook.call(this, config, environment)
				: await hook.handler.call(this, config, environment);
		if (!resolved || typeof resolved !== 'object') return resolved;
		const workerOnlyConfig = { ...resolved };
		delete workerOnlyConfig.ssr;
		return workerOnlyConfig;
	};
}

/**
 * @param {Record<string, unknown>} env
 * @param {string | undefined} assetsBinding
 * @param {string[]} workflowBindings
 */
function addNodeBindings(env, assetsBinding, workflowBindings) {
	const bindings = { ...env };
	if (assetsBinding && !(assetsBinding in bindings)) {
		bindings[assetsBinding] = {
			/** @param {RequestInfo | URL} input @param {RequestInit} [init] */
			fetch(input, init) {
				const request = new Request(input, init);
				const headers = new Headers(request.headers);
				headers.set(DEV_ASSET_REQUEST_HEADER, '1');
				return fetch(new Request(request, { headers }));
			}
		};
	}
	for (const binding of workflowBindings) {
		bindings[binding] = makeNodeWorkflowBinding(env[binding]);
	}
	return bindings;
}

/**
 * @typedef {{
 *   pause(): Promise<void>,
 *   resume(): Promise<void>,
 *   terminate(options?: WorkflowInstanceTerminateOptions): Promise<void>,
 *   restart(options?: WorkflowInstanceRestartOptions): Promise<void>,
 *   delete(): Promise<void>,
 *   status(): Promise<InstanceStatus>,
 *   sendEvent(event: { type: string, payload: unknown }): Promise<void>
 * }} WorkflowChain
 */

/**
 * @typedef {{
 *   get(id: string): WorkflowChain,
 *   create(options: WorkflowInstanceCreateOptions): WorkflowChain,
 *   deleteBatch(ids: string[]): Promise<WorkflowBatchDeleteResult>
 * }} NodeWorkflowProxy
 */

/** @param {unknown} binding @returns {Workflow} */
function makeNodeWorkflowBinding(binding) {
	const workflow = /** @type {NodeWorkflowProxy} */ (binding);
	/** @param {string} id @returns {WorkflowInstance} */
	const instance = (id) => ({
		id,
		pause: () => workflow.get(id).pause(),
		resume: () => workflow.get(id).resume(),
		terminate: (options) => workflow.get(id).terminate(options),
		restart: (options) => workflow.get(id).restart(options),
		delete: () => workflow.get(id).delete(),
		status: () => workflow.get(id).status(),
		sendEvent: (event) => workflow.get(id).sendEvent(event)
	});
	/** @param {WorkflowInstanceCreateOptions} [options] */
	const create = async (options = {}) => {
		const id = typeof options.id === 'string' ? options.id : crypto.randomUUID();
		await workflow.create({ ...options, id }).status();
		return instance(id);
	};
	return {
		/** @param {string} id */
		async get(id) {
			await workflow.get(id).status();
			return instance(id);
		},
		create,
		/** @param {WorkflowInstanceCreateOptions[]} options */
		async createBatch(options) {
			return Promise.all(options.map(create));
		},
		/** @param {string[]} ids */
		deleteBatch: (ids) => workflow.deleteBatch(ids)
	};
}

/**
 * @param {string} root
 * @param {{ enabled: boolean, ownerName: string | undefined, address: string, port: number, verbose: boolean }} tcpIngress
 */
async function acquireRuntimeContext(root, tcpIngress) {
	let entry = runtimeContexts.get(root);
	if (!entry) {
		entry = createRuntimeContext(root, tcpIngress);
		runtimeContexts.set(root, entry);
	}
	const runtime = await entry;
	runtime.users += 1;
	return runtime.context;
}

/** @param {string} root */
async function releaseRuntimeContext(root) {
	const entry = runtimeContexts.get(root);
	if (!entry) return;
	const runtime = await entry;
	runtime.users -= 1;
	if (runtime.users > 0) return;
	runtimeContexts.delete(root);
	await Effect.runPromise(Scope.closeUnsafe(runtime.scope, Exit.void) ?? Effect.void);
}

/**
 * @param {string} root
 * @param {{ enabled: boolean, ownerName: string | undefined, address: string, port: number, verbose: boolean }} tcpIngress
 */
async function createRuntimeContext(root, tcpIngress) {
	const scope = Scope.makeUnsafe();
	const context = await RuntimeServices.layerRuntime({
		api: { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '00000000000000000000000000000000' },
		storage: { directory: path.join(root, '.sveltekit-cloudflare-worker', 'local') }
	}).pipe(
		Layer.provideMerge(tcpIngressLayer(tcpIngress)),
		Layer.provideMerge(NodeServices.layer),
		Layer.provide(Layer.merge(Credentials.fromEnv(), FetchHttpClient.layer)),
		Layer.buildWithScope(scope),
		Effect.runPromise
	);
	return { context, scope, users: 0 };
}

/** @param {{ enabled: boolean, ownerName: string | undefined, address: string, port: number, verbose: boolean }} options */
function tcpIngressLayer(options) {
	return Layer.succeed(
		TcpIngress,
		TcpIngress.of(
			Effect.map(PluginContext.PluginContext, ({ worker }) => ({
				...(options.enabled && worker.name === options.ownerName
					? {
							userWorker: {
								compatibilityFlags: [
									...new Set([...(worker.compatibilityFlags ?? []), 'experimental'])
								]
							},
							sockets: [
								{
									name: TCP_INGRESS_SOCKET,
									address: `${options.address}:${options.port}`,
									tcp: {},
									service: { name: DISTILLED_USER_WORKER_SERVICE }
								}
							]
						}
					: {}),
				start: (ports) =>
					Effect.sync(() => {
						const port = ports[TCP_INGRESS_SOCKET];
						if (!port) return;
						if (options.verbose || options.port === 0) {
							console.log(
								`[sveltekit-cloudflare-worker] connect handler listening on tcp://${options.address}:${port}`
							);
						}
					})
			}))
		)
	);
}

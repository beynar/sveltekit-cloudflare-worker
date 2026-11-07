// Development runtime: one Miniflare instance per project root runs `src/worker.ts` in
// workerd through Vite's module runner (HMR), and exposes the same Worker bindings to
// SvelteKit's Node SSR through `cloudflare:workers`.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as vite from 'vite';
import { WebSocketServer } from 'ws';
import { detectWorkerExports, detectWorkerExportsShallow } from '../worker-composition.js';
import {
	EVAL_BINDING,
	INIT_PATH,
	INIT_TOKEN_HEADER,
	INTERNAL_BINDINGS,
	INVOKE_BINDING,
	NEXT_BINDING,
	RUNNER_OBJECT_BINDING,
	WORKER_ENVIRONMENT
} from './constants.js';

const STATE_KEY = Symbol.for('sveltekit-cloudflare-worker.dev-state');
const REGISTRY_KEY = Symbol.for('sveltekit-cloudflare-worker.dev-runtimes');
const kNext = Symbol.for('sveltekit-cloudflare-worker.next');
const NODE_SHIM = fileURLToPath(new URL('./cloudflare-workers-node.js', import.meta.url));
const RUNNER_SOURCE = fileURLToPath(new URL('./runner-worker.js', import.meta.url));
const MODULES_ROOT = process.platform === 'win32' ? 'Z:\\' : '/';
const ENTRY_MODULE = path.join(MODULES_ROOT, '__sveltekit_cloudflare_worker', 'entry.js');
const RUNNER_MODULE = path.join(MODULES_ROOT, '__sveltekit_cloudflare_worker', 'runner.js');

const CLOUDFLARE_BUILTINS = [
	'cloudflare:email',
	'cloudflare:node',
	'cloudflare:sockets',
	'cloudflare:workers',
	'cloudflare:workflows'
];
const NODE_BUILTINS = builtinModules.filter((name) => !name.startsWith('_'));
const NODE_BUILTINS_RE = new RegExp(
	`^(?:node:)?(?:${NODE_BUILTINS.map((name) => name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})$`
);
const CONDITIONS = ['workerd', 'worker', 'module', 'browser'];
const EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.cjs', '.cts'];

/**
 * @typedef {{
 *   root: string,
 *   workerFile: string,
 *   configPath?: string,
 *   cloudflareEnv?: string,
 *   persistState: boolean | { path: string },
 *   remoteBindings: boolean,
 *   log: (...args: unknown[]) => void
 * }} DevRuntimeOptions
 */

/**
 * `vite dev` only: not `vite preview`, not `vite build`, and not Vitest (which starts a Vite dev
 * server for unit tests that should not boot workerd).
 * @type {Exclude<import('vite').Plugin['apply'], string | undefined>}
 */
const devOnly = (_config, env) =>
	env.command === 'serve' && env.isPreview !== true && !process.env.VITEST;

/**
 * Vite plugins that own the development runtime. They apply to `vite dev` only.
 * @param {DevRuntimeOptions} options
 * @returns {import('vite').Plugin[]}
 */
export function devRuntimePlugins(options) {
	/** @type {DevRuntime | undefined} */
	let runtime;

	/** @type {import('vite').Plugin} */
	const environmentPlugin = {
		name: 'sveltekit-cloudflare-worker:dev-environment',
		apply: devOnly,
		config(_config, env) {
			return {
				environments: {
					[WORKER_ENVIRONMENT]: workerEnvironmentOptions(options, env.mode)
				}
			};
		}
	};

	/** @type {import('vite').Plugin} */
	const esmEnvPlugin = {
		name: 'sveltekit-cloudflare-worker:dev-esm-env',
		apply: devOnly,
		enforce: 'pre',
		applyToEnvironment: (environment) => environment.name === WORKER_ENVIRONMENT,
		resolveId(id) {
			if (id === 'esm-env') return '\0sveltekit-cloudflare-worker:esm-env';
		},
		load(id) {
			if (id === '\0sveltekit-cloudflare-worker:esm-env') {
				return 'export const BROWSER = false; export const DEV = true; export const NODE = false;';
			}
		}
	};

	/** @type {import('vite').Plugin} */
	const nodeBindingsPlugin = {
		name: 'sveltekit-cloudflare-worker:dev-cloudflare-workers',
		apply: devOnly,
		enforce: 'pre',
		applyToEnvironment: (environment) => environment.name === 'ssr',
		resolveId(id) {
			if (id === 'cloudflare:workers') return NODE_SHIM;
		}
	};

	/** @type {import('vite').Plugin} */
	const serverPlugin = {
		name: 'sveltekit-cloudflare-worker:dev-server',
		apply: devOnly,
		async configureServer(server) {
			const environment = server.environments[WORKER_ENVIRONMENT];
			if (!(environment instanceof WorkerdDevEnvironment)) {
				throw new Error(
					`sveltekit-cloudflare-worker expected the Vite environment "${WORKER_ENVIRONMENT}" to be created by its plugin.`
				);
			}
			runtime = new DevRuntime(options, server, environment);
			await runtime.start();
			for (const file of runtime.watchedFiles()) server.watcher.add(file);
			server.watcher.on('change', (file) => {
				if (runtime?.watchedFiles().includes(path.resolve(file))) {
					server.config.logger.info('Wrangler configuration changed, restarting the dev server.', {
						timestamp: true
					});
					void server.restart();
				}
			});
			if (server.httpServer) handleWebSockets(server.httpServer, () => runtime);

			const close = server.close.bind(server);
			server.close = async () => {
				try {
					await close();
				} finally {
					await runtime?.dispose();
				}
			};

			return () => {
				server.middlewares.use(async function sveltekitCloudflareWorkerMiddleware(req, res, next) {
					if (/** @type {any} */ (req)[kNext]) return next();
					if (!runtime) return next();
					try {
						const response = await runtime.dispatch(req, server);
						await writeResponse(res, response);
					} catch (error) {
						next(error);
					}
				});
			};
		},
		hotUpdate() {
			if (this.environment.name === WORKER_ENVIRONMENT) runtime?.scheduleExportCheck();
		}
	};

	return [environmentPlugin, esmEnvPlugin, nodeBindingsPlugin, serverPlugin];
}

/**
 * `cf` request metadata for SvelteKit's `getRequest` during development.
 * @returns {Record<string, unknown> | undefined}
 */
export function devRequestCf() {
	return /** @type {any} */ (globalThis)[STATE_KEY]?.cf;
}

/**
 * @param {DevRuntimeOptions} options
 * @param {string} mode
 * @returns {import('vite').EnvironmentOptions}
 */
function workerEnvironmentOptions(options, mode) {
	const nodeEnv = process.env.NODE_ENV || mode;
	const builtins = [
		...CLOUDFLARE_BUILTINS,
		...NODE_BUILTINS,
		...NODE_BUILTINS.map((name) => `node:${name}`)
	];
	return {
		consumer: 'server',
		keepProcessEnv: true,
		define: {
			'process.env.NODE_ENV': JSON.stringify(nodeEnv),
			'global.process.env.NODE_ENV': JSON.stringify(nodeEnv),
			'globalThis.process.env.NODE_ENV': JSON.stringify(nodeEnv)
		},
		resolve: {
			noExternal: true,
			conditions: [...CONDITIONS, 'development|production'],
			builtins
		},
		optimizeDeps: {
			noDiscovery: false,
			ignoreOutdatedRequests: true,
			entries: [vite.normalizePath(path.resolve(options.root, options.workerFile))],
			exclude: [...builtins, 'svelte'],
			rolldownOptions: {
				platform: 'neutral',
				resolve: { conditionNames: [...CONDITIONS, 'development'], extensions: EXTENSIONS },
				transform: { target: 'es2024' },
				plugins: [
					vite.esmExternalRequirePlugin({ external: [NODE_BUILTINS_RE], skipDuplicateCheck: true })
				]
			}
		},
		dev: {
			createEnvironment(name, config) {
				return new WorkerdDevEnvironment(name, config);
			}
		}
	};
}

/**
 * A Vite environment whose module runner lives inside workerd and talks to Vite over a
 * WebSocket opened through the Worker.
 */
export class WorkerdDevEnvironment extends vite.DevEnvironment {
	/** @type {{ webSocket?: any, buffer: string[], listening: boolean, onMessage?: (event: any) => void }} */
	#container;

	/** @param {string} name @param {import('vite').ResolvedConfig} config */
	constructor(name, config) {
		/** @type {{ webSocket?: any, buffer: string[], listening: boolean, onMessage?: (event: any) => void }} */
		const container = { buffer: [], listening: false };
		super(name, config, {
			hot: true,
			transport: /** @type {import('vite').HotChannel} */ (
				/** @type {unknown} */ (createHotChannel(container))
			)
		});
		this.#container = container;
	}

	/**
	 * @param {any} miniflare
	 * @param {string} workerName
	 * @param {string} token
	 * @param {Record<string, string>} coreHeaders
	 */
	async connectRunner(miniflare, workerName, token, coreHeaders) {
		const response = await miniflare.dispatchFetch(new URL(INIT_PATH, 'http://localhost'), {
			headers: {
				[coreHeaders.ROUTE_OVERRIDE]: workerName,
				[INIT_TOKEN_HEADER]: token,
				upgrade: 'websocket'
			}
		});
		const webSocket = response.webSocket;
		if (!webSocket) {
			throw new Error(
				`sveltekit-cloudflare-worker could not open the module runner (${response.status}): ${await response.text()}`
			);
		}
		webSocket.accept();
		const container = this.#container;
		if (container.webSocket && container.onMessage) {
			container.webSocket.removeEventListener('message', container.onMessage);
		}
		container.webSocket = webSocket;
		if (container.listening && container.onMessage) {
			webSocket.addEventListener('message', container.onMessage);
		}
		for (const message of container.buffer.splice(0)) webSocket.send(message);
	}
}

/** @param {{ webSocket?: any, buffer: string[], listening: boolean, onMessage?: (event: any) => void }} container */
function createHotChannel(container) {
	/** @type {Map<string, Set<(data: unknown, client: unknown) => void>>} */
	const listeners = new Map();
	const client = {
		/** @param {unknown} payload */
		send(payload) {
			container.webSocket?.send(JSON.stringify(payload));
		}
	};
	container.onMessage = (event) => {
		const payload = JSON.parse(String(event.data));
		for (const listener of listeners.get(payload.event) ?? []) listener(payload.data, client);
	};
	return {
		/** @param {unknown} payload */
		send(payload) {
			const message = JSON.stringify(payload);
			if (!container.webSocket) {
				container.buffer.push(message);
				return;
			}
			container.webSocket.send(message);
		},
		/** @param {string} event @param {(data: unknown, client: unknown) => void} listener */
		on(event, listener) {
			const set = listeners.get(event) ?? new Set();
			set.add(listener);
			listeners.set(event, set);
		},
		/** @param {string} event @param {(data: unknown, client: unknown) => void} listener */
		off(event, listener) {
			listeners.get(event)?.delete(listener);
		},
		listen() {
			container.listening = true;
			if (container.webSocket && container.onMessage) {
				container.webSocket.addEventListener('message', container.onMessage);
			}
		},
		close() {
			container.listening = false;
			if (container.webSocket && container.onMessage) {
				container.webSocket.removeEventListener('message', container.onMessage);
			}
		}
	};
}

/**
 * @typedef {{
 *   miniflare: any,
 *   users: number,
 *   remoteSession: any,
 *   pending: Promise<void>
 * }} SharedRuntime
 */

/** @returns {Map<string, SharedRuntime>} */
function registry() {
	const global = /** @type {any} */ (globalThis);
	return (global[REGISTRY_KEY] ??= new Map());
}

class DevRuntime {
	/** @type {{ handlers: string[], classes: string[] }} */
	exports = { handlers: [], classes: [] };
	token = randomUUID();
	/** @type {any} */
	miniflareModule;
	/** @type {SharedRuntime | undefined} */
	shared;
	/** @type {any} */
	config;
	/** @type {string} */
	workerName = '';
	/** @type {string | undefined} */
	runnerBundle;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	exportTimer;
	/** @type {Promise<void>} */
	ready = Promise.resolve();
	disposed = false;
	warnedShallow = false;
	warnedConnect = false;

	/**
	 * @param {DevRuntimeOptions} options
	 * @param {import('vite').ViteDevServer} server
	 * @param {WorkerdDevEnvironment} environment
	 */
	constructor(options, server, environment) {
		this.options = options;
		this.server = server;
		this.environment = environment;
		this.workerPath = path.resolve(options.root, options.workerFile);
	}

	watchedFiles() {
		if (!this.options.configPath) return [];
		const directory = path.dirname(this.options.configPath);
		const environment = this.options.cloudflareEnv;
		return [
			this.options.configPath,
			path.join(directory, '.dev.vars'),
			path.join(directory, '.env'),
			path.join(directory, '.env.local'),
			...(environment
				? [
						path.join(directory, `.dev.vars.${environment}`),
						path.join(directory, `.env.${environment}`),
						path.join(directory, `.env.${environment}.local`)
					]
				: [])
		].map((file) => path.resolve(file));
	}

	async start() {
		this.ready = this.#start();
		await this.ready;
	}

	async #start() {
		if (!existsSync(this.workerPath)) {
			throw new Error(
				`sveltekit-cloudflare-worker could not find the Worker entry at ${this.options.workerFile}.`
			);
		}
		this.miniflareModule = await loadMiniflare();
		this.exports = await this.#detectExports();
		const key = this.options.root;
		const runtimes = registry();
		let shared = runtimes.get(key);
		if (shared) {
			await shared.pending.catch(() => {});
		} else {
			shared = {
				miniflare: undefined,
				users: 0,
				remoteSession: undefined,
				pending: Promise.resolve()
			};
			runtimes.set(key, shared);
		}
		shared.users += 1;
		this.shared = shared;
		const { MiniflareCoreError } = this.miniflareModule;
		try {
			await this.#apply();
		} catch (error) {
			if (error instanceof MiniflareCoreError) {
				throw new Error(
					`sveltekit-cloudflare-worker could not start workerd: ${/** @type {Error} */ (error).message}`,
					{
						cause: error
					}
				);
			}
			throw error;
		}
	}

	/**
	 * The generated workerd entry must export every class and handler statically. Bundle the Worker
	 * with esbuild to classify its exports; when that bundle fails (for example on Vite-only
	 * imports), fall back to the export names declared by the entry file itself.
	 */
	async #detectExports() {
		try {
			return await detectWorkerExports(this.workerPath, {
				aliases: this.server.config.resolve.alias
			});
		} catch (error) {
			const shallow = await detectWorkerExportsShallow(this.workerPath);
			if (!this.warnedShallow) {
				this.warnedShallow = true;
				this.options.log(
					`Could not bundle ${this.options.workerFile} to classify its exports, using its own export names instead:`,
					error instanceof Error ? error.message : error
				);
			}
			return shallow;
		}
	}

	/** Create or reconfigure Miniflare, connect the module runner and refresh SvelteKit bindings. */
	async #apply() {
		const shared = /** @type {SharedRuntime} */ (this.shared);
		const options = await this.#miniflareOptions();
		if (shared.miniflare) {
			await shared.miniflare.setOptions(options);
		} else {
			shared.miniflare = new this.miniflareModule.Miniflare(options);
		}
		await shared.miniflare.ready;
		await this.environment.connectRunner(
			shared.miniflare,
			this.workerName,
			this.token,
			this.miniflareModule.CoreHeaders
		);
		await this.#refreshBindings();
		if (this.exports.handlers.includes('connect') && !this.warnedConnect) {
			this.warnedConnect = true;
			this.server.config.logger.warn(
				`[sveltekit-cloudflare-worker] ${this.options.workerFile} exports connect(); inbound TCP is not emulated by vite dev. ` +
					'The handler is composed into the production Worker; use wrangler dev on the build output to test it.'
			);
		}
		this.options.log(
			`Worker runtime ready: handlers=[${this.exports.handlers.join(', ')}] classes=[${this.exports.classes.join(', ')}]`
		);
	}

	async #refreshBindings() {
		const shared = /** @type {SharedRuntime} */ (this.shared);
		const bindings = await shared.miniflare.getBindings(this.workerName);
		const env = { ...bindings };
		for (const key of INTERNAL_BINDINGS) delete env[key];
		/** @type {Record<string, unknown> | undefined} */
		let cf;
		try {
			cf = await shared.miniflare.getCf();
		} catch {
			cf = undefined;
		}
		/** @type {any} */ (globalThis)[STATE_KEY] = { env, cf };
	}

	scheduleExportCheck() {
		clearTimeout(this.exportTimer);
		this.exportTimer = setTimeout(() => {
			this.ready = this.ready
				.then(() => this.#checkExports())
				.catch((error) => {
					this.server.config.logger.error(
						`[sveltekit-cloudflare-worker] ${error instanceof Error ? error.message : String(error)}`,
						{ error: error instanceof Error ? error : undefined }
					);
				});
		}, 50);
	}

	async #checkExports() {
		if (this.disposed) return;
		let next;
		try {
			next = await this.#detectExports();
		} catch {
			// A syntax error is reported by Vite's module runner; keep the current Worker shape.
			return;
		}
		if (sameExports(this.exports, next)) return;
		this.exports = next;
		this.server.config.logger.info(
			'Worker exports changed, reloading the workerd runtime (Durable Object state is kept).',
			{ timestamp: true }
		);
		await this.#apply();
	}

	/**
	 * @param {import('node:http').IncomingMessage} req
	 * @param {import('vite').ViteDevServer} server
	 */
	async dispatch(req, server) {
		await this.ready;
		const shared = /** @type {SharedRuntime} */ (this.shared);
		const url = requestUrl(req, server);
		// Wrangler documents these paths for firing `scheduled`; Miniflare 5 serves CorePaths.SCHEDULED.
		const scheduledPath = this.miniflareModule.CorePaths?.SCHEDULED;
		if (
			scheduledPath &&
			(url.pathname === '/cdn-cgi/handler/scheduled' || url.pathname === '/__scheduled')
		) {
			url.pathname = scheduledPath;
		}
		const method = req.method ?? 'GET';
		/** @type {Record<string, any>} */
		const init = {
			method,
			headers: requestHeaders(req),
			redirect: 'manual'
		};
		if (method !== 'GET' && method !== 'HEAD') {
			init.body = req;
			init.duplex = 'half';
		}
		return shared.miniflare.dispatchFetch(url, init);
	}

	/** @param {URL} url @param {import('node:http').IncomingMessage} req */
	async dispatchUpgrade(url, req) {
		await this.ready;
		const shared = /** @type {SharedRuntime} */ (this.shared);
		return {
			response: await shared.miniflare.dispatchFetch(url, {
				method: req.method,
				headers: requestHeaders(req)
			}),
			coupleWebSocket: this.miniflareModule.coupleWebSocket
		};
	}

	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.exportTimer);
		const shared = this.shared;
		if (!shared) return;
		shared.users -= 1;
		if (shared.users > 0) return;
		registry().delete(this.options.root);
		await shared.miniflare?.dispose().catch(() => {});
		await shared.remoteSession?.session?.dispose?.().catch(() => {});
		/** @type {any} */ (globalThis)[STATE_KEY] = undefined;
	}

	async #miniflareOptions() {
		const wrangler = await import('wrangler');
		const { configPath, cloudflareEnv } = this.options;
		const config = wrangler.unstable_readConfig(
			{ config: configPath, env: cloudflareEnv },
			{ hideWarnings: true }
		);
		this.config = config;
		this.workerName = config.name ?? 'sveltekit-cloudflare-worker';
		const shared = /** @type {SharedRuntime} */ (this.shared);

		if (this.options.remoteBindings && configPath) {
			try {
				shared.remoteSession = await wrangler.maybeStartOrUpdateRemoteProxySession(
					{ path: configPath, environment: cloudflareEnv },
					shared.remoteSession ?? null
				);
			} catch (error) {
				this.server.config.logger.warn(
					`[sveltekit-cloudflare-worker] Remote bindings are unavailable: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}

		const { workerOptions, externalWorkers } = wrangler.unstable_getMiniflareWorkerOptions(
			{ ...config, assets: undefined },
			cloudflareEnv,
			{ remoteProxyConnectionString: shared.remoteSession?.session?.remoteProxyConnectionString }
		);

		const assetsBinding = config.assets?.binding;
		const server = this.server;
		const nextHandler = {
			/** @param {any} req @param {any} res */
			node(req, res) {
				req[kNext] = true;
				server.middlewares(req, res);
			}
		};
		const { Response: MiniflareResponse } = this.miniflareModule;
		const environment = this.environment;

		const classes = classifyClasses(config, workerOptions, this.exports.classes, this.workerName);
		this.runnerBundle ??= await bundleRunner();

		const worker = {
			...workerOptions,
			name: this.workerName,
			modulesRoot: MODULES_ROOT,
			modules: [
				{ type: 'ESModule', path: ENTRY_MODULE, contents: this.#entryModule(classes) },
				{ type: 'ESModule', path: RUNNER_MODULE, contents: this.runnerBundle }
			],
			unsafeEvalBinding: EVAL_BINDING,
			serviceBindings: {
				.../** @type {Record<string, unknown>} */ (workerOptions.serviceBindings),
				...(assetsBinding ? { [assetsBinding]: nextHandler } : {}),
				[NEXT_BINDING]: nextHandler,
				/** @param {Request} request */
				[INVOKE_BINDING]: async (request) => {
					const payload = await request.json();
					const result = await environment.hot.handleInvoke(payload);
					return new MiniflareResponse(JSON.stringify(result), {
						headers: { 'content-type': 'application/json' }
					});
				}
			},
			durableObjects: {
				.../** @type {Record<string, unknown>} */ (workerOptions.durableObjects),
				[RUNNER_OBJECT_BINDING]: {
					className: RUNNER_OBJECT_BINDING,
					unsafeUniqueKey: this.miniflareModule.kUnsafeEphemeralUniqueKey,
					unsafePreventEviction: true
				}
			}
		};

		const configDirectory = configPath ? path.dirname(configPath) : this.options.root;
		const { Log, LogLevel, convertV4MiniflareOptions, getDefaultDevRegistryPath } =
			this.miniflareModule;
		return convertV4MiniflareOptions({
			log: new Log(LogLevel.INFO),
			logRequests: false,
			unsafeTriggerHandlers: true,
			unsafeDevRegistryPath: getDefaultDevRegistryPath?.(),
			resourcePersistencePath: persistenceRoot(configDirectory, this.options.persistState),
			resourceTmpPath: path.resolve(configDirectory, '.wrangler/tmp'),
			workers: [worker, ...externalWorkers]
		});
	}

	/** @param {{ durableObjects: string[], workflows: string[], entrypoints: string[] }} classes */
	#entryModule(classes) {
		const runner = JSON.stringify(RUNNER_MODULE);
		const entry = moduleRunnerEntry(this.options.root, this.workerPath);
		const lines = [
			`import { configure, createEntrypoint, createDurableObjectWrapper, createWorkflowWrapper, createWorkerEntrypointWrapper } from ${runner};`,
			`export { ${RUNNER_OBJECT_BINDING} } from ${runner};`,
			`configure(${JSON.stringify({
				entry,
				environment: WORKER_ENVIRONMENT,
				token: this.token,
				nodeBuiltins: NODE_BUILTINS
			})});`,
			`export default createEntrypoint(${JSON.stringify(this.exports.handlers.filter((handler) => handler !== 'connect'))});`
		];
		for (const name of classes.durableObjects) {
			lines.push(`export const ${name} = createDurableObjectWrapper(${JSON.stringify(name)});`);
		}
		for (const name of classes.workflows) {
			lines.push(`export const ${name} = createWorkflowWrapper(${JSON.stringify(name)});`);
		}
		for (const name of classes.entrypoints) {
			lines.push(`export const ${name} = createWorkerEntrypointWrapper(${JSON.stringify(name)});`);
		}
		return lines.join('\n') + '\n';
	}
}

/**
 * Durable Object and Workflow classes come from Wrangler bindings and migrations, so the
 * generated wrappers exist even before `src/worker.ts` exports them. Other exported classes are
 * Worker entrypoints.
 * @param {any} config
 * @param {any} workerOptions
 * @param {string[]} detected
 * @param {string} workerName
 */
function classifyClasses(config, workerOptions, detected, workerName) {
	const durableObjects = new Set();
	for (const value of Object.values(workerOptions.durableObjects ?? {})) {
		const binding = /** @type {{ className?: string, scriptName?: string }} */ (value);
		if (binding.className && (!binding.scriptName || binding.scriptName === workerName)) {
			durableObjects.add(binding.className);
		}
	}
	for (const migration of config.migrations ?? []) {
		for (const key of ['new_classes', 'new_sqlite_classes']) {
			for (const name of migration[key] ?? []) durableObjects.add(name);
		}
		for (const rename of migration.renamed_classes ?? []) durableObjects.add(rename.to);
		for (const name of migration.deleted_classes ?? []) durableObjects.delete(name);
	}
	const workflows = new Set();
	for (const workflow of config.workflows ?? []) {
		if (workflow.class_name && (!workflow.script_name || workflow.script_name === workerName)) {
			workflows.add(workflow.class_name);
		}
	}
	const entrypoints = detected.filter((name) => !durableObjects.has(name) && !workflows.has(name));
	return {
		durableObjects: [...durableObjects].filter(isIdentifier),
		workflows: [...workflows].filter((name) => isIdentifier(name) && !durableObjects.has(name)),
		entrypoints: entrypoints.filter(isIdentifier)
	};
}

/** @param {string} name */
function isIdentifier(name) {
	return /^[A-Za-z_$][\w$]*$/.test(name) && name !== RUNNER_OBJECT_BINDING;
}

/** @param {string} root @param {string} workerPath */
function moduleRunnerEntry(root, workerPath) {
	const relative = path.relative(root, workerPath);
	if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
		return '/' + vite.normalizePath(relative);
	}
	return '/@fs' + vite.normalizePath(workerPath);
}

/** @param {string} directory @param {boolean | { path: string }} persistState */
function persistenceRoot(directory, persistState) {
	if (persistState === false) return undefined;
	const base = typeof persistState === 'object' ? persistState.path : '.wrangler/state';
	return path.resolve(directory, base, 'v3');
}

/** @param {{ handlers: string[], classes: string[] }} left @param {{ handlers: string[], classes: string[] }} right */
function sameExports(left, right) {
	return (
		left.handlers.join(',') === right.handlers.join(',') &&
		left.classes.join(',') === right.classes.join(',')
	);
}

/** Load the Miniflare build that the installed Wrangler uses, so their option shapes match. */
async function loadMiniflare() {
	const require = createRequire(import.meta.url);
	const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
	return import(pathToFileURL(wranglerRequire.resolve('miniflare')).href);
}

async function bundleRunner() {
	const { build } = await import('esbuild');
	const moduleRunner = fileURLToPath(import.meta.resolve('vite/module-runner'));
	const result = await build({
		entryPoints: [RUNNER_SOURCE],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		external: ['cloudflare:*'],
		alias: { 'vite/module-runner': moduleRunner },
		logLevel: 'silent'
	});
	const output = result.outputFiles[0];
	if (!output) throw new Error('sveltekit-cloudflare-worker could not bundle its workerd runner.');
	return output.text;
}

/** @param {import('node:http').IncomingMessage} req @param {import('vite').ViteDevServer} server */
function requestUrl(req, server) {
	const host = req.headers[':authority'] ?? req.headers.host ?? 'localhost';
	const protocol = server.config.server.https ? 'https' : 'http';
	const original = /** @type {any} */ (req).originalUrl ?? req.url ?? '/';
	return new URL(original, `${protocol}://${host}`);
}

/** @param {import('node:http').IncomingMessage} req */
function requestHeaders(req) {
	/** @type {[string, string][]} */
	const headers = [];
	for (const [name, value] of Object.entries(req.headers)) {
		if (name.startsWith(':') || value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.push([name, item]);
		} else {
			headers.push([name, value]);
		}
	}
	return headers;
}

/** @param {import('node:http').ServerResponse} res @param {any} response */
async function writeResponse(res, response) {
	/** @type {Record<string, string | string[]>} */
	const headers = {};
	response.headers.forEach((/** @type {string} */ value, /** @type {string} */ name) => {
		if (name === 'set-cookie') return;
		headers[name] = value;
	});
	const cookies = response.headers.getSetCookie?.() ?? [];
	if (cookies.length > 0) headers['set-cookie'] = cookies;
	res.writeHead(response.status, response.statusText || undefined, headers);
	if (!response.body) {
		res.end();
		return;
	}
	const reader = response.body.getReader();
	res.on('close', () => {
		reader.cancel().catch(() => {});
	});
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!res.write(value)) {
				await new Promise((resolve) => res.once('drain', resolve));
			}
		}
	} finally {
		res.end();
	}
}

/**
 * Forward WebSocket upgrades (other than Vite's own HMR socket) to the Worker.
 * @param {import('node:http').Server | import('node:http2').Http2SecureServer} httpServer
 * @param {() => DevRuntime | undefined} getRuntime
 */
function handleWebSockets(httpServer, getRuntime) {
	const webSocketServer = new WebSocketServer({ noServer: true });
	httpServer.on('upgrade', async (req, socket, head) => {
		socket.on('error', () => socket.destroy());
		if (req.headers['sec-websocket-protocol']?.startsWith('vite')) return;
		const runtime = getRuntime();
		if (!runtime) {
			socket.destroy();
			return;
		}
		try {
			const host = req.headers.host ?? 'localhost';
			const protocol = 'encrypted' in socket && socket.encrypted ? 'https' : 'http';
			const url = new URL(req.url ?? '/', `${protocol}://${host}`);
			const { response, coupleWebSocket } = await runtime.dispatchUpgrade(url, req);
			const workerWebSocket = response.webSocket;
			if (!workerWebSocket) {
				const body = await response.text().catch(() => '');
				socket.end(
					`HTTP/1.1 ${response.status} ${response.statusText || 'Error'}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${body}`
				);
				return;
			}
			if (socket.destroyed) return;
			webSocketServer.handleUpgrade(req, socket, head, (client) => {
				void coupleWebSocket(client, workerWebSocket);
				webSocketServer.emit('connection', client, req);
			});
		} catch {
			socket.destroy();
		}
	});
}

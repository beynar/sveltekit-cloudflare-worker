// `vite dev` runtime: one Miniflare instance per project root runs `src/worker.ts` in workerd
// through Vite's module runner (HMR), and exposes the same bindings to SvelteKit's Node SSR
// through `cloudflare:workers`.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setResponse } from '@sveltejs/kit/node';
import * as vite from 'vite';
import * as wrangler from 'wrangler';
import { WebSocketServer } from 'ws';
import {
	EVAL_BINDING,
	INIT_PATH,
	INIT_TOKEN_HEADER,
	INTERNAL_BINDINGS,
	INVOKE_BINDING,
	NEXT_BINDING,
	RUNNER_OBJECT_BINDING,
	WASM_GLOBAL,
	WORKER_ENVIRONMENT
} from '../constants.js';
import { LOG_PREFIX, readWranglerConfig } from '../project.js';
import { detectWorkerExports, detectWorkerExportsShallow } from '../worker-composition.js';

const STATE_KEY = Symbol.for('sveltekit-cloudflare-worker.dev-state');
const REGISTRY_KEY = Symbol.for('sveltekit-cloudflare-worker.dev-runtimes');
const kNext = Symbol.for('sveltekit-cloudflare-worker.next');
const MODULES_ROOT = process.platform === 'win32' ? 'Z:\\' : '/';
const ENTRY_MODULE = path.join(MODULES_ROOT, '__sveltekit_cloudflare_worker', 'entry.js');
const RUNNER_MODULE = path.join(MODULES_ROOT, '__sveltekit_cloudflare_worker', 'runner.js');

const NODE_BUILTINS = builtinModules.filter((name) => !name.startsWith('_'));
const BUILTINS = [
	...['email', 'node', 'sockets', 'workers', 'workflows'].map((name) => `cloudflare:${name}`),
	...NODE_BUILTINS,
	...NODE_BUILTINS.map((name) => `node:${name}`)
];
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
 * `vite dev` only: not `vite preview`, not `vite build`, and not Vitest, whose Vite server runs
 * unit tests that must not boot workerd.
 * @type {Exclude<import('vite').Plugin['apply'], string | undefined>}
 */
const devOnly = (_config, env) => env.command === 'serve' && !env.isPreview && !process.env.VITEST;

/**
 * @param {DevRuntimeOptions} options
 * @returns {import('vite').Plugin[]}
 */
export function devRuntimePlugins(options) {
	/** @type {DevRuntime | undefined} */
	let runtime;

	return [
		{
			name: 'sveltekit-cloudflare-worker:dev-environment',
			apply: devOnly,
			config: (_config, env) => ({
				environments: { [WORKER_ENVIRONMENT]: workerEnvironmentOptions(options, env.mode) },
				// Local state (D1, R2, Durable Objects, sent emails) changes on every request.
				server: { watch: { ignored: ['**/.wrangler/**'] } }
			})
		},
		{
			// `import module from './x.wasm'` is a CompiledWasm module on Cloudflare: its default export
			// is a WebAssembly.Module. workerd forbids compiling WebAssembly at run time, so the runner
			// builds the module through the unsafe-eval binding (see runner-worker.js).
			name: 'sveltekit-cloudflare-worker:dev-wasm',
			apply: devOnly,
			enforce: 'pre',
			applyToEnvironment: (environment) => environment.name === WORKER_ENVIRONMENT,
			load(id) {
				const [file, query] = id.split('?');
				if (!file.endsWith('.wasm') || (query !== undefined && query !== 'module')) return;
				this.addWatchFile(file);
				const base64 = readFileSync(file).toString('base64');
				return `export default globalThis.${WASM_GLOBAL}(${JSON.stringify(base64)});`;
			}
		},
		{
			// esm-env would pick its `browser` build from the Worker conditions.
			name: 'sveltekit-cloudflare-worker:dev-esm-env',
			apply: devOnly,
			enforce: 'pre',
			applyToEnvironment: (environment) => environment.name === WORKER_ENVIRONMENT,
			resolveId: (id) => (id === 'esm-env' ? '\0esm-env' : undefined),
			load: (id) =>
				id === '\0esm-env'
					? 'export const BROWSER = false; export const DEV = true; export const NODE = false;'
					: undefined
		},
		{
			name: 'sveltekit-cloudflare-worker:dev-cloudflare-workers',
			apply: devOnly,
			enforce: 'pre',
			applyToEnvironment: (environment) => environment.name === 'ssr',
			resolveId: (id) =>
				id === 'cloudflare:workers'
					? fileURLToPath(new URL('./cloudflare-workers-node.js', import.meta.url))
					: undefined
		},
		{
			name: 'sveltekit-cloudflare-worker:dev-server',
			apply: devOnly,
			async configureServer(server) {
				const current = new DevRuntime(options, server);
				runtime = current;
				await current.start();

				const watched = current.watchedFiles();
				server.watcher.add(watched);
				server.watcher.on('change', (file) => {
					if (!watched.includes(path.resolve(file))) return;
					server.config.logger.info('Wrangler configuration changed, restarting the dev server.', {
						timestamp: true
					});
					void server.restart();
				});
				server.httpServer?.on('upgrade', (req, socket, head) => {
					// Vite's HMR socket is handled by Vite.
					if (!req.headers['sec-websocket-protocol']?.startsWith('vite')) {
						void current.upgrade(req, socket, head);
					}
				});
				const close = server.close.bind(server);
				server.close = async () => {
					try {
						await close();
					} finally {
						await current.dispose();
					}
				};

				// After Vite's own middlewares, before SvelteKit's.
				return () => {
					server.middlewares.use(async function sveltekitCloudflareWorker(req, res, next) {
						if (/** @type {any} */ (req)[kNext]) return next();
						try {
							await setResponse(res, await current.dispatch(req));
						} catch (error) {
							next(error);
						}
					});
				};
			},
			hotUpdate() {
				if (this.environment.name === WORKER_ENVIRONMENT) runtime?.scheduleExportCheck();
			}
		}
	];
}

/** `cf` request metadata for SvelteKit's dev requests. */
export function devRequestCf() {
	return /** @type {any} */ (globalThis)[STATE_KEY]?.cf;
}

/**
 * @param {DevRuntimeOptions} options
 * @param {string} mode
 * @returns {import('vite').EnvironmentOptions}
 */
function workerEnvironmentOptions(options, mode) {
	const nodeEnv = JSON.stringify(process.env.NODE_ENV || mode);
	return {
		consumer: 'server',
		keepProcessEnv: true,
		define: {
			'process.env.NODE_ENV': nodeEnv,
			'global.process.env.NODE_ENV': nodeEnv,
			'globalThis.process.env.NODE_ENV': nodeEnv
		},
		resolve: {
			noExternal: true,
			conditions: [...CONDITIONS, 'development|production'],
			builtins: BUILTINS
		},
		optimizeDeps: {
			noDiscovery: false,
			ignoreOutdatedRequests: true,
			entries: [vite.normalizePath(path.resolve(options.root, options.workerFile))],
			exclude: [...BUILTINS, 'svelte'],
			rolldownOptions: {
				platform: 'neutral',
				resolve: { conditionNames: [...CONDITIONS, 'development'], extensions: EXTENSIONS },
				transform: { target: 'es2024' },
				plugins: [
					vite.esmExternalRequirePlugin({
						external: [new RegExp(`^(?:node:)?(?:${NODE_BUILTINS.join('|')})$`)],
						skipDuplicateCheck: true
					})
				]
			}
		},
		dev: {
			createEnvironment: (name, config) => new WorkerdDevEnvironment(name, config)
		}
	};
}

/**
 * A Vite environment whose module runner lives in workerd. Its hot channel is a WebSocket that
 * the runner Durable Object opens through the Worker (see `DevRuntime#apply`).
 */
class WorkerdDevEnvironment extends vite.DevEnvironment {
	/** @param {string} name @param {import('vite').ResolvedConfig} config */
	constructor(name, config) {
		const channel = createHotChannel();
		super(name, config, { hot: true, transport: /** @type {any} */ (channel) });
		this.channel = channel;
	}
}

function createHotChannel() {
	/** @type {any} */
	let webSocket;
	/** @type {string[]} */
	const queued = [];
	/** @type {Map<string, Set<(data: unknown, client: unknown) => void>>} */
	const listeners = new Map();
	const client = {
		send: (/** @type {unknown} */ payload) => webSocket.send(JSON.stringify(payload))
	};
	const onMessage = (/** @type {{ data: unknown }} */ event) => {
		const { event: name, data } = JSON.parse(String(event.data));
		for (const listener of listeners.get(name) ?? []) listener(data, client);
	};
	return {
		// Server environments are trusted: like Vite's own SSR channel, skip the `server.fs.allow`
		// check that protects the browser (SvelteKit narrows it to src/ and a few folders).
		skipFsCheck: true,
		/** @param {any} next */
		attach(next) {
			webSocket?.removeEventListener('message', onMessage);
			webSocket = next;
			webSocket.addEventListener('message', onMessage);
			for (const message of queued.splice(0)) webSocket.send(message);
		},
		/** @param {unknown} payload */
		send(payload) {
			if (webSocket) webSocket.send(JSON.stringify(payload));
			else queued.push(JSON.stringify(payload));
		},
		/** @param {string} event @param {(data: unknown, client: unknown) => void} listener */
		on(event, listener) {
			listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
		},
		/** @param {string} event @param {(data: unknown, client: unknown) => void} listener */
		off(event, listener) {
			listeners.get(event)?.delete(listener);
		},
		listen() {},
		close() {
			webSocket?.removeEventListener('message', onMessage);
		}
	};
}

/**
 * One Miniflare per project root, shared by the servers that `server.restart()` creates before
 * closing the previous one.
 * @typedef {{ miniflare?: any, remoteSession?: any, users: number }} SharedRuntime
 * @returns {Map<string, SharedRuntime>}
 */
function registry() {
	const global = /** @type {any} */ (globalThis);
	return (global[REGISTRY_KEY] ??= new Map());
}

/** Load the Miniflare build that Wrangler uses, so its option shapes match Wrangler's output. */
async function loadMiniflare() {
	const wranglerRequire = createRequire(
		createRequire(import.meta.url).resolve('wrangler/package.json')
	);
	return import(pathToFileURL(wranglerRequire.resolve('miniflare')).href);
}

class DevRuntime {
	/** @type {{ handlers: string[], classes: string[] }} */
	exports = { handlers: [], classes: [] };
	token = randomUUID();
	workerName = '';
	/** @type {any} */
	miniflareModule;
	/** @type {string | undefined} */
	runnerBundle;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	exportTimer;
	ready = Promise.resolve();
	disposed = false;
	/** @type {WebSocketServer | undefined} */
	webSocketServer;

	/** @param {DevRuntimeOptions} options @param {import('vite').ViteDevServer} server */
	constructor(options, server) {
		this.options = options;
		this.server = server;
		this.environment = /** @type {WorkerdDevEnvironment} */ (
			server.environments[WORKER_ENVIRONMENT]
		);
		this.workerPath = path.resolve(options.root, options.workerFile);
		const runtimes = registry();
		this.shared = runtimes.get(options.root) ?? { users: 0 };
		this.shared.users += 1;
		runtimes.set(options.root, this.shared);
	}

	/** The Wrangler config and the files Wrangler reads vars and secrets from. */
	watchedFiles() {
		const { configPath, cloudflareEnv } = this.options;
		if (!configPath) return [];
		const directory = path.dirname(configPath);
		const suffixes = cloudflareEnv ? ['', `.${cloudflareEnv}`] : [''];
		return [
			configPath,
			...suffixes.flatMap((suffix) => [
				`.dev.vars${suffix}`,
				`.env${suffix}`,
				`.env${suffix}.local`
			])
		].map((file) => path.resolve(directory, file));
	}

	start() {
		this.ready = (async () => {
			this.miniflareModule = await loadMiniflare();
			this.exports = await this.#detectExports();
			await this.#apply();
		})();
		return this.ready;
	}

	/**
	 * The generated entry must export every class and handler statically. Classify them from the
	 * esbuild bundle, or from the entry's own export names when the bundle fails (Vite-only imports).
	 */
	async #detectExports() {
		try {
			return await detectWorkerExports(this.workerPath, this.server.config.resolve.alias);
		} catch (error) {
			this.options.log('Classifying Worker exports from the entry file only:', error);
			return detectWorkerExportsShallow(this.workerPath);
		}
	}

	/** Create or reconfigure Miniflare, reconnect the module runner and refresh SvelteKit's env. */
	async #apply() {
		const options = await this.#miniflareOptions();
		const shared = this.shared;
		if (shared.miniflare) await shared.miniflare.setOptions(options);
		else shared.miniflare = new this.miniflareModule.Miniflare(options);
		await shared.miniflare.ready;
		const { webSocket } = await shared.miniflare.dispatchFetch(
			new URL(INIT_PATH, 'http://localhost'),
			{
				headers: {
					[this.miniflareModule.CoreHeaders.ROUTE_OVERRIDE]: this.workerName,
					[INIT_TOKEN_HEADER]: this.token,
					upgrade: 'websocket'
				}
			}
		);
		webSocket.accept();
		this.environment.channel.attach(webSocket);

		const env = { ...(await shared.miniflare.getBindings(this.workerName)) };
		for (const key of INTERNAL_BINDINGS) delete env[key];
		/** @type {any} */ (globalThis)[STATE_KEY] = { env, cf: await shared.miniflare.getCf() };

		if (this.exports.handlers.includes('connect')) {
			this.server.config.logger.warn(
				`${LOG_PREFIX} ${this.options.workerFile} exports connect(); vite dev does not emulate inbound TCP. ` +
					'Use wrangler dev on the build output to test it.'
			);
		}
		this.options.log(
			`Worker runtime ready: handlers=[${this.exports.handlers}] classes=[${this.exports.classes}]`
		);
	}

	scheduleExportCheck() {
		clearTimeout(this.exportTimer);
		this.exportTimer = setTimeout(() => {
			this.ready = this.ready
				.then(() => this.#checkExports())
				.catch((error) => this.server.config.logger.error(`${LOG_PREFIX} ${error}`, { error }));
		}, 50);
	}

	async #checkExports() {
		if (this.disposed) return;
		const next = await this.#detectExports();
		if (JSON.stringify(next) === JSON.stringify(this.exports)) return;
		this.exports = next;
		this.server.config.logger.info(
			'Worker exports changed, reloading the workerd runtime (Durable Object state is kept).',
			{ timestamp: true }
		);
		await this.#apply();
	}

	/** @param {import('node:http').IncomingMessage} req */
	async dispatch(req) {
		await this.ready;
		const protocol = this.server.config.server.https ? 'https' : 'http';
		const url = new URL(
			/** @type {any} */ (req).originalUrl ?? req.url,
			`${protocol}://${req.headers.host ?? req.headers[':authority']}`
		);
		// Wrangler's documented trigger paths; Miniflare 5 serves them under CorePaths.
		const { SCHEDULED, EMAIL } = this.miniflareModule.CorePaths;
		const trigger = {
			'/__scheduled': SCHEDULED,
			'/cdn-cgi/handler/scheduled': SCHEDULED,
			'/cdn-cgi/handler/email': EMAIL
		}[url.pathname];
		if (trigger) url.pathname = trigger;
		const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
		return this.shared.miniflare.dispatchFetch(url, {
			method: req.method,
			headers: Object.entries(req.headers).filter(([name]) => !name.startsWith(':')),
			redirect: 'manual',
			...(hasBody ? { body: req, duplex: 'half' } : {})
		});
	}

	/**
	 * Forward a WebSocket upgrade to the Worker and couple both sockets.
	 * @param {import('node:http').IncomingMessage} req
	 * @param {import('node:stream').Duplex} socket
	 * @param {Buffer} head
	 */
	async upgrade(req, socket, head) {
		socket.on('error', () => socket.destroy());
		try {
			const response = await this.dispatch(req);
			if (!response.webSocket) {
				socket.end(
					`HTTP/1.1 ${response.status} ${response.statusText}\r\nConnection: close\r\n\r\n${await response.text()}`
				);
				return;
			}
			this.webSocketServer ??= new WebSocketServer({ noServer: true });
			this.webSocketServer.handleUpgrade(req, socket, head, (client) => {
				void this.miniflareModule.coupleWebSocket(client, response.webSocket);
			});
		} catch {
			socket.destroy();
		}
	}

	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.exportTimer);
		this.shared.users -= 1;
		if (this.shared.users > 0) return;
		registry().delete(this.options.root);
		await this.shared.miniflare?.dispose();
		await this.shared.remoteSession?.session.dispose();
		/** @type {any} */ (globalThis)[STATE_KEY] = undefined;
	}

	async #miniflareOptions() {
		const { configPath, cloudflareEnv, remoteBindings, persistState, root } = this.options;
		const config = readWranglerConfig(configPath, cloudflareEnv);
		this.workerName = config.name ?? 'sveltekit-cloudflare-worker';

		if (remoteBindings && configPath) {
			try {
				this.shared.remoteSession = await wrangler.maybeStartOrUpdateRemoteProxySession(
					{ path: configPath, environment: cloudflareEnv },
					this.shared.remoteSession ?? null
				);
			} catch (error) {
				this.server.config.logger.warn(`${LOG_PREFIX} Remote bindings are unavailable: ${error}`);
			}
		}
		/** @type {{ workerOptions: any, externalWorkers: any[] }} */
		const { workerOptions, externalWorkers } = wrangler.unstable_getMiniflareWorkerOptions(
			{ ...config, assets: undefined },
			cloudflareEnv,
			{
				remoteProxyConnectionString: this.shared.remoteSession?.session.remoteProxyConnectionString
			}
		);

		const server = this.server;
		const environment = this.environment;
		const mf = this.miniflareModule;
		// `next()` and the assets binding go back through Vite's middlewares, which skip the Worker.
		const toVite = {
			/** @param {any} req @param {any} res */
			node(req, res) {
				req[kNext] = true;
				server.middlewares(req, res);
			}
		};
		this.runnerBundle ??= await bundleRunner();

		const worker = {
			...workerOptions,
			name: this.workerName,
			modulesRoot: MODULES_ROOT,
			modules: [
				{
					type: 'ESModule',
					path: ENTRY_MODULE,
					contents: this.#entryModule(config, workerOptions)
				},
				{ type: 'ESModule', path: RUNNER_MODULE, contents: this.runnerBundle }
			],
			unsafeEvalBinding: EVAL_BINDING,
			serviceBindings: {
				...workerOptions.serviceBindings,
				...(config.assets?.binding ? { [config.assets.binding]: toVite } : {}),
				[NEXT_BINDING]: toVite,
				/** @param {Request} request */
				[INVOKE_BINDING]: async (request) =>
					new mf.Response(JSON.stringify(await environment.hot.handleInvoke(await request.json())))
			},
			durableObjects: {
				...workerOptions.durableObjects,
				[RUNNER_OBJECT_BINDING]: {
					className: RUNNER_OBJECT_BINDING,
					unsafeUniqueKey: mf.kUnsafeEphemeralUniqueKey,
					unsafePreventEviction: true
				}
			}
		};

		const directory = configPath ? path.dirname(configPath) : root;
		return mf.convertV4MiniflareOptions({
			log: new mf.Log(mf.LogLevel.INFO),
			logRequests: false,
			unsafeTriggerHandlers: true,
			unsafeDevRegistryPath: mf.getDefaultDevRegistryPath(),
			resourcePersistencePath:
				persistState === false
					? undefined
					: path.resolve(
							directory,
							persistState === true ? '.wrangler/state' : persistState.path,
							'v3'
						),
			resourceTmpPath: path.resolve(directory, '.wrangler/tmp'),
			workers: [worker, ...externalWorkers]
		});
	}

	/**
	 * Durable Object and Workflow wrappers come from the Wrangler config (bindings and migrations),
	 * so they exist even before `src/worker.ts` exports the classes. Other exported classes are
	 * Worker entrypoints.
	 * @param {any} config
	 * @param {any} workerOptions
	 */
	#entryModule(config, workerOptions) {
		/** @param {{ scriptName?: string }} binding */
		const ownScript = (binding) => !binding.scriptName || binding.scriptName === this.workerName;
		const durableObjects = new Set(
			Object.values(workerOptions.durableObjects ?? {})
				.filter(ownScript)
				.map((binding) => binding.className)
		);
		for (const migration of config.migrations) {
			for (const name of [
				...(migration.new_classes ?? []),
				...(migration.new_sqlite_classes ?? [])
			]) {
				durableObjects.add(name);
			}
			for (const { to } of migration.renamed_classes ?? []) durableObjects.add(to);
			for (const name of migration.deleted_classes ?? []) durableObjects.delete(name);
		}
		const workflows = config.workflows
			.filter((/** @type {any} */ workflow) => ownScript({ scriptName: workflow.script_name }))
			.map((/** @type {any} */ workflow) => workflow.class_name)
			.filter((/** @type {string} */ name) => !durableObjects.has(name));
		const wrappers = [
			...[...durableObjects].map((name) => [name, 'createDurableObjectWrapper']),
			...workflows.map((/** @type {string} */ name) => [name, 'createWorkflowWrapper']),
			...this.exports.classes
				.filter((name) => !durableObjects.has(name) && !workflows.includes(name))
				.map((name) => [name, 'createWorkerEntrypointWrapper'])
		];

		const runner = JSON.stringify(RUNNER_MODULE);
		const settings = {
			entry: moduleRunnerEntry(this.options.root, this.workerPath),
			token: this.token,
			nodeBuiltins: NODE_BUILTINS
		};
		const handlers = this.exports.handlers.filter((handler) => handler !== 'connect');
		return [
			`import * as runner from ${runner};`,
			`export { ${RUNNER_OBJECT_BINDING} } from ${runner};`,
			`runner.configure(${JSON.stringify(settings)});`,
			`export default runner.createEntrypoint(${JSON.stringify(handlers)});`,
			...wrappers.map(
				([name, factory]) => `export const ${name} = runner.${factory}(${JSON.stringify(name)});`
			),
			''
		].join('\n');
	}
}

/**
 * The module-runner URL of the Worker entry: root-relative, or `/@fs` outside the root.
 * @param {string} root
 * @param {string} workerPath
 */
function moduleRunnerEntry(root, workerPath) {
	const relative = path.relative(root, workerPath);
	return relative.startsWith('..') || path.isAbsolute(relative)
		? `/@fs${vite.normalizePath(workerPath)}`
		: `/${vite.normalizePath(relative)}`;
}

async function bundleRunner() {
	const { build } = await import('esbuild');
	const result = await build({
		entryPoints: [fileURLToPath(new URL('./runner-worker.js', import.meta.url))],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		external: ['cloudflare:*'],
		alias: { 'vite/module-runner': fileURLToPath(import.meta.resolve('vite/module-runner')) },
		logLevel: 'silent'
	});
	return result.outputFiles[0].text;
}

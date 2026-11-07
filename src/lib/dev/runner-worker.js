// This module runs inside workerd during `vite dev`. It is bundled together with
// `vite/module-runner` when the development server starts.
//
// Vite's ModuleRunner loads `src/worker.ts` (and everything it imports) from the Vite
// `cloudflare_worker` environment, so edits are applied through HMR without restarting
// workerd. Module evaluation happens inside a singleton Durable Object so promises created
// while evaluating modules can be awaited from any request.
import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from 'cloudflare:workers';
import { ModuleRunner, ssrDynamicImportKey, ssrModuleExportsKey } from 'vite/module-runner';
import { __sveltekitCloudflareWorkerWaitUntilLast as wrapWaitUntilLast } from '../wait-until-last.js';
import {
	EVAL_BINDING,
	INIT_PATH,
	INIT_TOKEN_HEADER,
	INTERNAL_BINDINGS,
	INVOKE_BINDING,
	NEXT_BINDING,
	RUNNER_OBJECT_BINDING
} from './constants.js';

/** @type {{ entry: string, environment: string, token: string, nodeBuiltins: string[] }} */
const settings = { entry: '', environment: '', token: '', nodeBuiltins: [] };

/** @param {Partial<typeof settings>} value */
export function configure(value) {
	Object.assign(settings, value);
}

/** @type {ModuleRunner | undefined} */
let moduleRunner;
let nextCallbackId = 0;
/** @type {Map<number, () => unknown>} */
const pendingCallbacks = new Map();
/** @type {Map<number, unknown>} */
const callbackResults = new Map();
/** @type {WeakMap<object, Record<string, unknown>>} */
const userEnvironments = new WeakMap();

/**
 * Remove the package's internal bindings from a Worker `env`.
 * The same input object always produces the same output object.
 * @param {Record<string, unknown>} env
 */
function userEnv(env) {
	let result = userEnvironments.get(env);
	if (!result) {
		result = { ...env };
		for (const key of INTERNAL_BINDINGS) delete result[key];
		userEnvironments.set(env, result);
	}
	return result;
}

/**
 * Run `callback` inside the runner Durable Object's I/O context.
 * @template T
 * @param {any} env
 * @param {() => T | Promise<T>} callback
 * @returns {Promise<T>}
 */
async function runInRunnerObject(env, callback) {
	const id = nextCallbackId++;
	pendingCallbacks.set(id, callback);
	try {
		await env[RUNNER_OBJECT_BINDING].get('singleton').executeCallback(id);
		return /** @type {T} */ (callbackResults.get(id));
	} finally {
		pendingCallbacks.delete(id);
		callbackResults.delete(id);
	}
}

/** @type {any} The entry module node of the last successful import. */
let evaluatedEntry;

/**
 * Return the evaluated `src/worker.ts` module.
 *
 * `ModuleRunner.import()` always asks Vite (in Node) whether the module is still fresh. That
 * round trip must be avoided when the module is already evaluated: SvelteKit reaches Durable
 * Objects through Miniflare's binding proxy, which blocks the Node main thread on synchronous
 * property reads. A Durable Object that called back into Node at that moment would deadlock.
 * HMR invalidation clears the node's `meta`, which sends the next call through Vite again.
 *
 * @param {any} env
 * @returns {Promise<Record<string, any>>}
 */
async function importWorkerModule(env) {
	const node = moduleRunner?.evaluatedModules.getModuleByUrl(settings.entry);
	if (node && node === evaluatedEntry && node.evaluated && node.meta && node.exports) {
		return node.exports;
	}
	const exports = await runInRunnerObject(env, () => {
		if (!moduleRunner) {
			throw new Error(
				'sveltekit-cloudflare-worker: the Vite module runner is not initialized yet.'
			);
		}
		return moduleRunner.import(settings.entry);
	});
	evaluatedEntry = moduleRunner?.evaluatedModules.getModuleByUrl(settings.entry);
	return exports;
}

export class __SVELTEKIT_CF_RUNNER__ extends DurableObject {
	/** @type {WebSocket | undefined} */
	#webSocket;

	/** @param {Request} request */
	async fetch(request) {
		const { 0: client, 1: server } = new WebSocketPair();
		server.accept();
		this.#webSocket?.close();
		this.#webSocket = server;
		moduleRunner?.close().catch(() => {});
		moduleRunner = createModuleRunner(this.env, server);
		void request;
		return new Response(null, { status: 101, webSocket: client });
	}

	/** @param {string} data */
	send(data) {
		if (!this.#webSocket) throw new Error('The Vite module runner WebSocket is not open.');
		this.#webSocket.send(data);
	}

	/** @param {number} id */
	async executeCallback(id) {
		const callback = pendingCallbacks.get(id);
		if (!callback) throw new Error(`No pending module-runner callback with id ${id}.`);
		callbackResults.set(id, await callback());
	}
}

/** @param {any} env @param {WebSocket} webSocket */
function createModuleRunner(env, webSocket) {
	return new ModuleRunner(
		{
			sourcemapInterceptor: 'prepareStackTrace',
			transport: {
				connect({ onMessage }) {
					webSocket.addEventListener('message', ({ data }) => {
						onMessage(JSON.parse(String(data)));
					});
				},
				disconnect() {
					webSocket.close();
				},
				send(data) {
					env[RUNNER_OBJECT_BINDING].get('singleton').send(JSON.stringify(data));
				},
				async invoke(data) {
					let lastError;
					for (let attempt = 0; attempt < 3; attempt++) {
						try {
							const response = await env[INVOKE_BINDING].fetch('http://localhost/', {
								method: 'POST',
								body: JSON.stringify(data)
							});
							return await response.json();
						} catch (error) {
							lastError = error;
						}
					}
					throw lastError;
				}
			},
			hmr: true
		},
		{
			async runInlinedModule(context, transformed, module) {
				const originalDynamicImport = context[ssrDynamicImportKey];
				context[ssrDynamicImportKey] = (/** @type {string} */ dependency) =>
					runInRunnerObject(env, () => originalDynamicImport(dependency));
				const code = `"use strict";async (${Object.keys(context).join(',')})=>{${transformed}\n}`;
				await env[EVAL_BINDING].eval(code, module.id)(...Object.values(context));
				Object.seal(context[ssrModuleExportsKey]);
			},
			async runExternalModule(file) {
				if (file === 'cloudflare:workers') {
					const workers = await import('cloudflare:workers');
					return Object.seal({ ...workers, env: userEnv(/** @type {any} */ (workers.env)) });
				}
				if (settings.nodeBuiltins.includes(file)) return import(`node:${file}`);
				if (file.startsWith('node:') || file.startsWith('cloudflare:')) return import(file);
				throw new Error(
					`sveltekit-cloudflare-worker cannot load the external module "${file}" inside workerd. ` +
						'Only node:* and cloudflare:* built-ins can stay external in the Worker environment.'
				);
			}
		}
	);
}

/** @param {unknown} error */
function reduceError(error) {
	const value =
		/** @type {{ name?: string, message?: string, stack?: string, cause?: unknown }} */ (
			error ?? {}
		);
	/** @type {Record<string, unknown>} */
	const reduced = {
		name: value.name,
		message: value.message ?? String(error),
		stack: value.stack
	};
	if (value.cause !== undefined) reduced.cause = reduceError(value.cause);
	return reduced;
}

/** @param {unknown} error */
function errorResponse(error) {
	return Response.json(reduceError(error), {
		status: 500,
		headers: { 'MF-Experimental-Error-Stack': 'true' }
	});
}

/** @param {Record<string, any>} module @param {string} name @param {'function'} kind */
function requireExport(module, name, kind) {
	const value = module[name];
	if (typeof value !== kind) {
		throw new TypeError(
			`${settings.entry} must export ${kind === 'function' ? `a "${name}" function or class` : `"${name}"`}.`
		);
	}
	return value;
}

/**
 * The generated default entrypoint. `fetch` composes `src/worker.ts` around SvelteKit; other
 * handlers delegate directly to the matching named export.
 * @param {string[]} handlers
 */
export function createEntrypoint(handlers) {
	class Entrypoint extends WorkerEntrypoint {
		/** @param {Request} request */
		async fetch(request) {
			const env = /** @type {any} */ (this.env);
			const url = new URL(request.url);
			if (url.pathname === INIT_PATH && request.headers.get(INIT_TOKEN_HEADER) === settings.token) {
				return env[RUNNER_OBJECT_BINDING].get('singleton').fetch(request);
			}

			/** @type {Promise<Response> | undefined} */
			let nextResponse;
			const next = () => (nextResponse ??= env[NEXT_BINDING].fetch(request));

			const waitUntilLast = wrapWaitUntilLast(this.ctx);
			try {
				// Import before handing the request to SvelteKit, even without a fetch handler, so
				// Durable Objects called from SvelteKit find an evaluated module (see importWorkerModule).
				const module = await importWorkerModule(env);
				const fetch = handlers.includes('fetch') ? module.fetch : undefined;
				if (typeof fetch !== 'function') return await next();
				const response = await fetch(request, userEnv(env), waitUntilLast.ctx, next);
				if (response) return response;
				return await (nextResponse ?? next());
			} catch (error) {
				console.error(error);
				return errorResponse(error);
			} finally {
				waitUntilLast.flush();
			}
		}
	}

	for (const handler of handlers) {
		if (handler === 'fetch') continue;
		Object.defineProperty(Entrypoint.prototype, handler, {
			configurable: true,
			writable: true,
			/** @param {unknown} argument */
			async value(argument) {
				const env = /** @type {any} */ (this.env);
				const waitUntilLast = wrapWaitUntilLast(this.ctx);
				try {
					const module = await importWorkerModule(env);
					const fn = requireExport(module, handler, 'function');
					return await fn(argument, userEnv(env), waitUntilLast.ctx);
				} finally {
					waitUntilLast.flush();
				}
			}
		});
	}

	return Entrypoint;
}

/** Keys that must never be forwarded through the RPC proxies. */
const IGNORED_KEYS = new Set(['self', 'then', 'constructor']);
const DURABLE_OBJECT_HANDLERS = [
	'alarm',
	'fetch',
	'webSocketMessage',
	'webSocketClose',
	'webSocketError'
];
const ENTRYPOINT_HANDLERS = ['fetch', 'scheduled', 'queue', 'email', 'tail', 'trace', 'test'];

/**
 * A value that can be awaited (RPC property access) and called (RPC method call).
 * @param {string} key
 * @param {Promise<unknown>} property
 */
function callableThenable(key, property) {
	/** @param {unknown[]} args */
	const fn = async (...args) => {
		const value = await property;
		if (typeof value !== 'function') throw new TypeError(`"${key}" is not a function.`);
		return value(...args);
	};
	fn.then = property.then.bind(property);
	fn.catch = property.catch.bind(property);
	fn.finally = property.finally.bind(property);
	return fn;
}

/** @param {Function} ctor @param {object} instance @param {string} key */
function rpcProperty(ctor, instance, key) {
	if (!Reflect.has(ctor.prototype, key)) {
		throw new TypeError(`The RPC receiver does not implement "${key}".`);
	}
	const value = Reflect.get(ctor.prototype, key, instance);
	return typeof value === 'function' ? value.bind(instance) : value;
}

const kInstance = Symbol('instance');
const kEnsureInstance = Symbol('ensureInstance');

/**
 * A Durable Object class that forwards to the current implementation exported by
 * `src/worker.ts`. When HMR replaces the class, the next call creates a new instance with the
 * same `ctx` (and therefore the same storage).
 * @param {string} exportName
 */
export function createDurableObjectWrapper(exportName) {
	class Wrapper extends DurableObject {
		/** @type {{ ctor: Function, instance: any } | undefined} */
		[kInstance];

		/** @param {DurableObjectState} ctx @param {any} env */
		constructor(ctx, env) {
			super(ctx, env);
			return new Proxy(this, {
				get(target, key, receiver) {
					const value = Reflect.get(target, key, receiver);
					if (value !== undefined) return value;
					if (typeof key === 'symbol' || IGNORED_KEYS.has(key)) return undefined;
					return callableThenable(
						key,
						receiver[kEnsureInstance]().then(
							(/** @type {{ ctor: Function, instance: any }} */ { ctor, instance }) =>
								rpcProperty(ctor, instance, key)
						)
					);
				}
			});
		}

		async [kEnsureInstance]() {
			const module = await importWorkerModule(this.env);
			const ctor = requireExport(module, exportName, 'function');
			if (!this[kInstance] || this[kInstance].ctor !== ctor) {
				this[kInstance] = {
					ctor,
					instance: new ctor(this.ctx, userEnv(/** @type {any} */ (this.env)))
				};
				// Let a blockConcurrencyWhile() started by the user constructor settle first.
				await this.ctx.blockConcurrencyWhile(async () => {});
			}
			return this[kInstance];
		}
	}

	for (const key of DURABLE_OBJECT_HANDLERS) {
		Object.defineProperty(Wrapper.prototype, key, {
			configurable: true,
			writable: true,
			/** @param {unknown[]} args */
			async value(...args) {
				const { instance } = await this[kEnsureInstance]();
				if (typeof instance[key] !== 'function') {
					throw new TypeError(`${exportName} does not implement ${key}().`);
				}
				return instance[key](...args);
			}
		});
	}

	return Wrapper;
}

/** @param {string} exportName */
export function createWorkflowWrapper(exportName) {
	class Wrapper extends WorkflowEntrypoint {
		/** @param {unknown[]} args */
		async run(...args) {
			const module = await importWorkerModule(this.env);
			const ctor = requireExport(module, exportName, 'function');
			const instance = new ctor(this.ctx, userEnv(/** @type {any} */ (this.env)));
			return instance.run(...args);
		}
	}
	return Wrapper;
}

/** @param {string} exportName */
export function createWorkerEntrypointWrapper(exportName) {
	/** @param {any} self */
	async function createInstance(self) {
		const module = await importWorkerModule(self.env);
		const ctor = requireExport(module, exportName, 'function');
		return { ctor, instance: new ctor(self.ctx, userEnv(self.env)) };
	}

	class Wrapper extends WorkerEntrypoint {
		/** @param {ExecutionContext} ctx @param {any} env */
		constructor(ctx, env) {
			super(ctx, env);
			return new Proxy(this, {
				get(target, key, receiver) {
					const value = Reflect.get(target, key, receiver);
					if (value !== undefined) return value;
					if (typeof key === 'symbol' || IGNORED_KEYS.has(key)) return undefined;
					return callableThenable(
						key,
						createInstance(receiver).then(({ ctor, instance }) => rpcProperty(ctor, instance, key))
					);
				}
			});
		}
	}

	for (const key of ENTRYPOINT_HANDLERS) {
		Object.defineProperty(Wrapper.prototype, key, {
			configurable: true,
			writable: true,
			/** @param {unknown} argument */
			async value(argument) {
				const { instance } = await createInstance(this);
				if (typeof instance[key] !== 'function') {
					throw new TypeError(`${exportName} does not implement ${key}().`);
				}
				return instance[key](argument);
			}
		});
	}

	return Wrapper;
}

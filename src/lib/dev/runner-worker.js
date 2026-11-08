// Runs inside workerd during `vite dev`, bundled with `vite/module-runner` at startup.
//
// Vite's ModuleRunner loads `src/worker.ts` and its imports from the `cloudflare_worker`
// environment, so edits apply through HMR without restarting workerd. Modules are evaluated
// inside a singleton Durable Object, so promises created during evaluation can be awaited from
// any request.
import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from 'cloudflare:workers';
import { ModuleRunner, ssrDynamicImportKey, ssrModuleExportsKey } from 'vite/module-runner';
import {
	EVAL_BINDING,
	INIT_PATH,
	INIT_TOKEN_HEADER,
	INTERNAL_BINDINGS,
	INVOKE_BINDING,
	KNOWN_HANDLERS,
	NEXT_BINDING,
	RUNNER_OBJECT_BINDING
} from '../constants.js';
import { __sveltekitCloudflareWorkerWaitUntilLast as wrapWaitUntilLast } from '../wait-until-last.js';

const settings = { entry: '', token: '', nodeBuiltins: /** @type {string[]} */ ([]) };

/** @param {typeof settings} value */
export function configure(value) {
	Object.assign(settings, value);
}

/** @type {ModuleRunner} */
let moduleRunner;
/** @type {any} The entry module node of the last successful import. */
let evaluatedEntry;
let nextCallbackId = 0;
/** @type {Map<number, () => unknown>} */
const pendingCallbacks = new Map();
/** @type {Map<number, unknown>} */
const callbackResults = new Map();
/** @type {WeakMap<object, Record<string, unknown>>} */
const userEnvironments = new WeakMap();

/**
 * The Worker `env` without the package's internal bindings, stable per input object.
 * @param {any} env
 */
function userEnv(env) {
	const cached = userEnvironments.get(env);
	if (cached) return cached;
	const result = { ...env };
	for (const key of INTERNAL_BINDINGS) delete result[key];
	userEnvironments.set(env, result);
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

/**
 * The evaluated `src/worker.ts` module.
 *
 * `ModuleRunner.import()` always asks Vite (in Node) whether the module is still fresh. SvelteKit
 * reaches Durable Objects through Miniflare's binding proxy, which blocks the Node main thread on
 * synchronous property reads, so a Durable Object calling back into Node at that moment would
 * deadlock. While the module is evaluated it is returned directly; HMR invalidation clears the
 * node's `meta`, which sends the next call through Vite again.
 *
 * @param {any} env
 * @returns {Promise<Record<string, any>>}
 */
async function importWorkerModule(env) {
	const node = moduleRunner.evaluatedModules.getModuleByUrl(settings.entry);
	if (node && node === evaluatedEntry && node.evaluated && node.meta) return node.exports;
	const exports = await runInRunnerObject(env, () => moduleRunner.import(settings.entry));
	evaluatedEntry = moduleRunner.evaluatedModules.getModuleByUrl(settings.entry);
	return exports;
}

/** @param {any} env @param {string} name */
async function importExport(env, name) {
	const value = (await importWorkerModule(env))[name];
	if (typeof value !== 'function') {
		throw new TypeError(`${settings.entry} must export a "${name}" function or class.`);
	}
	return value;
}

export class __SVELTEKIT_CF_RUNNER__ extends DurableObject {
	/** @type {WebSocket | undefined} */
	#webSocket;

	fetch() {
		const { 0: client, 1: server } = new WebSocketPair();
		server.accept();
		this.#webSocket?.close();
		this.#webSocket = server;
		moduleRunner?.close().catch(() => {});
		moduleRunner = createModuleRunner(this.env, server);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** @param {string} data */
	send(data) {
		this.#webSocket?.send(data);
	}

	/** @param {number} id */
	async executeCallback(id) {
		callbackResults.set(id, await /** @type {() => unknown} */ (pendingCallbacks.get(id))());
	}
}

/** @param {any} env @param {WebSocket} webSocket */
function createModuleRunner(env, webSocket) {
	return new ModuleRunner(
		{
			sourcemapInterceptor: 'prepareStackTrace',
			hmr: true,
			transport: {
				connect({ onMessage }) {
					webSocket.addEventListener('message', ({ data }) => onMessage(JSON.parse(String(data))));
				},
				disconnect() {
					webSocket.close();
				},
				send(data) {
					env[RUNNER_OBJECT_BINDING].get('singleton').send(JSON.stringify(data));
				},
				async invoke(data) {
					const response = await env[INVOKE_BINDING].fetch('http://localhost/', {
						method: 'POST',
						body: JSON.stringify(data)
					});
					return response.json();
				}
			}
		},
		{
			async runInlinedModule(context, transformed, module) {
				const dynamicImport = context[ssrDynamicImportKey];
				context[ssrDynamicImportKey] = (/** @type {string} */ dependency) =>
					runInRunnerObject(env, () => dynamicImport(dependency));
				const code = `"use strict";async (${Object.keys(context).join(',')})=>{${transformed}\n}`;
				await env[EVAL_BINDING].eval(code, module.id)(...Object.values(context));
				Object.seal(context[ssrModuleExportsKey]);
			},
			async runExternalModule(file) {
				if (file === 'cloudflare:workers') {
					const workers = await import('cloudflare:workers');
					return Object.seal({ ...workers, env: userEnv(workers.env) });
				}
				return import(settings.nodeBuiltins.includes(file) ? `node:${file}` : file);
			}
		}
	);
}

/**
 * Report an error to Miniflare, which renders it with its source-mapped stack.
 * @param {any} error
 * @returns {Record<string, unknown>}
 */
function reduceError(error) {
	return {
		name: error?.name,
		message: error?.message ?? String(error),
		stack: error?.stack,
		cause: error?.cause === undefined ? undefined : reduceError(error.cause)
	};
}

/**
 * The generated default entrypoint: `fetch` runs `src/worker.ts` in front of SvelteKit, and the
 * other handlers delegate to the matching named exports.
 * @param {string[]} handlers
 */
export function createEntrypoint(handlers) {
	class Entrypoint extends WorkerEntrypoint {
		/** @param {Request} request */
		async fetch(request) {
			const env = /** @type {any} */ (this.env);
			if (
				new URL(request.url).pathname === INIT_PATH &&
				request.headers.get(INIT_TOKEN_HEADER) === settings.token
			) {
				return env[RUNNER_OBJECT_BINDING].get('singleton').fetch(request);
			}

			/** @type {Promise<Response> | undefined} */
			let response;
			const next = () => (response ??= env[NEXT_BINDING].fetch(request));
			const { ctx, flush } = wrapWaitUntilLast(this.ctx);
			try {
				// Import even without a fetch handler: Durable Objects called from SvelteKit must
				// find an evaluated module (see importWorkerModule).
				const module = await importWorkerModule(env);
				if (!handlers.includes('fetch')) return await next();
				return (await module.fetch(request, userEnv(env), ctx, next)) ?? (await next());
			} catch (error) {
				console.error(error);
				return Response.json(reduceError(error), {
					status: 500,
					headers: { 'MF-Experimental-Error-Stack': 'true' }
				});
			} finally {
				flush();
			}
		}
	}

	delegate(
		Entrypoint,
		handlers.filter((handler) => handler !== 'fetch'),
		async (self, handler) => {
			const fn = await importExport(self.env, handler);
			return async (/** @type {unknown} */ event) => {
				const { ctx, flush } = wrapWaitUntilLast(self.ctx);
				try {
					return await fn(event, userEnv(self.env), ctx);
				} finally {
					flush();
				}
			};
		}
	);
	return Entrypoint;
}

/** Keys never forwarded through the RPC proxies. */
const IGNORED_KEYS = new Set(['self', 'then', 'constructor']);
const DURABLE_OBJECT_HANDLERS = [
	'alarm',
	'fetch',
	'webSocketMessage',
	'webSocketClose',
	'webSocketError'
];
const ENTRYPOINT_HANDLERS = KNOWN_HANDLERS.filter((handler) => handler !== 'connect');

/**
 * Define `handlers` on `Wrapper.prototype`, each resolving the current implementation per call.
 * @param {any} Wrapper
 * @param {string[]} handlers
 * @param {(self: any, handler: string) => Promise<(...args: any[]) => unknown>} resolve
 */
function delegate(Wrapper, handlers, resolve) {
	for (const handler of handlers) {
		Object.defineProperty(Wrapper.prototype, handler, {
			configurable: true,
			writable: true,
			/** @param {unknown[]} args */
			async value(...args) {
				return (await resolve(this, handler))(...args);
			}
		});
	}
}

/**
 * Forward RPC property reads on `wrapper` to the instance returned by `getInstance`. The value
 * can be awaited (property access) or called (method call).
 * @param {any} wrapper
 * @param {(receiver: any) => Promise<{ ctor: Function, instance: any }>} getInstance
 */
function forwardRpc(wrapper, getInstance) {
	return new Proxy(wrapper, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (value !== undefined || typeof key === 'symbol' || IGNORED_KEYS.has(key)) return value;
			const property = getInstance(receiver).then(({ ctor, instance }) => {
				if (!Reflect.has(ctor.prototype, key)) {
					throw new TypeError(`The RPC receiver does not implement "${key}".`);
				}
				const member = Reflect.get(ctor.prototype, key, instance);
				return typeof member === 'function' ? member.bind(instance) : member;
			});
			const call = async (/** @type {unknown[]} */ ...args) => (await property)(...args);
			return Object.assign(call, {
				then: property.then.bind(property),
				catch: property.catch.bind(property),
				finally: property.finally.bind(property)
			});
		}
	});
}

const kInstance = Symbol('instance');

/**
 * A Durable Object that forwards to the class currently exported by `src/worker.ts`. After an HMR
 * update, the next call constructs the new class with the same `ctx`, so storage is kept.
 * @param {string} exportName
 */
export function createDurableObjectWrapper(exportName) {
	/** @param {any} self */
	async function getInstance(self) {
		const ctor = await importExport(self.env, exportName);
		if (self[kInstance]?.ctor !== ctor) {
			self[kInstance] = { ctor, instance: new ctor(self.ctx, userEnv(self.env)) };
			// Let a blockConcurrencyWhile() started by the user constructor settle first.
			await self.ctx.blockConcurrencyWhile(async () => {});
		}
		return self[kInstance];
	}

	class Wrapper extends DurableObject {
		/** @param {DurableObjectState} ctx @param {any} env */
		constructor(ctx, env) {
			super(ctx, env);
			return forwardRpc(this, getInstance);
		}
	}
	delegate(Wrapper, DURABLE_OBJECT_HANDLERS, async (self, handler) => {
		const { instance } = await getInstance(self);
		return (...args) => instance[handler](...args);
	});
	return Wrapper;
}

/** @param {string} exportName */
export function createWorkflowWrapper(exportName) {
	class Wrapper extends WorkflowEntrypoint {
		/** @param {any[]} args */
		async run(...args) {
			const ctor = await importExport(this.env, exportName);
			return new ctor(this.ctx, userEnv(this.env)).run(...args);
		}
	}
	return Wrapper;
}

/** @param {string} exportName */
export function createWorkerEntrypointWrapper(exportName) {
	/** @param {any} self */
	async function getInstance(self) {
		const ctor = await importExport(self.env, exportName);
		return { ctor, instance: new ctor(self.ctx, userEnv(self.env)) };
	}

	class Wrapper extends WorkerEntrypoint {
		/** @param {ExecutionContext} ctx @param {any} env */
		constructor(ctx, env) {
			super(ctx, env);
			return forwardRpc(this, getInstance);
		}
	}
	delegate(Wrapper, ENTRYPOINT_HANDLERS, async (self, handler) => {
		const { instance } = await getInstance(self);
		return (/** @type {unknown} */ event) => instance[handler](event);
	});
	return Wrapper;
}

// `cloudflare:workers` for SvelteKit server code running in Node during `vite dev`.
//
// `env` reads the bindings of the Worker that runs `src/worker.ts` in workerd, through
// Miniflare's binding proxy. SvelteKit and the Worker therefore address the same Durable
// Objects, D1 databases, R2 buckets, queues and KV namespaces.
import { AsyncLocalStorage } from 'node:async_hooks';

const STATE_KEY = Symbol.for('sveltekit-cloudflare-worker.dev-state');

/** @returns {{ env?: Record<string, unknown>, error?: Error } | undefined} */
function state() {
	return /** @type {any} */ (globalThis)[STATE_KEY];
}

const scopedEnv = new AsyncLocalStorage();

function currentEnv() {
	const scoped = scopedEnv.getStore();
	if (scoped) return scoped;
	const current = state();
	if (current?.env) return current.env;
	throw (
		current?.error ??
		new Error(
			'cloudflare:workers env is not available yet: the sveltekit-cloudflare-worker runtime has not started.'
		)
	);
}

export const env = new Proxy(
	{},
	{
		get: (_, property) => Reflect.get(currentEnv(), property),
		set: (_, property, value) => Reflect.set(currentEnv(), property, value),
		has: (_, property) => Reflect.has(currentEnv(), property),
		ownKeys: () => Reflect.ownKeys(currentEnv()),
		deleteProperty: (_, property) => Reflect.deleteProperty(currentEnv(), property),
		defineProperty: (_, property, attributes) =>
			Reflect.defineProperty(currentEnv(), property, attributes),
		getOwnPropertyDescriptor: (_, property) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(currentEnv(), property);
			return descriptor ? { ...descriptor, configurable: true } : undefined;
		}
	}
);

/**
 * @template T
 * @param {Record<string, unknown>} newEnv
 * @param {() => T} fn
 */
export function withEnv(newEnv, fn) {
	return scopedEnv.run(newEnv, fn);
}

/**
 * @template T
 * @param {Record<string, unknown>} newEnv
 * @param {unknown} _exports
 * @param {() => T} fn
 */
export function withEnvAndExports(newEnv, _exports, fn) {
	return scopedEnv.run(newEnv, fn);
}

/** @param {Promise<unknown>} promise */
export function waitUntil(promise) {
	Promise.resolve(promise).catch((error) => {
		console.error('[sveltekit-cloudflare-worker] waitUntil() promise rejected:', error);
	});
}

export const exports = new Proxy(
	{},
	{
		get() {
			throw new Error(
				'cloudflare:workers exports is not available in SvelteKit code during vite dev. Use env bindings instead.'
			);
		}
	}
);

export const cache = {
	purge() {
		return Promise.resolve({ success: true, errors: [] });
	}
};

class Span {
	get isTraced() {
		return false;
	}
	setAttribute() {
		return this;
	}
	setAttributes() {
		return this;
	}
	setStatus() {
		return this;
	}
	updateName() {
		return this;
	}
	end() {}
	recordException() {}
}

export const tracing = {
	/** @param {unknown} _name @param {(span: Span, ...args: unknown[]) => unknown} callback @param {unknown[]} args */
	enterSpan(_name, callback, ...args) {
		return callback(new Span(), ...args);
	},
	/** @param {unknown} _name @param {(span: Span, ...args: unknown[]) => unknown} callback @param {unknown[]} args */
	startActiveSpan(_name, callback, ...args) {
		return callback(new Span(), ...args);
	},
	startSpan() {
		return new Span();
	},
	getActiveSpan() {},
	Span
};

// Base classes so SvelteKit modules can import Worker classes for type checks or `instanceof`.
// They never run in Node: the real classes run in workerd.
export class DurableObject {
	/** @param {unknown} ctx @param {unknown} env */
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
}
export class WorkerEntrypoint {
	/** @param {unknown} ctx @param {unknown} env */
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
}
export class WorkflowEntrypoint {
	/** @param {unknown} ctx @param {unknown} env */
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
}
export class RpcTarget {}
export class RpcPromise {}
export class RpcProperty {}
export class RpcStub {}
export class ServiceStub {}

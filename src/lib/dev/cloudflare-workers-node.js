// `cloudflare:workers` for SvelteKit server code running in Node during `vite dev`.
//
// `env` reads the bindings of the Worker that runs `src/worker.ts` in workerd, through
// Miniflare's binding proxy: SvelteKit and the Worker address the same Durable Objects, D1
// databases, R2 buckets, queues and KV namespaces.
import { AsyncLocalStorage } from 'node:async_hooks';

const STATE_KEY = Symbol.for('sveltekit-cloudflare-worker.dev-state');
const scopedEnv = new AsyncLocalStorage();

function currentEnv() {
	const env = scopedEnv.getStore() ?? /** @type {any} */ (globalThis)[STATE_KEY]?.env;
	if (!env)
		throw new Error('cloudflare:workers env is not available before the Worker runtime starts.');
	return env;
}

export const env = new Proxy(
	{},
	{
		get: (_, key) => Reflect.get(currentEnv(), key),
		set: (_, key, value) => Reflect.set(currentEnv(), key, value),
		has: (_, key) => Reflect.has(currentEnv(), key),
		deleteProperty: (_, key) => Reflect.deleteProperty(currentEnv(), key),
		ownKeys: () => Reflect.ownKeys(currentEnv()),
		// The proxy target is empty: report properties as configurable to satisfy Proxy invariants.
		getOwnPropertyDescriptor: (_, key) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(currentEnv(), key);
			return descriptor && { ...descriptor, configurable: true };
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
	promise.catch((error) => console.error('[sveltekit-cloudflare-worker] waitUntil():', error));
}

export const exports = new Proxy(
	{},
	{
		get() {
			throw new Error(
				'cloudflare:workers `exports` is not available to SvelteKit code in vite dev.'
			);
		}
	}
);

export const cache = {
	purge: async () => ({ success: true, errors: [] })
};

class Span {
	isTraced = false;
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

/** @type {(name: unknown, callback: (span: Span, ...args: unknown[]) => unknown, ...args: unknown[]) => unknown} */
const withSpan = (_name, callback, ...args) => callback(new Span(), ...args);

export const tracing = {
	enterSpan: withSpan,
	startActiveSpan: withSpan,
	startSpan: () => new Span(),
	getActiveSpan() {},
	Span
};

// Base classes so SvelteKit modules can import Worker classes; they only run in workerd.
class Entrypoint {
	/** @param {unknown} ctx @param {unknown} env */
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
}
export class DurableObject extends Entrypoint {}
export class WorkerEntrypoint extends Entrypoint {}
export class WorkflowEntrypoint extends Entrypoint {}
export class RpcTarget {}

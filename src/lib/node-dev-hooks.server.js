import * as userHooks from 'virtual:sveltekit-cloudflare-worker/user-hooks';
import { fetch as workerFetch } from 'virtual:sveltekit-cloudflare-worker/worker';
import { DEV_ASSET_REQUEST_HEADER } from './dev-constants.js';

/** @type {import('@sveltejs/kit/hooks').Handle} */
const defaultHandle = ({ event, resolve }) => resolve(event);
const userHandle =
	/** @type {import('@sveltejs/kit/hooks').Handle | undefined} */ (
		Reflect.get(userHooks, 'handle')
	) ?? defaultHandle;

/** @type {import('@sveltejs/kit/hooks').Handle} */
export const handle = async ({ event, resolve }) => {
	const next = () => Promise.resolve(userHandle({ event, resolve }));
	if (!event.platform || event.request.headers.has(DEV_ASSET_REQUEST_HEADER)) return next();

	const platform = /** @type {{ env: App.Platform['env'], ctx?: ExecutionContext }} */ (
		event.platform
	);
	if (!platform.ctx || typeof platform.ctx.waitUntil !== 'function') return next();
	const waitUntilLast = wrapWaitUntilLast(platform.ctx);
	try {
		/** @type {Promise<Response> | undefined} */
		let nextResponse;
		const callNext = () => (nextResponse ??= next());
		const response = await workerFetch(event.request, platform.env, waitUntilLast.ctx, callNext);
		return response ?? (await callNext());
	} finally {
		waitUntilLast.flush();
	}
};

export const handleFetch = Reflect.get(userHooks, 'handleFetch');
export const handleError = Reflect.get(userHooks, 'handleError');
export const init = Reflect.get(userHooks, 'init');

/**
 * @param {ExecutionContext} ctx
 * @returns {{ ctx: import('./index.js').WaitUntilLastExecutionContext, flush(): void }}
 */
function wrapWaitUntilLast(ctx) {
	const waitUntil = ctx.waitUntil.bind(ctx);
	/** @type {Promise<unknown>[]} */
	const pending = [];
	/** @type {Array<() => unknown | Promise<unknown>>} */
	const last = [];
	let flushed = false;

	const wrappedWaitUntil = /** @type {import('./index.js').WaitUntilWithLast} */ (
		(promise) => {
			const tracked = Promise.resolve(promise);
			pending.push(tracked);
			waitUntil(tracked);
		}
	);

	wrappedWaitUntil.last = (task) => {
		if (typeof task !== 'function') {
			throw new TypeError(
				'ctx.waitUntil.last() expects a function so the work can start after other waitUntil promises.'
			);
		}
		if (flushed) throw new Error('ctx.waitUntil.last() must be called before the handler returns.');
		last.push(task);
	};

	async function runLastTasks() {
		const settled = await Promise.allSettled(last.map((task) => Promise.resolve().then(task)));
		const failures = settled.filter((result) => result.status === 'rejected');
		if (failures.length === 1) throw failures[0].reason;
		if (failures.length > 1) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				'ctx.waitUntil.last() callbacks failed.'
			);
		}
	}

	const wrappedCtx = new Proxy(ctx, {
		get(target, property) {
			if (property === 'waitUntil') return wrappedWaitUntil;
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});

	return {
		ctx: /** @type {import('./index.js').WaitUntilLastExecutionContext} */ (
			/** @type {unknown} */ (wrappedCtx)
		),
		flush() {
			if (flushed) return;
			flushed = true;
			if (last.length === 0) return;
			waitUntil(Promise.allSettled(pending).then(runLastTasks));
		}
	};
}

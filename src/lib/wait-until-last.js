/**
 * Wrap an ExecutionContext so `ctx.waitUntil.last(task)` starts `task` after every other
 * `waitUntil` promise registered before the handler returned.
 *
 * This function is also serialized with `Function.prototype.toString()` into the generated
 * production Worker, so it must stay self-contained (no imports, no outer references).
 *
 * @param {any} ctx
 * @returns {{ ctx: any, flush(): void }}
 */
export function __sveltekitCloudflareWorkerWaitUntilLast(ctx) {
	if (!ctx || typeof ctx.waitUntil !== 'function') {
		return { ctx, flush() {} };
	}

	const waitUntil = ctx.waitUntil.bind(ctx);
	/** @type {Promise<unknown>[]} */
	const pending = [];
	/** @type {Array<() => unknown>} */
	const last = [];
	let flushed = false;

	/** @param {unknown} promise */
	function wrappedWaitUntil(promise) {
		const tracked = Promise.resolve(promise);
		pending.push(tracked);
		waitUntil(tracked);
	}

	/** @param {() => unknown} task */
	wrappedWaitUntil.last = (task) => {
		if (typeof task !== 'function') {
			throw new TypeError(
				'ctx.waitUntil.last() expects a function so the work can start after other waitUntil promises.'
			);
		}
		if (flushed) {
			throw new Error('ctx.waitUntil.last() must be called before the handler returns.');
		}
		last.push(task);
	};

	async function runLastTasks() {
		const results = await Promise.allSettled(last.map((task) => Promise.resolve().then(task)));
		const failures = /** @type {PromiseRejectedResult[]} */ (
			results.filter((result) => result.status === 'rejected')
		);

		if (failures.length === 1) {
			throw failures[0].reason;
		}
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
		ctx: wrappedCtx,
		flush() {
			if (flushed) return;
			flushed = true;
			if (last.length === 0) return;
			waitUntil(Promise.allSettled(pending).then(runLastTasks));
		}
	};
}

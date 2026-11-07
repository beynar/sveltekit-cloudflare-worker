import { DurableObject } from 'cloudflare:workers';
import type { WorkerFetch } from 'sveltekit-cloudflare-worker';

interface Env {
	COUNTER: DurableObjectNamespace<Counter>;
	ASSETS: Fetcher;
}

export class Counter extends DurableObject<Env> {
	async get(): Promise<number> {
		return (await this.ctx.storage.get<number>('count')) ?? 0;
	}

	async increment(): Promise<number> {
		const count = (await this.ctx.storage.get<number>('count')) ?? 0;
		const nextCount = count + 1;

		await this.ctx.storage.put('count', nextCount);
		return nextCount;
	}
}

export const fetch: WorkerFetch<Env> = async (request, env, _ctx, next) => {
	const url = new URL(request.url);
	const routePrefix = '/api/worker-counter/';

	if (url.pathname === '/api/worker-ping') {
		return Response.json({ handledBy: 'worker-middleware', runtime: 'workerd' });
	}

	if (url.pathname.startsWith(routePrefix)) {
		const name = decodeURIComponent(url.pathname.slice(routePrefix.length));
		const counter = env.COUNTER.getByName(name);
		const count = request.method === 'POST' ? await counter.increment() : await counter.get();

		return Response.json({ name, count, handledBy: 'worker-middleware' });
	}

	if (url.pathname === '/') {
		const response = await next();
		const headers = new Headers(response.headers);
		headers.set('x-worker-middleware', 'true');
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	}
};

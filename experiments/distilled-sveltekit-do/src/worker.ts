import { DurableObject } from 'cloudflare:workers';

export interface CounterValue {
	count: number;
	stage: 'middleware-before' | 'sveltekit' | 'middleware-after';
}

export class Counter extends DurableObject {
	async increment(stage: CounterValue['stage']): Promise<CounterValue> {
		const count = ((await this.ctx.storage.get<number>('count')) ?? 0) + 1;
		await this.ctx.storage.put('count', count);
		return { count, stage };
	}

	async read(): Promise<number> {
		return (await this.ctx.storage.get<number>('count')) ?? 0;
	}
}

export async function fetch(
	request: Request,
	env: Env,
	_ctx: ExecutionContext,
	next: () => Promise<Response>
): Promise<Response> {
	const match = /^\/kit\/counter\/([^/]+)$/.exec(new URL(request.url).pathname);
	if (request.method !== 'POST' || !match) return next();

	const counter = env.COUNTER.getByName(decodeURIComponent(match[1]));
	const before = await counter.increment('middleware-before');
	const response = await next();
	const after = await counter.increment('middleware-after');
	const headers = new Headers(response.headers);
	headers.set('x-counter-before', String(before.count));
	headers.set('x-counter-after', String(after.count));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

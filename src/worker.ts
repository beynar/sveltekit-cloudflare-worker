import type { WorkerFetch, WorkerScheduled } from 'sveltekit-cloudflare-worker';
import { DurableObject } from 'cloudflare:workers';

export const fetch: WorkerFetch = async (req, env, ctx) => {
	const url = new URL(req.url);

	if (url.pathname === '/api/do') {
		const id = env.MY_DO.idFromName('test');
		const stub = env.MY_DO.get(id);
		const message = await stub.sayHello();
		return new Response(JSON.stringify({ message }), {
			headers: { 'content-type': 'application/json' }
		});
	}

	if (url.pathname.startsWith('/api/')) {
		return new Response('custom API response');
	}
	// Return nothing to fall through to SvelteKit
};

export const scheduled: WorkerScheduled = async (controller, env, ctx) => {
	console.log('cron job triggered', controller.cron);
};

export class MyDurableObject extends DurableObject {
	async sayHello(): Promise<string> {
		return 'Hello from Durable Object!';
	}
}

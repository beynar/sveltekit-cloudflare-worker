import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async () => {
	if (!env.MY_DO) {
		return Response.json(
			{ ok: false, reason: 'missing-my-do', keys: Object.keys(env).sort() },
			{ status: 500 }
		);
	}

	const count = await env.MY_DO.getByName('demo').increment();

	return Response.json({
		ok: true,
		count,
		keys: Object.keys(env).sort()
	});
};

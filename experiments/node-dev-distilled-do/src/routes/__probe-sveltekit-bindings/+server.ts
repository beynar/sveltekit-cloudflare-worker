import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ platform }) => {
	const env = platform?.env;
	if (!env) {
		return Response.json({ ok: false, reason: 'missing-platform' }, { status: 500 });
	}

	if (!env.MY_DO) {
		return Response.json(
			{ ok: false, reason: 'missing-my-do', keys: Object.keys(env).sort() },
			{ status: 500 }
		);
	}

	const id = env.MY_DO.idFromName('demo');
	const stub = env.MY_DO.get(id);
	const count = await stub.increment();

	return Response.json({
		ok: true,
		count,
		keys: Object.keys(env).sort()
	});
};

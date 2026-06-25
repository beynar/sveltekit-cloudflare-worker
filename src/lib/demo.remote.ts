import { getRequestEvent, query } from '$app/server';

export const getDemoPlatform = query(async () => {
	const { platform } = getRequestEvent();
	const env = platform?.env;

	if (!env?.MY_DO) {
		throw new Error('Missing MY_DO binding in SvelteKit remote');
	}

	const count = await env.MY_DO.get(env.MY_DO.idFromName('demo-remote')).increment();

	return {
		count,
		hasDurableObject: true,
		hasRateLimit: Boolean(env.RATELIMIT_CHAT)
	};
});

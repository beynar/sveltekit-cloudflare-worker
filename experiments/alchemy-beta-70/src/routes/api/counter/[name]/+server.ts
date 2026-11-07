import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

function getCounter(platform: App.Platform | undefined, name: string) {
	const namespace = platform?.env.COUNTER;

	if (!namespace) {
		error(503, 'The Alchemy Durable Object binding is unavailable.');
	}

	return namespace.getByName(name);
}

export const GET: RequestHandler = async ({ params, platform }) => {
	const count = await getCounter(platform, params.name).get();

	return json({ name: params.name, count });
};

export const POST: RequestHandler = async ({ params, platform }) => {
	const count = await getCounter(platform, params.name).increment();

	return json({ name: params.name, count });
};

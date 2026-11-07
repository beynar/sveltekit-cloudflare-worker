import { error, json } from '@sveltejs/kit';

export const POST = async ({ params, platform }) => {
	if (!platform) {
		error(500, 'Cloudflare platform is unavailable');
	}

	return json(await platform.env.COUNTER.getByName(params.name).increment('sveltekit'));
};

export const GET = async ({ params, platform }) => {
	if (!platform) {
		error(500, 'Cloudflare platform is unavailable');
	}

	return json({ count: await platform.env.COUNTER.getByName(params.name).read() });
};

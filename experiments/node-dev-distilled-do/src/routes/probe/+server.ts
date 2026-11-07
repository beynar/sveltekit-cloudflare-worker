import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ platform, url }) => {
	if (!platform) error(500, 'The Distilled platform emulator is not available.');
	const name = url.searchParams.get('name');
	if (!name) error(400, 'The name query parameter is required.');

	const count = await platform.env.COUNTER.getByName(name).increment();
	return json({ count, stage: 'sveltekit' });
};

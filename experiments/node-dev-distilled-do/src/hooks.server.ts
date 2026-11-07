import type { Handle } from '@sveltejs/kit/hooks';

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	const headers = new Headers(response.headers);
	headers.set('x-user-hook', 'preserved');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
};

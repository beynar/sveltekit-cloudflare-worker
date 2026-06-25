import type { RequestHandler } from './$types.js';

const remoteId = '8e6xpc/getDemoPlatform';

export const GET: RequestHandler = async ({ fetch }) => {
	const response = await fetch(`/_app/remote/${remoteId}?payload=`);
	const body = await response.json();

	return Response.json({
		ok: response.ok,
		status: response.status,
		body
	});
};

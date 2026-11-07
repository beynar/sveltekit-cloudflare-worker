import { read } from '$app/server';
import readableUrl from '#lib/demo-readable.txt?url';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async () => {
	const response = read(readableUrl);

	return Response.json({
		ok: response.ok,
		body: await response.text(),
		contentLength: response.headers.get('content-length'),
		url: readableUrl
	});
};

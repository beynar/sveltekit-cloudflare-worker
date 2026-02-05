import type { Handle } from '@sveltejs/kit';
import { test } from './test.ts';

export const handle: Handle = async ({ event, resolve }) => {
	console.log(test(1, 2));
	return resolve(event);
};

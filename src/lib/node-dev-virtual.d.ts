declare module 'virtual:sveltekit-cloudflare-worker/user-hooks' {
	import type { Handle, HandleFetch, HandleServerError } from '@sveltejs/kit/hooks';

	export const handle: Handle | undefined;
	export const handleFetch: HandleFetch | undefined;
	export const handleError: HandleServerError | undefined;
	export const init: (() => void | Promise<void>) | undefined;
}

declare module 'virtual:sveltekit-cloudflare-worker/worker' {
	import type { WorkerFetch } from './index.js';

	export const fetch: WorkerFetch;
}

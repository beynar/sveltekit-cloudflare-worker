import { sveltekit } from '@sveltejs/kit/vite';
import { cloudflareWorker } from 'sveltekit-cloudflare-worker';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit(
			cloudflareWorker({}, {
				workerFile: 'src/counter-worker.ts',
				typesFile: false
			})
		)
	]
});

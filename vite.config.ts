import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { cloudflareWorker } from './src/lib/index.js';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(
			cloudflareWorker({
				preprocess: vitePreprocess(),
				experimental: {
					remoteFunctions: true
				}
			})
		)
	]
});

import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { cloudflareWorker } from 'sveltekit-cloudflare-worker';
import { defineConfig } from 'vite';

export default defineConfig({
	clearScreen: false,
	plugins: [
		tailwindcss(),
		sveltekit(
			cloudflareWorker({
				preprocess: vitePreprocess(),
				experimental: { remoteFunctions: true }
			})
		)
	]
});

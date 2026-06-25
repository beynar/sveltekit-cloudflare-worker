import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { cloudflareWorker } from './src/lib/index.js';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), cloudflareWorker()]
});

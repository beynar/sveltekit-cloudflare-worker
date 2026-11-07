import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { cloudflareWorker } from '../../src/lib/index.js';

export default defineConfig({
	plugins: [sveltekit(cloudflareWorker({}, { typesFile: false }))]
});

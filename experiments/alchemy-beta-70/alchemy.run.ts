import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import * as Effect from 'effect/Effect';
import type { Counter } from './src/counter-worker.ts';

const compatibility = { date: '2026-07-11' } as const;

export const Website = Cloudflare.Worker('Website', {
	compatibility,
	assets: {
		directory: '.',
		runWorkerFirst: true
	},
	source: {
		provider: 'sveltekit-cloudflare-worker/alchemy-source',
		devMode: 'server',
		options: {
			rootDir: '.',
			workerFile: 'src/counter-worker.ts'
		}
	},
	env: {
		COUNTER: Cloudflare.DurableObject<Counter>('COUNTER', {
			className: 'Counter'
		})
	}
});

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

export default Alchemy.Stack(
	'AlchemyBeta70SvelteKitDurableObject',
	{
		providers: Cloudflare.providers(),
		state: Alchemy.localState()
	},
	Effect.gen(function* () {
		const website = yield* Website;

		return { url: website.url };
	})
);

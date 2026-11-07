import type { WebsiteEnv } from '../alchemy.run.ts';

declare global {
	namespace App {
		interface Platform {
			env: WebsiteEnv;
		}
	}
}

export {};

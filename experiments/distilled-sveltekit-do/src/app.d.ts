import type { Counter } from './worker.ts';

declare global {
	interface Env {
		COUNTER: DurableObjectNamespace<Counter>;
	}

	namespace App {
		interface Platform {
			env: Env;
		}
	}
}

export {};

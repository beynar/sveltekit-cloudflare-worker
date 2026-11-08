/** Name of the Vite environment that runs `src/worker.ts` inside workerd during `vite dev`. */
export const WORKER_ENVIRONMENT = 'cloudflare_worker';

/** Reserved path used to open the module-runner WebSocket between Vite and workerd. */
export const INIT_PATH = '/__sveltekit-cloudflare-worker/init';

/** Header carrying the per-process secret that authorizes {@link INIT_PATH}. */
export const INIT_TOKEN_HEADER = 'x-sveltekit-cloudflare-worker-init';

/** Internal bindings added to the development Worker. They are stripped from user `env`. */
export const RUNNER_OBJECT_BINDING = '__SVELTEKIT_CF_RUNNER__';
export const INVOKE_BINDING = '__SVELTEKIT_CF_INVOKE__';
export const EVAL_BINDING = '__SVELTEKIT_CF_EVAL__';
export const NEXT_BINDING = '__SVELTEKIT_CF_NEXT__';

/** Global the runner defines to build WebAssembly modules imported as `.wasm` during `vite dev`. */
export const WASM_GLOBAL = '__sveltekitCloudflareWorkerWasm';

export const INTERNAL_BINDINGS = [
	RUNNER_OBJECT_BINDING,
	INVOKE_BINDING,
	EVAL_BINDING,
	NEXT_BINDING
];

/** Exported Worker handlers that are forwarded from the generated entry to `src/worker.ts`. */
export const KNOWN_HANDLERS = [
	'fetch',
	'connect',
	'scheduled',
	'queue',
	'email',
	'tail',
	'trace',
	'tailStream',
	'test'
];

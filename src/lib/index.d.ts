// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference types="@cloudflare/workers-types" />
import type { Adapter } from '@sveltejs/kit';
import type { AdapterOptions } from '@sveltejs/adapter-cloudflare';
import type { Config } from '@sveltejs/kit/vite';
import type {
	ExecutionContext,
	Socket,
	ScheduledController,
	MessageBatch,
	ForwardableEmailMessage,
	TraceItem,
	TestController
} from '@cloudflare/workers-types';

export interface CloudflareWorkerOptions extends Pick<
	AdapterOptions,
	'config' | 'fallback' | 'routes'
> {
	/**
	 * Project root. Set this only when the Vite root differs from the current working directory.
	 * @default process.cwd()
	 */
	root?: string;
	/**
	 * Path to the Worker entry, relative to the project root.
	 * @default 'src/worker.ts'
	 */
	workerFile?: string;
	/**
	 * Wrangler environment (`env.<name>` in the Wrangler config) used by `vite dev` and the build.
	 * @default process.env.CLOUDFLARE_ENV
	 */
	environment?: string;
	/**
	 * Declaration file that receives the generated `Cloudflare.Env` block, derived from the
	 * Wrangler config and the classes exported by the Worker entry. Set to `false` when you
	 * generate types with `wrangler types` instead.
	 * @default 'src/app.d.ts'
	 */
	typesFile?: string | false;
	/**
	 * Type `vars` with their literal values (`'https://example.com'`). Set to `false` to type them as
	 * `string`, `number` or `boolean`, so configs that differ only by values generate the same file.
	 * @default true
	 */
	strictVars?: boolean;
	/**
	 * Where `vite dev` persists local binding state. The default is shared with Wrangler, so
	 * `wrangler d1 migrations apply --local` and `wrangler dev` see the same data.
	 * @default true (`.wrangler/state/v3` next to the Wrangler config)
	 */
	persistState?: boolean | { path: string };
	/**
	 * Connect bindings that only exist remotely (for example Workers AI) during `vite dev`.
	 * Requires `wrangler login`. When the session cannot start, dev continues without them.
	 * @default true
	 */
	remoteBindings?: boolean;
	/**
	 * Log composition and runtime details.
	 * @default false
	 */
	verbose?: boolean;
}

/**
 * Add the Cloudflare Worker adapter to the SvelteKit options passed to `sveltekit()`.
 *
 * - `vite dev`: runs the Worker entry in workerd (with HMR) in front of SvelteKit, and gives
 *   SvelteKit server code the same bindings through `import { env } from 'cloudflare:workers'`.
 * - `vite build`: builds with adapter-cloudflare, then composes one `_worker.js` that exports the
 *   Worker's classes and handlers around SvelteKit.
 */
export function cloudflareWorker(
	config?: Config,
	options?: CloudflareWorkerOptions
): Config & { adapter: Adapter };

/** The adapter installed by {@link cloudflareWorker}, for use as `sveltekit({ adapter })`. */
export function cloudflareWorkerAdapter(options?: CloudflareWorkerOptions): Adapter;

/** Execution context passed to Worker handlers. */
export type WorkerExecutionContext = ExecutionContext;

export type WaitUntilLastTask = () => unknown | Promise<unknown>;

export type WaitUntilWithLast = ExecutionContext['waitUntil'] & {
	/**
	 * Queue work that should start after other waitUntil promises registered before the handler returns.
	 *
	 * This accepts a function, not an already-created Promise, because Promises start immediately.
	 */
	last(task: WaitUntilLastTask): void;
};

export interface WaitUntilLastExecutionContext extends WorkerExecutionContext {
	waitUntil: WaitUntilWithLast;
}

/**
 * Fetch handler that acts as middleware before SvelteKit.
 * Return a Response to short-circuit, or return nothing to fall through to SvelteKit.
 * Call `next()` to invoke SvelteKit and optionally transform its response.
 */
export type WorkerFetch<Env = Cloudflare.Env> = (
	request: Request,
	env: Env,
	ctx: WaitUntilLastExecutionContext,
	next: () => Promise<Response>
) => Response | void | Promise<Response | void>;

export type WorkerScheduled<Env = Cloudflare.Env> = (
	controller: ScheduledController,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerConnect<Env = Cloudflare.Env> = (
	socket: Socket,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerQueue<Env = Cloudflare.Env, Message = unknown> = (
	batch: MessageBatch<Message>,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerEmail<Env = Cloudflare.Env> = (
	message: ForwardableEmailMessage,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerTail<Env = Cloudflare.Env> = (
	events: TraceItem[],
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerTrace<Env = Cloudflare.Env> = (
	traces: TraceItem[],
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerTailStream<Env = Cloudflare.Env> = (
	event: TailStream.TailEvent<TailStream.Onset>,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => TailStream.TailEventHandlerType | Promise<TailStream.TailEventHandlerType>;

export type WorkerTest<Env = Cloudflare.Env> = (
	controller: TestController,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

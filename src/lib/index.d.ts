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
	 * Absolute or relative project root used to initialize the development runtime.
	 * Set this only when the SvelteKit Vite root differs from the current working directory.
	 * @default process.cwd()
	 */
	root?: string;
	/**
	 * Path to the worker file relative to the project root.
	 * @default 'src/worker.ts'
	 */
	workerFile?: string;
	/**
	 * Path to the SvelteKit declaration file that receives the managed App.Platform block.
	 * These types describe the Wrangler config shape. Runtime availability in local dev
	 * comes from the Distilled Node platform proxy.
	 * Set to false to disable automatic App.Platform.env type generation.
	 * @default 'src/app.d.ts'
	 */
	typesFile?: string | false;
	/**
	 * Enable verbose logging.
	 * @default false
	 */
	verbose?: boolean;
	/**
	 * Local TCP port for a Worker `connect()` handler. The listener starts only when
	 * `src/worker.ts` exports `connect` and always binds to `127.0.0.1`.
	 * Use `0` to select an available port and read the selected address from the Vite log.
	 * @default 8788
	 * @deprecated Declare the listener with Wrangler's top-level `connect` field.
	 */
	connectPort?: number;
}

/**
 * Add the Cloudflare Worker adapter and its server-hook bridge to a SvelteKit configuration.
 *
 * In build mode: composes the adapter Worker and user Worker behind one entry module.
 * In dev mode: keeps SvelteKit SSR in Node and hosts Cloudflare entrypoint classes in workerd.
 */
export function cloudflareWorker(
	config?: Config,
	options?: CloudflareWorkerOptions
): Config & { adapter: Adapter };

/** Execution context exposed through SvelteKit's Node platform proxy. */
export type WorkerExecutionContext = Pick<ExecutionContext, 'waitUntil' | 'passThroughOnException'>;

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
export type WorkerFetch<Env = App.Platform['env']> = (
	request: Request,
	env: Env,
	ctx: WaitUntilLastExecutionContext,
	next: () => Promise<Response>
) => Response | void | Promise<Response | void>;

export type WorkerScheduled<Env = App.Platform['env']> = (
	controller: ScheduledController,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerConnect<Env = App.Platform['env']> = (
	socket: Socket,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerQueue<Env = App.Platform['env'], Message = unknown> = (
	batch: MessageBatch<Message>,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerEmail<Env = App.Platform['env']> = (
	message: ForwardableEmailMessage,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerTail<Env = App.Platform['env']> = (
	events: TraceItem[],
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerTrace<Env = App.Platform['env']> = (
	traces: TraceItem[],
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

export type WorkerTailStream<Env = App.Platform['env']> = (
	event: TailStream.TailEvent<TailStream.Onset>,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => TailStream.TailEventHandlerType | Promise<TailStream.TailEventHandlerType>;

export type WorkerTest<Env = App.Platform['env']> = (
	controller: TestController,
	env: Env,
	ctx: WaitUntilLastExecutionContext
) => void | Promise<void>;

import type { Plugin } from 'vite';
import type {
	ExecutionContext,
	ScheduledController,
	MessageBatch,
	ForwardableEmailMessage,
	TraceItem
} from '@cloudflare/workers-types';

export interface CloudflareWorkerOptions {
	/**
	 * Path to the worker file relative to the project root.
	 * @default 'src/worker.ts'
	 */
	workerFile?: string;
	/**
	 * Enable verbose logging.
	 * @default false
	 */
	verbose?: boolean;
}

/**
 * Vite plugin that patches the SvelteKit adapter-cloudflare output
 * to support additional Cloudflare Worker exports.
 *
 * In build mode: patches _worker.js after adapter-cloudflare generates it.
 * In dev mode: wraps @cloudflare/vite-plugin to run worker code in real workerd
 * with full Durable Object, Workflow, and binding support.
 */
export function cloudflareWorker(options?: CloudflareWorkerOptions): Promise<Plugin[]>;

/**
 * Fetch handler that acts as middleware before SvelteKit.
 * Return a Response to short-circuit, or return nothing to fall through to SvelteKit.
 * Call `next()` to invoke SvelteKit and optionally transform its response.
 */
export type WorkerFetch<Env = App.Platform['env']> = (
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	next: () => Promise<Response>
) => Response | void | Promise<Response | void>;

export type WorkerScheduled<Env = App.Platform['env']> = (
	controller: ScheduledController,
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

export type WorkerQueue<Env = App.Platform['env'], Message = unknown> = (
	batch: MessageBatch<Message>,
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

export type WorkerEmail<Env = App.Platform['env']> = (
	message: ForwardableEmailMessage,
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

export type WorkerTail<Env = App.Platform['env']> = (
	events: TraceItem[],
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

export type WorkerTrace<Env = App.Platform['env']> = (
	traces: TraceItem[],
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

export type WorkerTailStream<Env = App.Platform['env']> = (
	event: TailStream.TailEvent<TailStream.Onset>
) => TailStream.TailEventHandlerType | Promise<TailStream.TailEventHandlerType>;

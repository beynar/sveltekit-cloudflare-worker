import type { Plugin } from 'vite';

export interface CloudflareWorkerOptions {
	/**
	 * Path to the worker file relative to the project root.
	 * @default 'src/worker.ts'
	 */
	workerFile?: string;
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
 */
export type WorkerFetch<Env = unknown> = (
	request: Request,
	env: Env,
	ctx: ExecutionContext
) => Response | void | Promise<Response | void>;

export type WorkerScheduled<Env = unknown> = (
	controller: ScheduledController,
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

export type WorkerQueue<Env = unknown, Message = unknown> = (
	batch: MessageBatch<Message>,
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

export type WorkerEmail<Env = unknown> = (
	message: ForwardableEmailMessage,
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

export type WorkerTail<Env = unknown> = (
	events: TraceItem[],
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

export type WorkerTrace<Env = unknown> = (
	traces: TraceItem[],
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

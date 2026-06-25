import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigEnv, ResolvedConfig, UserConfig } from 'vite';
import { cloudflareWorker } from './index.js';

type TestHook<Args extends unknown[]> =
	| ((...args: Args) => unknown | Promise<unknown>)
	| { handler: (...args: Args) => unknown | Promise<unknown> };

type TestPlugin = {
	name: string;
	config?: TestHook<[UserConfig, ConfigEnv]>;
	configResolved?: TestHook<[ResolvedConfig]>;
	closeBundle?: TestHook<[]>;
};

type GeneratedWorkerModule = {
	default: {
		fetch(
			request: Request,
			env: { ASSETS?: { fetch(request: Request): Response | Promise<Response> } },
			ctx: ExecutionContext
		): Promise<Response>;
		scheduled?: (controller: { cron: string }, env: unknown, ctx: unknown) => Promise<string>;
		queue?: () => Promise<string>;
		email?: () => Promise<string>;
		tail?: () => Promise<string>;
		trace?: () => Promise<string>;
		tailStream?: () => Promise<string>;
	};
	MyDurableObject?: new () => unknown;
	MyWorkflow?: new () => unknown;
	MyEntrypoint?: new () => unknown;
};

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('cloudflareWorker', () => {
	describe('App.Platform.env type generation', () => {
		it('writes a managed app.d.ts block from Wrangler bindings', async () => {
			const root = await createFixture();
			await writeWorker(
				root,
				`export class MyDurableObject {}
export class ProgressWorkflow {
  run(event, step) {
    return Promise.resolve();
  }
}`
			);
			await writeWranglerConfig(root, {
				main: '.svelte-kit/cloudflare/_worker.js',
				compatibility_date: '2025-01-01',
				assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' },
				vars: { PLAIN_TEXT: 'hello', JSON_VALUE: { enabled: true, count: 2 } },
				kv_namespaces: [{ binding: 'KV', id: 'kv' }],
				r2_buckets: [{ binding: 'BUCKET', bucket_name: 'bucket-name' }],
				d1_databases: [
					{
						binding: 'DB',
						database_name: 'database',
						database_id: '00000000-0000-0000-0000-000000000000'
					}
				],
				vectorize: [{ binding: 'VECTOR', index_name: 'vector-index' }],
				hyperdrive: [{ binding: 'HYPER', id: '00000000000000000000000000000000' }],
				analytics_engine_datasets: [{ binding: 'ANALYTICS' }],
				queues: { producers: [{ binding: 'QUEUE', queue: 'queue' }] },
				ratelimits: [{ name: 'RATE', namespace_id: '1001', simple: { limit: 10, period: 60 } }],
				send_email: [{ name: 'EMAIL' }],
				services: [{ binding: 'SERVICE', service: 'other-worker' }],
				ai: { binding: 'AI' },
				browser: { binding: 'BROWSER' },
				images: { binding: 'IMAGES' },
				media: { binding: 'MEDIA' },
				version_metadata: { binding: 'VERSION' },
				mtls_certificates: [{ binding: 'CERT', certificate_id: 'cert' }],
				dispatch_namespaces: [{ binding: 'DISPATCH', namespace: 'namespace' }],
				pipelines: [{ binding: 'PIPELINE', pipeline: 'pipeline' }],
				secrets_store_secrets: [{ binding: 'SECRET', store_id: 'store', secret_name: 'secret' }],
				text_blobs: { TEXT: './text.txt' },
				data_blobs: { DATA: './data.bin' },
				unsafe: { bindings: [{ name: 'UNSAFE', type: 'experimental' }] },
				durable_objects: {
					bindings: [
						{ name: 'MY_DO', class_name: 'MyDurableObject' },
						{ name: 'REMOTE_DO', class_name: 'RemoteDurableObject' }
					]
				},
				workflows: [{ name: 'workflow', binding: 'WORKFLOW', class_name: 'ProgressWorkflow' }]
			});

			await runTypesPlugin(root);

			const appTypes = await readAppTypes(root);
			expect(appTypes).toContain('// <sveltekit-cloudflare-worker>');
			expect(appTypes).toContain("mainModule: typeof import('./worker');");
			expect(appTypes).toContain("durableNamespaces: 'MyDurableObject' | 'RemoteDurableObject';");
			expect(appTypes).toContain('ASSETS: Fetcher;');
			expect(appTypes).toContain("PLAIN_TEXT: 'hello';");
			expect(appTypes).toContain('JSON_VALUE: {"enabled":true,"count":2};');
			expect(appTypes).toContain('KV: KVNamespace;');
			expect(appTypes).toContain('BUCKET: R2Bucket;');
			expect(appTypes).toContain('DB: D1Database;');
			expect(appTypes).toContain('VECTOR: VectorizeIndex;');
			expect(appTypes).toContain('HYPER: Hyperdrive;');
			expect(appTypes).toContain('ANALYTICS: AnalyticsEngineDataset;');
			expect(appTypes).toContain('QUEUE: Queue;');
			expect(appTypes).toContain('RATE: RateLimit;');
			expect(appTypes).toContain('EMAIL: SendEmail;');
			expect(appTypes).toContain('SERVICE: Fetcher; /* other-worker */');
			expect(appTypes).toContain('AI: Ai;');
			expect(appTypes).toContain('BROWSER: Fetcher;');
			expect(appTypes).toContain('IMAGES: ImagesBinding;');
			expect(appTypes).toContain('MEDIA: MediaBinding;');
			expect(appTypes).toContain('VERSION: WorkerVersionMetadata;');
			expect(appTypes).toContain('CERT: Fetcher;');
			expect(appTypes).toContain('DISPATCH: DispatchNamespace;');
			expect(appTypes).toContain(
				"PIPELINE: import('cloudflare:pipelines').Pipeline<import('cloudflare:pipelines').PipelineRecord>;"
			);
			expect(appTypes).toContain('SECRET: SecretsStoreSecret;');
			expect(appTypes).toContain('TEXT: string;');
			expect(appTypes).toContain('DATA: ArrayBuffer;');
			expect(appTypes).toContain('UNSAFE: unknown; /* experimental */');
			expect(appTypes).toContain(
				"MY_DO: DurableObjectNamespace<import('./worker').MyDurableObject>;"
			);
			expect(appTypes).toContain('REMOTE_DO: DurableObjectNamespace;');
			expect(appTypes).toContain('WORKFLOW: Workflow<');
			expect(appTypes).toContain(
				"Parameters<import('./worker').ProgressWorkflow['run']>[0]['payload']"
			);
			expect(appTypes).toContain(
				'declare global {\n\tinterface Env extends Cloudflare.Env {}\n\tnamespace App {'
			);
			expect(appTypes).toContain('env: Cloudflare.Env;');
		});

		it('replaces only its managed block in an existing app.d.ts', async () => {
			const root = await createFixture();
			await mkdir(path.join(root, 'src'), { recursive: true });
			await writeFile(
				path.join(root, 'src/app.d.ts'),
				`declare global {
  namespace App {
    interface Locals {
      userId: string;
    }
  }
}

// <sveltekit-cloudflare-worker>
stale
// </sveltekit-cloudflare-worker>

export {};
`
			);
			await writeWorker(root, 'export const fetch = async () => new Response("ok");');

			await runTypesPlugin(root);

			const appTypes = await readAppTypes(root);
			expect(appTypes).toContain('userId: string;');
			expect(appTypes).not.toContain('stale');
			expect(appTypes).toContain('ASSETS: Fetcher;');
		});

		it('supports custom worker and types file paths', async () => {
			const root = await createFixture();
			await writeWorker(root, 'export class CustomDurableObject {}', 'workers/custom.ts');
			await writeWranglerConfig(root, {
				main: '.svelte-kit/cloudflare/_worker.js',
				compatibility_date: '2025-01-01',
				durable_objects: {
					bindings: [{ name: 'CUSTOM_DO', class_name: 'CustomDurableObject' }]
				}
			});

			await runTypesPlugin(root, 'workers/custom.ts', 'types/app.d.ts');

			const appTypes = await readFile(path.join(root, 'types/app.d.ts'), 'utf-8');
			expect(appTypes).toContain("mainModule: typeof import('../workers/custom');");
			expect(appTypes).toContain(
				"CUSTOM_DO: DurableObjectNamespace<import('../workers/custom').CustomDurableObject>;"
			);
		});

		it('can disable automatic type generation', async () => {
			const root = await createFixture();
			await writeWorker(root, 'export const fetch = async () => new Response("ok");');

			await runTypesPlugin(root, 'src/worker.ts', false);

			await expect(readAppTypes(root)).rejects.toThrow();
		});
	});

	describe('build output patching', () => {
		it('re-exports worker classes and wires every supported handler', async () => {
			const root = await createFixture();
			await writeWorker(
				root,
				`import { DurableObject, WorkflowEntrypoint, WorkerEntrypoint } from 'cloudflare:workers';

export const fetch = async (request, env, ctx, next) => {
  const url = new URL(request.url);
  if (url.pathname === '/worker') return new Response('worker');
  if (url.pathname === '/transform') {
    const response = await next();
    return new Response(await response.text() + '+worker', { status: response.status });
  }
};
export const scheduled = async () => 'scheduled';
export const queue = async () => 'queue';
export const email = async () => 'email';
export const tail = async () => 'tail';
export const trace = async () => 'trace';
export const tailStream = async () => 'tailStream';
export class MyDurableObject extends DurableObject {}
export class MyWorkflow extends WorkflowEntrypoint {}
export class MyEntrypoint extends WorkerEntrypoint {}`
			);

			await runBuildPlugin(root);

			const worker = await readGeneratedWorker(root);
			expect(worker).toContain("import * as __userWorker from './_user-worker.js';");
			expect(worker).toContain("export { MyDurableObject } from './_user-worker.js';");
			expect(worker).toContain("export { MyWorkflow } from './_user-worker.js';");
			expect(worker).toContain("export { MyEntrypoint } from './_user-worker.js';");
			expect(worker).toContain('async fetch(req, env, ctx)');
			expect(worker).toContain(
				'const next = () => { _nextResponse = worker_default.fetch(req, env, __waitUntilLast.ctx); return _nextResponse; };'
			);
			expect(worker).toContain('async scheduled(controller, env, ctx)');
			expect(worker).toContain('async queue(batch, env, ctx)');
			expect(worker).toContain('async email(message, env, ctx)');
			expect(worker).toContain('async tail(events, env, ctx)');
			expect(worker).toContain('async trace(traces, env, ctx)');
			expect(worker).toContain('tailStream: __userWorker.tailStream');
			await expect(
				readFile(path.join(root, '.svelte-kit/cloudflare/_user-worker.js'), 'utf-8')
			).resolves.toContain('MyDurableObject');
		});

		it('runs the patched fetch wrapper with short-circuit, transformed, and fallback responses', async () => {
			const root = await createFixture();
			await writeWorker(
				root,
				`export const fetch = async (request, env, ctx, next) => {
  const url = new URL(request.url);
  if (url.pathname === '/worker') return new Response('worker');
  if (url.pathname === '/transform') {
    const response = await next();
    return new Response(await response.text() + '+worker', { status: response.status, headers: { 'x-worker': 'yes' } });
  }
};
export const scheduled = async (controller) => controller.cron;`
			);

			await runBuildPlugin(root);

			const worker = await importGeneratedWorker(root);
			const workerResponse = await worker.default.fetch(
				new Request('https://example.com/worker'),
				{},
				{} as ExecutionContext
			);
			await expect(workerResponse.text()).resolves.toBe('worker');

			const transformResponse = await worker.default.fetch(
				new Request('https://example.com/transform'),
				{},
				{} as ExecutionContext
			);
			expect(transformResponse.headers.get('x-worker')).toBe('yes');
			await expect(transformResponse.text()).resolves.toBe('sveltekit:/transform+worker');

			const fallbackResponse = await worker.default.fetch(
				new Request('https://example.com/fallback'),
				{},
				{} as ExecutionContext
			);
			await expect(fallbackResponse.text()).resolves.toBe('sveltekit:/fallback');
			await expect(worker.default.scheduled?.({ cron: '* * * * *' }, {}, {})).resolves.toBe(
				'* * * * *'
			);
		});

		it('runs ctx.waitUntil.last callbacks after normal waitUntil promises', async () => {
			const root = await createFixture();
			await writeWorker(
				root,
				`export const fetch = async (request, env, ctx) => {
  ctx.waitUntil((async () => {
    env.events.push('waitUntil:start');
    await env.release.promise;
    env.events.push('waitUntil:end');
  })());
  ctx.waitUntil.last(async () => {
    env.events.push('last');
  });
  return new Response('ok');
};`
			);

			await runBuildPlugin(root);

			const worker = await importGeneratedWorker(root);
			const release = createDeferred<void>();
			const waitUntilPromises: Promise<unknown>[] = [];
			const env = {
				events: [] as string[],
				release,
				ASSETS: {
					fetch: (request: Request) => new Response(`asset:${new URL(request.url).pathname}`)
				}
			};
			const ctx = createExecutionContext(waitUntilPromises);
			const response = await worker.default.fetch(
				new Request('https://example.com/worker'),
				env,
				ctx
			);

			await expect(response.text()).resolves.toBe('ok');
			expect(env.events).toEqual(['waitUntil:start']);
			release.resolve();
			await Promise.allSettled(waitUntilPromises);
			expect(env.events).toEqual(['waitUntil:start', 'waitUntil:end', 'last']);
		});

		it('runs every ctx.waitUntil.last callback before reporting cleanup failures', async () => {
			const root = await createFixture();
			await writeWorker(
				root,
				`export const fetch = async (request, env, ctx) => {
  ctx.waitUntil.last(() => {
    env.events.push('first:last');
    throw new Error('first cleanup failed');
  });
  ctx.waitUntil.last(async () => {
    env.events.push('second:last');
  });
  return new Response('ok');
};`
			);

			await runBuildPlugin(root);

			const worker = await importGeneratedWorker(root);
			const waitUntilPromises: Promise<unknown>[] = [];
			const env = {
				events: [] as string[],
				ASSETS: {
					fetch: (request: Request) => new Response(`asset:${new URL(request.url).pathname}`)
				}
			};
			const response = await worker.default.fetch(
				new Request('https://example.com/worker'),
				env,
				createExecutionContext(waitUntilPromises)
			);

			await expect(response.text()).resolves.toBe('ok');
			const results = await Promise.allSettled(waitUntilPromises);
			expect(env.events).toEqual(['first:last', 'second:last']);
			expect(results).toHaveLength(1);
			expect(results[0]?.status).toBe('rejected');
			if (results[0]?.status === 'rejected') {
				expect(results[0].reason).toBeInstanceOf(Error);
				expect(results[0].reason.message).toBe('first cleanup failed');
			}
		});

		it('wraps ctx.waitUntil.last for non-fetch handlers with an ExecutionContext', async () => {
			const root = await createFixture();
			await writeWorker(
				root,
				`export const scheduled = async (controller, env, ctx) => {
  ctx.waitUntil((async () => {
    env.events.push('scheduled:waitUntil:start');
    await env.release.promise;
    env.events.push('scheduled:waitUntil:end');
  })());
  ctx.waitUntil.last(async () => {
    env.events.push('scheduled:last');
  });
};`
			);

			await runBuildPlugin(root);

			const worker = await importGeneratedWorker(root);
			const release = createDeferred<void>();
			const waitUntilPromises: Promise<unknown>[] = [];
			const env = { events: [] as string[], release };
			await worker.default.scheduled?.(
				{ cron: '* * * * *' },
				env,
				createExecutionContext(waitUntilPromises)
			);

			expect(env.events).toEqual(['scheduled:waitUntil:start']);
			release.resolve();
			await Promise.allSettled(waitUntilPromises);
			expect(env.events).toEqual([
				'scheduled:waitUntil:start',
				'scheduled:waitUntil:end',
				'scheduled:last'
			]);
		});

		it('preserves the SvelteKit fetch handler when the worker has only class exports', async () => {
			const root = await createFixture();
			await writeWorker(root, 'export class MyDurableObject {}');

			await runBuildPlugin(root);

			const worker = await readGeneratedWorker(root);
			expect(worker).toContain("export { MyDurableObject } from './_user-worker.js';");
			expect(worker).toContain('fetch: worker_default.fetch');
			expect(worker).not.toContain('_nextResponse');
		});

		it('does not patch twice', async () => {
			const root = await createFixture();
			await writeWorker(root, 'export const fetch = async () => new Response("worker");');

			const plugin = await runBuildPlugin(root);
			const firstPatch = await readGeneratedWorker(root);
			await runCloseBundle(plugin, root);

			await expect(readGeneratedWorker(root)).resolves.toBe(firstPatch);
		});

		it('leaves adapter output untouched when the worker exports nothing', async () => {
			const root = await createFixture();
			await writeWorker(root, 'const internal = true;');
			const originalWorker = await readGeneratedWorker(root);

			await runBuildPlugin(root);

			await expect(readGeneratedWorker(root)).resolves.toBe(originalWorker);
		});
	});

	describe('dev entry generation', () => {
		it('generates a workerd SSR entry with class re-exports, handler passthrough, and SvelteKit fallback', async () => {
			const root = await createFixture();
			await writeMinimalSvelteKitApp(root);
			await writeWorker(
				root,
				`export const fetch = async (request, env, ctx, next) => {
  if (new URL(request.url).pathname === '/worker') return new Response('worker');
};
export const scheduled = async () => 'scheduled';
export const queue = async () => 'queue';
export const email = async () => 'email';
export const tail = async () => 'tail';
export const trace = async () => 'trace';
export const tailStream = async () => 'tailStream';
export class MyDurableObject {}
export class MyWorkflow {}
export class MyEntrypoint {}`
			);

			await runDevSetupPlugin(root);

			const entry = await readDevEntry(root);
			expect(entry).toContain("import * as __userWorker from '../../src/worker';");
			expect(entry).toContain(
				"import { respond as __sveltekitCloudflareWorkerRespond } from './_sveltekit-dev-ssr';"
			);
			expect(entry).toContain("export { MyDurableObject } from '../../src/worker';");
			expect(entry).toContain("export { MyWorkflow } from '../../src/worker';");
			expect(entry).toContain("export { MyEntrypoint } from '../../src/worker';");
			expect(entry).toContain(
				'async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response>'
			);
			expect(entry).toContain(
				'const next = () => { _nextResponse = __sveltekitCloudflareWorkerRespond(request, env, __waitUntilLast.ctx); return _nextResponse; };'
			);
			expect(entry).toContain(
				'async scheduled(controller: ScheduledController, env: any, ctx: ExecutionContext)'
			);
			expect(entry).toContain('async queue(batch: MessageBatch, env: any, ctx: ExecutionContext)');
			expect(entry).toContain(
				'async email(message: ForwardableEmailMessage, env: any, ctx: ExecutionContext)'
			);
			expect(entry).toContain('async tail(events: TraceItem[], env: any, ctx: ExecutionContext)');
			expect(entry).toContain('async trace(traces: TraceItem[], env: any, ctx: ExecutionContext)');
			expect(entry).toContain('tailStream: __userWorker.tailStream');
		});

		it('generates the SvelteKit dev SSR responder', async () => {
			const root = await createFixture();
			await writeWorker(root, 'export const fetch = async () => undefined;');
			await writeMinimalSvelteKitApp(root);
			await writeFile(
				path.join(root, 'src/routes/+layout.svelte'),
				`<script>
\timport './layout.css';
</script>

<slot />
`
			);
			await writeFile(path.join(root, 'src/routes/layout.css'), '.fixture-layout { color: red; }');
			await writeFile(
				path.join(root, 'src/routes/+page.svelte'),
				`<h1>fixture</h1>

<style>
\t.fixture-page {
\t\tcolor: blue;
\t}
</style>
`
			);
			await mkdir(path.join(root, 'src/routes/no-ssr'), { recursive: true });
			await writeFile(path.join(root, 'src/routes/no-ssr/+page.svelte'), '<h1>client only</h1>');
			await writeFile(path.join(root, 'src/routes/no-ssr/+page.ts'), 'export const ssr = false;');

			await runDevSetupPlugin(root);

			const entry = await readDevEntry(root);
			const svelteKitEntry = await readFile(
				path.join(root, '.svelte-kit/cloudflare-worker/_sveltekit-dev-ssr.ts'),
				'utf-8'
			);
			expect(entry).toContain(
				"import { respond as __sveltekitCloudflareWorkerRespond } from './_sveltekit-dev-ssr';"
			);
			expect(entry).toContain(
				'const next = () => { _nextResponse = __sveltekitCloudflareWorkerRespond(request, env, __waitUntilLast.ctx); return _nextResponse; };'
			);
			expect(svelteKitEntry).toContain('const server = new Server(manifest);');
			expect(svelteKitEntry).toContain('set_fix_stack_trace((error) => error?.stack);');
			expect(svelteKitEntry).toContain('(globalThis as any).__SVELTEKIT_TRACK__');
			expect(svelteKitEntry).toContain('read: (file) => readAsset(env, request, file)');
				expect(svelteKitEntry).toContain('before_handle(event, config, prerender, handle)');
				expect(svelteKitEntry).toContain('return handle();');
			expect(svelteKitEntry).toContain('async () => __sveltekitCloudflareWorkerDefaultError');
			expect(svelteKitEntry).toContain(
				'const inlineStyleEndpoint = "/__sveltekit-cloudflare-worker/inline-styles";'
			);
			expect(svelteKitEntry).toContain('currentRequestOrigin = new URL(request.url).origin;');
			expect(svelteKitEntry).toContain('inline_styles: async () => loadInlineStyles(0)');
			expect(svelteKitEntry).toContain('inline_styles: async () => loadInlineStyles(2)');
			expect(svelteKitEntry).not.toContain('?inline&svelte&type=style&lang.css');
			expect(svelteKitEntry).toContain('"ssr":false');
			expect(svelteKitEntry).toContain('platform: {');
			expect(svelteKitEntry).toContain('env,');
		});

		it('generates SvelteKit dev SSR remote function loaders', async () => {
			const root = await createFixture();
			await writeWorker(root, 'export const fetch = async () => undefined;');
			await writeMinimalSvelteKitApp(root);
			await writeSvelteConfig(
				root,
				`export default {
	kit: {
		experimental: {
			remoteFunctions: true
		}
	}
};
`
			);
			await mkdir(path.join(root, 'src/lib'), { recursive: true });
			await writeFile(
				path.join(root, 'src/lib/fixture.remote.ts'),
				`import { query } from '$app/server';

export const getFixture = query(() => 'fixture');
`
			);

			await runDevSetupPlugin(root);

			const svelteKitEntry = await readFile(
				path.join(root, '.svelte-kit/cloudflare-worker/_sveltekit-dev-ssr.ts'),
				'utf-8'
			);
				expect(svelteKitEntry).toContain('remotes: {');
				expect(svelteKitEntry).toContain('const module = await import("/src/lib/fixture.skcw-remote.ts");');
				expect(svelteKitEntry).toContain(
					'init_remote_functions(module, "src/lib/fixture.remote.ts", "3215r6");'
				);
		});

		it('supports a custom worker file path', async () => {
			const root = await createFixture();
			await writeWorker(
				root,
				'export const fetch = async () => new Response("custom");',
				'workers/custom.ts'
			);
			await writeMinimalSvelteKitApp(root);

			await runDevSetupPlugin(root, 'workers/custom.ts');
			await runBuildPlugin(root, 'workers/custom.ts');

			const entry = await readDevEntry(root);
			const worker = await readGeneratedWorker(root);
			expect(entry).toContain("import * as __userWorker from '../../workers/custom';");
			expect(entry).toContain(
				"import { respond as __sveltekitCloudflareWorkerRespond } from './_sveltekit-dev-ssr';"
			);
			expect(worker).toContain("import * as __userWorker from './_user-worker.js';");
			expect(worker).toContain('async fetch(req, env, ctx)');
		});

		it('does not generate an entry when the worker file is missing', async () => {
			const root = await createFixture();

			await runDevSetupPlugin(root);

			await expect(
				readFile(path.join(root, '.svelte-kit/cloudflare-worker/_dev-entry.ts'), 'utf-8')
			).rejects.toThrow();
		});
	});
});

async function createFixture() {
	const root = await mkdtemp(path.join(tmpdir(), 'sveltekit-cloudflare-worker-'));
	temporaryRoots.push(root);
	await mkdir(path.join(root, '.svelte-kit/cloudflare'), { recursive: true });
	await writeWranglerConfig(root, {
		main: '.svelte-kit/cloudflare/_worker.js',
		compatibility_date: '2025-01-01',
		assets: {
			binding: 'ASSETS',
			directory: '.svelte-kit/cloudflare'
		}
	});
	await writeFile(
		path.join(root, '.svelte-kit/cloudflare/_worker.js'),
		`const worker_default = {
  async fetch(req, env, ctx) {
    return new Response('sveltekit:' + new URL(req.url).pathname);
  }
};
export { worker_default as default };
`
	);
	return root;
}

async function writeWranglerConfig(root: string, config: Record<string, unknown>) {
	await writeFile(path.join(root, 'wrangler.jsonc'), JSON.stringify(config, null, '\t'));
}

async function writeWorker(root: string, source: string, workerFile = 'src/worker.ts') {
	const workerPath = path.join(root, workerFile);
	await mkdir(path.dirname(workerPath), { recursive: true });
	await writeFile(workerPath, source);
}

async function writeSvelteConfig(root: string, source: string) {
	await writeFile(path.join(root, 'svelte.config.js'), source);
}

async function writeMinimalSvelteKitApp(root: string) {
	await mkdir(path.join(root, 'src/routes'), { recursive: true });
	await writeFile(
		path.join(root, 'src/app.html'),
		'<!doctype html><html><head>%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>'
	);
	await writeFile(path.join(root, 'src/routes/+page.svelte'), '<h1>fixture</h1>');
}

async function runTypesPlugin(
	root: string,
	workerFile = 'src/worker.ts',
	typesFile: string | false = 'src/app.d.ts'
) {
	const plugin = await getPlugin('sveltekit-cloudflare-worker:types', workerFile, typesFile);
	await runHook(plugin.config, { root } as UserConfig, { command: 'serve', mode: 'test' });
}

async function runBuildPlugin(root: string, workerFile = 'src/worker.ts') {
	const plugin = await getPlugin('sveltekit-cloudflare-worker:build', workerFile);
	await runHook(plugin.configResolved, { root } as ResolvedConfig);
	await runCloseBundle(plugin, root);
	return plugin;
}

async function runDevSetupPlugin(root: string, workerFile = 'src/worker.ts') {
	const plugin = await getPlugin('sveltekit-cloudflare-worker:dev-setup', workerFile);
	await runHook(plugin.config, { root } as UserConfig, { command: 'serve', mode: 'test' });
}

async function getPlugin(
	name: string,
	workerFile: string,
	typesFile: string | false = 'src/app.d.ts'
) {
	const plugins = await cloudflareWorker({ workerFile, typesFile });
	const plugin = plugins.find((candidate) => candidate.name === name);
	expect(plugin).toBeDefined();
	return plugin as TestPlugin;
}

async function runCloseBundle(plugin: TestPlugin, cwd?: string) {
	const originalCwd = process.cwd();
	if (cwd) process.chdir(cwd);
	try {
		await runHook(plugin.closeBundle);
	} finally {
		if (cwd) process.chdir(originalCwd);
	}
}

async function runHook<Args extends unknown[]>(hook: TestHook<Args> | undefined, ...args: Args) {
	expect(hook).toBeDefined();
	if (!hook) return;
	if (typeof hook === 'function') {
		await hook(...args);
		return;
	}
	await hook.handler(...args);
}

function readGeneratedWorker(root: string) {
	return readFile(path.join(root, '.svelte-kit/cloudflare/_worker.js'), 'utf-8');
}

function readAppTypes(root: string) {
	return readFile(path.join(root, 'src/app.d.ts'), 'utf-8');
}

function readDevEntry(root: string) {
	return readFile(path.join(root, '.svelte-kit/cloudflare-worker/_dev-entry.ts'), 'utf-8');
}

async function importGeneratedWorker(root: string) {
	const workerUrl = pathToFileURL(path.join(root, '.svelte-kit/cloudflare/_worker.js'));
	workerUrl.searchParams.set('v', crypto.randomUUID());
	return import(workerUrl.href) as Promise<GeneratedWorkerModule>;
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function createExecutionContext(waitUntilPromises: Promise<unknown>[]) {
	return {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise);
		},
		passThroughOnException() {},
		props: {}
	} as ExecutionContext;
}

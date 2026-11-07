import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	resolveDistilledDevConfiguration,
	resolveDistilledDevOptions
} from './distilled-wrangler.js';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Wrangler to Distilled dev configuration', () => {
	it('maps one Worker with local assets, bindings, DOs, workflows, queues, and crons', async () => {
		const root = await fixture({
			name: 'distilled-fixture',
			main: 'src/worker.ts',
			compatibility_date: '2026-07-11',
			compatibility_flags: ['nodejs_compat'],
			vars: { TEXT: 'value', JSON: { enabled: true } },
			assets: { binding: 'ASSETS', directory: 'static', run_worker_first: true },
			kv_namespaces: [{ binding: 'KV', id: 'production', preview_id: 'local' }],
			d1_databases: [
				{
					binding: 'DB',
					database_name: 'db',
					database_id: 'production',
					preview_database_id: 'local'
				}
			],
			r2_buckets: [{ binding: 'BUCKET', bucket_name: 'production', preview_bucket_name: 'local' }],
			migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
			durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
			workflows: [{ name: 'jobs', binding: 'JOBS', class_name: 'Jobs', limits: { steps: 17 } }],
			queues: {
				producers: [{ binding: 'TASKS', queue: 'tasks' }],
				consumers: [{ queue: 'tasks', max_batch_size: 10 }]
			},
			triggers: { crons: ['0 * * * *'] }
		});

		const options = resolveDistilledDevOptions(root, '/generated/_dev-entry.ts', undefined);
		expect(options.main).toBe('/generated/_dev-entry.ts');
		expect(options.compatibilityDate).toBe('2026-07-11');
		expect(options.compatibilityFlags).toEqual(
			expect.arrayContaining(['nodejs_compat', 'nodejs_als', 'enable_nodejs_fs_module'])
		);
		expect(options.worker?.name).toBe('distilled-fixture');
		expect(options.worker?.bindings).toHaveLength(9);
		expect(options.worker?.durableObjectNamespaces).toEqual([{ className: 'Counter', sql: true }]);
		expect(options.worker?.workflows).toEqual([
			{ workflowName: 'jobs', className: 'Jobs', stepLimit: 17 }
		]);
		expect(options.worker?.queueConsumers).toEqual([{ queueName: 'tasks', maxBatchSize: 10 }]);
		expect(options.worker?.crons).toEqual(['0 * * * *']);
		expect(options.worker?.assets).toMatchObject({ runWorkerFirst: true });
	});

	it('fails clearly instead of silently dropping an unsupported binding', async () => {
		const root = await fixture({
			name: 'unsupported-fixture',
			compatibility_date: '2026-07-11',
			vectorize: [{ binding: 'VECTOR', index_name: 'documents' }]
		});

		expect(() => resolveDistilledDevOptions(root, '/generated/_dev-entry.ts', undefined)).toThrow(
			'Distilled local development does not yet support these Wrangler bindings: Vectorize.'
		);
	});

	it('derives the Durable Object owner and Node proxy from one Wrangler declaration', async () => {
		const root = await fixture({
			name: 'automatic-owner',
			compatibility_date: '2026-07-11',
			migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
			durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] }
		});

		const configuration = resolveDistilledDevConfiguration(
			root,
			'/generated/_dev-entry.ts',
			undefined
		);
		expect(configuration.workerOptions.worker?.name).toBe('automatic-owner');
		expect(configuration.workerOptions.worker?.durableObjectNamespaces).toEqual([
			{ className: 'Counter', sql: true }
		]);
		expect(configuration.platformProxyOptions.name).toBe('automatic-owner:sveltekit');
		expect(configuration.workerOptions.worker?.bindings).toHaveLength(1);
		expect(configuration.platformProxyOptions.bindings).toHaveLength(1);
	});

	it('derives SQLite ownership from declarative Durable Object exports', async () => {
		const root = await fixture({
			name: 'declarative-owner',
			compatibility_date: '2026-08-24',
			exports: {
				Counter: { type: 'durable-object', storage: 'sqlite' }
			},
			durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] }
		});

		const configuration = resolveDistilledDevConfiguration(
			root,
			'/generated/_dev-entry.ts',
			undefined
		);
		expect(configuration.workerOptions.worker?.durableObjectNamespaces).toEqual([
			{ className: 'Counter', sql: true }
		]);
	});

	it('preserves route-specific assets.run_worker_first rules', async () => {
		const root = await fixture({
			name: 'asset-routes',
			main: 'src/worker.ts',
			compatibility_date: '2026-08-24',
			assets: {
				binding: 'ASSETS',
				directory: 'static',
				run_worker_first: ['/api/*', '!/api/static/*']
			}
		});

		const options = resolveDistilledDevOptions(root, '/generated/_dev-entry.ts', undefined);
		expect(options.worker?.assets?.runWorkerFirst).toEqual(['/api/*', '!/api/static/*']);
	});

	it('rejects remote bindings instead of silently replacing them with local state', async () => {
		const root = await fixture({
			name: 'remote-kv',
			compatibility_date: '2026-08-24',
			kv_namespaces: [{ binding: 'KV', id: 'production', remote: true }]
		});

		expect(() => resolveDistilledDevOptions(root, '/generated/_dev-entry.ts', undefined)).toThrow(
			'Distilled local development does not support Wrangler remote bindings: KV KV.'
		);
	});

	it('rejects containers before Wrangler local normalization can crash', async () => {
		const root = await fixture({
			name: 'container-owner',
			compatibility_date: '2026-08-24',
			exports: {
				SocketContainer: {
					type: 'durable-object',
					storage: 'sqlite',
					container: 'socket-app'
				}
			},
			containers: [{ name: 'socket-app', image: 'docker.io/httpd:1' }]
		});

		expect(() => resolveDistilledDevOptions(root, '/generated/_dev-entry.ts', undefined)).toThrow(
			'Distilled local development does not yet support these Wrangler bindings: containers.'
		);
	});

	it.each([
		['one schedule', '0 * * * *'],
		['multiple schedules', ['0 * * * *', '30 * * * *']]
	])('rejects Workflow %s instead of silently dropping it', async (_name, schedules) => {
		const root = await fixture({
			name: 'scheduled-workflow',
			compatibility_date: '2026-08-24',
			workflows: [
				{
					name: 'scheduled-jobs',
					binding: 'JOBS',
					class_name: 'Jobs',
					schedules
				}
			]
		});

		expect(() => resolveDistilledDevOptions(root, '/generated/_dev-entry.ts', undefined)).toThrow(
			'Distilled local development does not yet support Wrangler Workflow schedules: JOBS.'
		);
	});

	it('normalizes one Wrangler TCP connect listener', async () => {
		const root = await fixture({
			name: 'tcp-listener',
			compatibility_date: '2026-08-24',
			connect: [{ protocol: 'tcp', port: 9000 }]
		});

		const configuration = resolveDistilledDevConfiguration(
			root,
			'/generated/_dev-entry.ts',
			undefined
		);
		expect(configuration.tcpListener).toEqual({ address: '127.0.0.1', port: 9000 });
	});

	it('rejects multiple Wrangler TCP connect listeners', async () => {
		const root = await fixture({
			name: 'multiple-tcp-listeners',
			compatibility_date: '2026-08-24',
			connect: [
				{ protocol: 'tcp', port: 9000 },
				{ protocol: 'tcp', port: 9001 }
			]
		});

		expect(() =>
			resolveDistilledDevConfiguration(root, '/generated/_dev-entry.ts', undefined)
		).toThrow(
			'Distilled local development supports one Wrangler TCP connect listener; received 2.'
		);
	});

	it('rejects a Wrangler TCP listener that is not loopback-only', async () => {
		const root = await fixture({
			name: 'public-tcp-listener',
			compatibility_date: '2026-08-24',
			connect: [{ protocol: 'tcp', address: '0.0.0.0', port: 9000 }]
		});

		expect(() =>
			resolveDistilledDevConfiguration(root, '/generated/_dev-entry.ts', undefined)
		).toThrow(
			'Distilled local development supports Wrangler TCP connect listeners only on 127.0.0.1; received "0.0.0.0".'
		);
	});

	it('rejects a Wrangler connect listener with a non-TCP protocol', async () => {
		const root = await fixture({
			name: 'udp-listener',
			compatibility_date: '2026-08-24',
			connect: [{ protocol: 'udp', port: 9000 }]
		});

		expect(() =>
			resolveDistilledDevConfiguration(root, '/generated/_dev-entry.ts', undefined)
		).toThrow('"connect[0]" should have a "protocol" field of "tcp" but got "udp"');
	});
});

async function fixture(config: Record<string, unknown>) {
	const root = await mkdtemp(path.join(tmpdir(), 'distilled-wrangler-'));
	roots.push(root);
	await writeFile(path.join(root, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
	return root;
}

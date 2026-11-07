import cloudflare from '@distilled.cloud/cloudflare-vite-plugin';
import * as Credentials from '@distilled.cloud/cloudflare/Credentials';
import * as RuntimeServices from '@distilled.cloud/cloudflare-runtime/RuntimeServices';
import * as Assets from '@distilled.cloud/cloudflare-runtime/bindings/assets/Assets';
import * as DurableObjectNamespace from '@distilled.cloud/cloudflare-runtime/bindings/DurableObjectNamespace';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Scope from 'effect/Scope';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile, type Plugin, type PluginOption } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_ENTRY = path.join(ROOT, '.svelte-kit', 'cloudflare-worker', '_dev-entry.ts');
const WORKER_NAME = 'distilled-sveltekit-do';
const COUNTER_UNIQUE_KEY = 'distilled-sveltekit-do:Counter:v1';
const COMPATIBILITY_DATE = '2026-07-11';
const runtimeScope = Scope.makeUnsafe();

const runtimeContext = await RuntimeServices.layerRuntime({
	api: { accountId: '00000000000000000000000000000000' },
	storage: { directory: path.join(ROOT, '.distilled', 'local') }
}).pipe(
	Layer.provideMerge(NodeServices.layer),
	Layer.provide(
		Layer.merge(
			Credentials.fromApiToken({ apiToken: 'local-runtime-only' }),
			FetchHttpClient.layer
		)
	),
	Layer.buildWithScope(runtimeScope),
	Effect.runPromise
);

process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED = '1';

let server;
try {
	const loadedConfig = await loadConfigFromFile(
		{ command: 'serve', mode: 'development' },
		undefined,
		ROOT
	);
	if (!loadedConfig) {
		throw new Error(`Could not load the Vite configuration from ${ROOT}`);
	}

	const projectPlugins = (await resolvePluginOptions(loadedConfig.config.plugins)).map(
		disableSvelteKitNodeDevServer
	);
	server = await createServer({
		...loadedConfig.config,
		root: ROOT,
		configFile: false,
		plugins: [
			...projectPlugins,
			workerdSsrEnvironment(),
			cloudflare({
				main: DEV_ENTRY,
				compatibilityDate: COMPATIBILITY_DATE,
				compatibilityFlags: ['nodejs_compat', 'enable_nodejs_fs_module'],
				viteEnvironments: { entry: 'ssr' },
				dev: { middlewareOrder: 'pre' },
				worker: {
					name: WORKER_NAME,
					bindings: [
						Assets.local('ASSETS'),
						DurableObjectNamespace.local({
							binding: 'COUNTER',
							className: 'Counter',
							uniqueKey: COUNTER_UNIQUE_KEY
						})
					],
					durableObjectNamespaces: [
						{ className: 'Counter', sql: true, uniqueKey: COUNTER_UNIQUE_KEY }
					],
					assets: { runWorkerFirst: true },
					logging: { verbose: true }
				},
				context: runtimeContext
			})
		],
		server: { ...loadedConfig.config.server, port: 0 }
	});

	await server.listen();
	const url = server.resolvedUrls?.local[0];
	if (!url) {
		throw new Error('Vite started without a local URL');
	}
	console.log(`APP_URL=${url.replace(/\/$/, '')}`);
	console.log('PATH=fetch before -> SvelteKit -> fetch after');
	console.log('STATE_DIR=.distilled/local');
	console.log('Press Ctrl+C to stop the unified runtime.');
	await waitForShutdown();
} finally {
	await server?.close();
	await Effect.runPromise(Scope.closeUnsafe(runtimeScope, Exit.void) ?? Effect.void);
}

async function resolvePluginOptions(options: PluginOption[] | undefined): Promise<Plugin[]> {
	const plugins: Plugin[] = [];
	for (const option of options ?? []) {
		const resolved = await option;
		if (Array.isArray(resolved)) {
			plugins.push(...(await resolvePluginOptions(resolved)));
		} else if (resolved) {
			plugins.push(resolved);
		}
	}
	return plugins;
}

function disableSvelteKitNodeDevServer(plugin: Plugin): Plugin {
	if (plugin.name !== 'vite-plugin-sveltekit-compile') return plugin;
	return { ...plugin, configureServer: undefined };
}

function workerdSsrEnvironment(): Plugin {
	const workerdEsmEnv = '\0distilled-sveltekit-do:esm-env';
	return {
		name: 'distilled-sveltekit-do:workerd-ssr-environment',
		enforce: 'pre',
		applyToEnvironment(environment) {
			return environment.name === 'ssr';
		},
		configResolved(config) {
			const ssr = config.environments.ssr;
			if (!ssr) throw new Error('SvelteKit did not configure its SSR environment');
			ssr.resolve.external = [];
		},
		resolveId(id) {
			if (id === 'esm-env') return workerdEsmEnv;
		},
		load(id) {
			if (id === workerdEsmEnv) {
				return 'export const BROWSER = false; export const DEV = true; export const NODE = false;';
			}
		}
	};
}

async function waitForShutdown(): Promise<void> {
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
}

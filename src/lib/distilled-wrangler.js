import path from 'node:path';
import {
	unstable_getMiniflareWorkerOptions,
	unstable_getVarsForDev,
	unstable_readConfig
} from 'wrangler';
import {
	AnalyticsEngine,
	Assets,
	D1,
	DurableObjectNamespace,
	Json,
	KvNamespace,
	Queue,
	R2Bucket,
	RateLimit,
	Service,
	Workflows
} from '@distilled.cloud/cloudflare-runtime/bindings';
import { findWranglerConfig } from './wrangler-config.js';

/**
 * Wrangler 4.125's `SourcelessWorkerOptions` loses its named properties because it omits
 * source fields from a Miniflare type with a string index signature. Refine only the normalized
 * properties consumed at this boundary while retaining unknown future properties for rejection.
 *
 * @typedef {ReturnType<typeof unstable_getMiniflareWorkerOptions>['workerOptions'] & {
 *   compatibilityDate?: string,
 *   compatibilityFlags?: string[],
 *   bindings?: Record<string, unknown>,
 *   kvNamespaces?: Record<string, { id: string }>,
 *   r2Buckets?: Record<string, { id: string }>,
 *   d1Databases?: Record<string, { id: string }>,
 *   queueProducers?: Record<string, { queueName: string, deliveryDelay?: number }>,
 *   queueConsumers?: Record<string, Record<string, unknown>>,
 *   analyticsEngineDatasets?: Record<string, { dataset?: string }>,
 *   ratelimits?: Record<string, { namespace_id: string, simple: { limit: number, period: 10 | 60 } }>,
 *   durableObjects?: Record<string, { className: string, scriptName?: string, useSQLite?: boolean }>,
 *   workflows?: Record<string, { name: string, className: string, scriptName?: string, stepLimit?: number }>,
 *   serviceBindings?: Record<string, { name: string, entrypoint?: string, props?: Record<string, unknown> }>,
 *   tails?: Array<{ name: string }>,
 *   streamingTails?: Array<{ name: string }>,
 *   assets?: Record<string, unknown>,
 *   cache?: boolean
 * }} NormalizedWorkerOptions
 */

/**
 * Convert Wrangler's normalized local-worker model into Distilled's runtime model.
 * Keeping the unstable Wrangler API behind this boundary makes version drift testable.
 *
 * @param {string} root
 * @param {string} main
 * @param {string | undefined} configFile
 * @param {boolean} [verbose]
 * @returns {import('@distilled.cloud/cloudflare-vite-plugin').CloudflareVitePluginOptions}
 */
export function resolveDistilledDevOptions(root, main, configFile, verbose = false) {
	return resolveDistilledDevConfiguration(root, main, configFile, verbose).workerOptions;
}

/**
 * Resolve the one Wrangler configuration into the owning Worker runtime and the Node platform
 * proxy that consumes it. Same-script Durable Objects and Workflows are rewritten as cross-worker
 * bindings only for the proxy; the developer never declares a second script name or unique key.
 *
 * @param {string} root
 * @param {string} main
 * @param {string | undefined} configFile
 * @param {boolean} [verbose]
 * @returns {{
 *   workerOptions: import('@distilled.cloud/cloudflare-vite-plugin').CloudflareVitePluginOptions,
 *   platformProxyOptions: import('@distilled.cloud/cloudflare-runtime/platform-proxy').PlatformProxyOptions,
 *   assetsBinding: string | undefined,
 *   workflowBindings: string[],
 *   tcpListener: { address: string, port: number } | undefined
 * }}
 */
export function resolveDistilledDevConfiguration(root, main, configFile, verbose = false) {
	const configPath = configFile ? path.resolve(root, configFile) : findWranglerConfig(root);
	const config = configPath
		? unstable_readConfig({ config: configPath }, { hideWarnings: true })
		: unstable_readConfig({}, { hideWarnings: true });
	assertPreNormalizationSupported(config);
	assertNoRemoteBindings(config);
	const tcpListener = resolveTcpListener(config.connect);
	const normalizedOptions = unstable_getMiniflareWorkerOptions(config);
	const workerOptions = /** @type {NormalizedWorkerOptions} */ (normalizedOptions.workerOptions);
	const { externalWorkers } = normalizedOptions;
	const workerName = config.name ?? 'sveltekit-cloudflare-worker';
	const compatibilityFlags = new Set(workerOptions.compatibilityFlags ?? []);
	compatibilityFlags.add('nodejs_als');
	if (compatibilityFlags.has('nodejs_compat')) compatibilityFlags.add('enable_nodejs_fs_module');

	const assets = mapAssets(workerOptions.assets);
	const variables = resolveVariables(config, configPath, workerOptions.bindings);
	const workerBindings = [...mapRuntimeBindings(workerOptions, variables, workerName, 'worker')];
	if (assets.binding) workerBindings.push(Assets.local(assets.binding));
	const platformBindings = mapRuntimeBindings(workerOptions, variables, workerName, 'platform');

	assertSupported(workerOptions, externalWorkers);

	return {
		workerOptions: {
			main,
			compatibilityDate: workerOptions.compatibilityDate,
			compatibilityFlags: [...compatibilityFlags],
			viteEnvironments: { entry: 'worker' },
			skipEnvironments: ['ssr'],
			worker: {
				name: workerName,
				bindings: workerBindings,
				durableObjectNamespaces: ownedDurableObjects(workerOptions.durableObjects, workerName),
				workflows: ownedWorkflows(workerOptions.workflows, workerName),
				queueConsumers: mapQueueConsumers(workerOptions.queueConsumers),
				crons: Array.isArray(config.triggers?.crons) ? config.triggers.crons : undefined,
				tails: mapTailNames(workerOptions.tails),
				streamingTails: mapTailNames(workerOptions.streamingTails),
				assets: assets.options,
				cache: workerOptions.cache,
				logging: { verbose }
			}
		},
		platformProxyOptions: {
			name: `${workerName}:sveltekit`,
			compatibilityDate: workerOptions.compatibilityDate,
			compatibilityFlags: [...compatibilityFlags],
			bindings: platformBindings
		},
		assetsBinding: assets.binding,
		workflowBindings: Object.keys(workerOptions.workflows ?? {}),
		tcpListener
	};
}

/**
 * @param {NormalizedWorkerOptions} workerOptions
 * @param {Record<string, unknown> | undefined} variables
 * @param {string} workerName
 * @param {'worker' | 'platform'} target
 * @returns {import('@distilled.cloud/cloudflare-runtime').BindingHooks}
 */
function mapRuntimeBindings(workerOptions, variables, workerName, target) {
	return /** @type {import('@distilled.cloud/cloudflare-runtime').BindingHooks} */ ([
		...mapVariables(variables),
		...mapBindings(workerOptions.kvNamespaces, (binding, value) =>
			KvNamespace.local({ binding, id: value.id })
		),
		...mapBindings(workerOptions.r2Buckets, (binding, value) =>
			R2Bucket.local({ binding, id: value.id })
		),
		...mapBindings(workerOptions.d1Databases, (binding, value) =>
			D1.local({ binding, id: value.id })
		),
		...mapBindings(workerOptions.queueProducers, (binding, value) =>
			Queue.local({ binding, queueName: value.queueName, deliveryDelay: value.deliveryDelay })
		),
		...mapBindings(workerOptions.analyticsEngineDatasets, (binding, value) =>
			AnalyticsEngine.local(binding, value.dataset ?? binding)
		),
		...mapBindings(workerOptions.ratelimits, (binding, value) =>
			RateLimit.local({
				binding,
				namespaceId: value.namespace_id,
				simple: value.simple
			})
		),
		...mapDurableObjects(workerOptions.durableObjects, workerName, target),
		...mapWorkflows(workerOptions.workflows, workerName, target),
		...mapServices(workerOptions.serviceBindings, workerName, target)
	]);
}

/** @param {Record<string, unknown> | undefined} variables */
function mapVariables(variables) {
	return Object.entries(variables ?? {}).map(([binding, value]) => Json.local(binding, value));
}

/** @param {Record<string, unknown>} config @param {string | null} configPath @param {Record<string, unknown> | undefined} fallback */
function resolveVariables(config, configPath, fallback) {
	if (!configPath) return fallback;
	const values = unstable_getVarsForDev(
		configPath,
		undefined,
		config.vars,
		undefined,
		true,
		config.secrets
	);
	return Object.fromEntries(
		Object.entries(values).map(([binding, value]) => [binding, value.value])
	);
}

/**
 * @template T
 * @template U
 * @param {Record<string, T> | undefined} values
 * @param {(binding: string, value: T) => U} map
 * @returns {U[]}
 */
function mapBindings(values, map) {
	return Object.entries(values ?? {}).map(([binding, value]) => map(binding, value));
}

/**
 * @param {Record<string, { className: string, scriptName?: string }> | undefined} values
 * @param {string} workerName
 * @param {'worker' | 'platform'} target
 */
function mapDurableObjects(values, workerName, target) {
	return mapBindings(values, (binding, value) =>
		DurableObjectNamespace.local({
			binding,
			className: value.className,
			scriptName: resolveScriptName(value.scriptName, workerName, target)
		})
	);
}

/**
 * @param {Record<string, { name: string, className: string, scriptName?: string }> | undefined} values
 * @param {string} workerName
 * @param {'worker' | 'platform'} target
 */
function mapWorkflows(values, workerName, target) {
	return mapBindings(values, (binding, value) =>
		Workflows.local({
			binding,
			workflowName: value.name,
			className: value.className,
			scriptName: resolveScriptName(value.scriptName, workerName, target)
		})
	);
}

/**
 * @param {Record<string, { name: string, entrypoint?: string, props?: Record<string, unknown> }> | undefined} values
 * @param {string} workerName
 * @param {'worker' | 'platform'} target
 */
function mapServices(values, workerName, target) {
	return mapBindings(values, (binding, value) =>
		value.name === workerName && target === 'worker'
			? Service.self(binding, { entrypoint: value.entrypoint })
			: Service.local({
					binding,
					scriptName: value.name,
					entrypoint: value.entrypoint,
					props: value.props
				})
	);
}

/**
 * @param {string | undefined} configuredScriptName
 * @param {string} workerName
 * @param {'worker' | 'platform'} target
 */
function resolveScriptName(configuredScriptName, workerName, target) {
	if (configuredScriptName) return configuredScriptName;
	return target === 'platform' ? workerName : undefined;
}

/** @param {Record<string, { className: string, scriptName?: string, useSQLite?: boolean }> | undefined} values @param {string} workerName */
function ownedDurableObjects(values, workerName) {
	const classes = new Map();
	for (const value of Object.values(values ?? {})) {
		if (value.scriptName && value.scriptName !== workerName) continue;
		classes.set(value.className, { className: value.className, sql: value.useSQLite === true });
	}
	return [...classes.values()];
}

/** @param {Record<string, { name: string, className: string, scriptName?: string, stepLimit?: number }> | undefined} values @param {string} workerName */
function ownedWorkflows(values, workerName) {
	const workflows = new Map();
	for (const value of Object.values(values ?? {})) {
		if (value.scriptName && value.scriptName !== workerName) continue;
		workflows.set(value.name, {
			workflowName: value.name,
			className: value.className,
			...(typeof value.stepLimit === 'number' ? { stepLimit: value.stepLimit } : {})
		});
	}
	return [...workflows.values()];
}

/** @param {Record<string, Record<string, unknown>> | undefined} values */
function mapQueueConsumers(values) {
	return Object.entries(values ?? {}).map(([queueName, value]) => ({ queueName, ...value }));
}

/** @param {Array<{ name: string }> | undefined} tails */
function mapTailNames(tails) {
	return tails?.map((tail) => tail.name);
}

/** @param {Record<string, unknown> | undefined} assets */
function mapAssets(assets) {
	if (!assets) return { binding: undefined, options: undefined };
	const routerConfig = toRecord(assets.routerConfig);
	const assetConfig = toRecord(assets.assetConfig);
	const configuredRunWorkerFirst = assets.run_worker_first;
	const normalizedRunWorkerFirst =
		typeof configuredRunWorkerFirst === 'boolean'
			? configuredRunWorkerFirst
			: Array.isArray(configuredRunWorkerFirst)
				? configuredRunWorkerFirst.filter((route) => typeof route === 'string')
				: undefined;
	return {
		binding: typeof assets.binding === 'string' ? assets.binding : undefined,
		options: {
			runWorkerFirst:
				normalizedRunWorkerFirst ??
				(Array.isArray(routerConfig.invoke_user_worker_ahead_of_assets)
					? routerConfig.invoke_user_worker_ahead_of_assets.filter(
							(route) => typeof route === 'string'
						)
					: routerConfig.invoke_user_worker_ahead_of_assets === true),
			htmlHandling:
				/** @type {import('@distilled.cloud/cloudflare-runtime').Assets['htmlHandling']} */ (
					assetConfig.html_handling
				),
			notFoundHandling:
				/** @type {import('@distilled.cloud/cloudflare-runtime').Assets['notFoundHandling']} */ (
					assetConfig.not_found_handling
				)
		}
	};
}

/** @param {Record<string, unknown>} config */
function assertPreNormalizationSupported(config) {
	if (hasValues(config.containers)) {
		throw new Error(
			'Distilled local development does not yet support these Wrangler bindings: containers.'
		);
	}

	const scheduledWorkflows = Array.isArray(config.workflows)
		? config.workflows
				.map(toRecord)
				.filter((workflow) => hasWorkflowSchedules(workflow.schedules))
				.map((workflow) =>
					typeof workflow.binding === 'string' ? workflow.binding : 'unnamed Workflow'
				)
		: [];
	if (scheduledWorkflows.length > 0) {
		throw new Error(
			`Distilled local development does not yet support Wrangler Workflow schedules: ${scheduledWorkflows.join(', ')}.`
		);
	}
}

/** @param {unknown} schedules */
function hasWorkflowSchedules(schedules) {
	if (typeof schedules === 'string') return schedules.length > 0;
	return Array.isArray(schedules) && schedules.length > 0;
}

/**
 * @param {unknown} configuredListeners
 * @returns {{ address: string, port: number } | undefined}
 */
function resolveTcpListener(configuredListeners) {
	if (!Array.isArray(configuredListeners) || configuredListeners.length === 0) return undefined;
	if (configuredListeners.length > 1) {
		throw new Error(
			`Distilled local development supports one Wrangler TCP connect listener; received ${configuredListeners.length}.`
		);
	}

	const listener = toRecord(configuredListeners[0]);
	if (listener.protocol !== 'tcp') {
		throw new Error(
			`Distilled local development supports only Wrangler connect protocol "tcp"; received ${JSON.stringify(listener.protocol)}.`
		);
	}
	const port = listener.port;
	if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(
			`Distilled local development requires a Wrangler TCP connect port between 1 and 65535; received ${JSON.stringify(port)}.`
		);
	}

	const address = listener.address === undefined ? '127.0.0.1' : listener.address;
	if (address !== '127.0.0.1') {
		throw new Error(
			`Distilled local development supports Wrangler TCP connect listeners only on 127.0.0.1; received ${JSON.stringify(address)}.`
		);
	}

	return { address, port };
}

/** @param {Record<string, unknown>} config */
function assertNoRemoteBindings(config) {
	const queues = toRecord(config.queues);
	const families = [
		['KV', config.kv_namespaces],
		['R2', config.r2_buckets],
		['D1', config.d1_databases],
		['Queue', queues.producers],
		['Analytics Engine', config.analytics_engine_datasets],
		['Rate Limit', config.ratelimits],
		['service', config.services]
	];
	const remoteBindings = [];
	for (const [family, values] of families) {
		if (!Array.isArray(values)) continue;
		for (const value of values) {
			const binding = toRecord(value);
			if (binding.remote !== true) continue;
			const name = binding.binding ?? binding.name ?? binding.queue;
			remoteBindings.push(typeof name === 'string' ? `${family} ${name}` : family);
		}
	}
	if (remoteBindings.length > 0) {
		throw new Error(
			`Distilled local development does not support Wrangler remote bindings: ${remoteBindings.join(', ')}.`
		);
	}
}

/** @param {Record<string, unknown>} worker @param {unknown[]} externalWorkers */
function assertSupported(worker, externalWorkers) {
	const unsupportedKeys = {
		textBlobBindings: 'text blobs',
		dataBlobBindings: 'data blobs',
		wasmBindings: 'Wasm bindings',
		unsafeBindings: 'unsafe bindings',
		ai: 'AI',
		aiSearchNamespaces: 'AI Search',
		aiSearchInstances: 'AI Search instances',
		agentMemory: 'agent memory',
		artifacts: 'artifacts',
		browserRendering: 'browser rendering',
		dispatchNamespaces: 'dispatch namespaces',
		email: 'email',
		flagship: 'Flagship',
		helloWorld: 'Hello World',
		hyperdrives: 'Hyperdrive',
		images: 'images',
		media: 'media',
		mtlsCertificates: 'mTLS certificates',
		pipelines: 'pipelines',
		r2Sql: 'R2 SQL',
		secretsStoreSecrets: 'secrets store',
		stream: 'streams',
		vectorize: 'Vectorize',
		versionMetadata: 'version metadata',
		vpcServices: 'VPC services',
		vpcNetworks: 'VPC networks',
		websearch: 'web search',
		workerLoaders: 'worker loaders',
		additionalUnboundDurableObjects: 'unbound Durable Objects'
	};
	const handled = new Set([
		'compatibilityDate',
		'compatibilityFlags',
		'rootPath',
		'modulesRules',
		'zone',
		'bindings',
		'kvNamespaces',
		'r2Buckets',
		'd1Databases',
		'queueProducers',
		'queueConsumers',
		'analyticsEngineDatasets',
		'workflows',
		'durableObjects',
		'ratelimits',
		'serviceBindings',
		'tails',
		'streamingTails',
		'assets',
		'cache',
		...Object.keys(unsupportedKeys)
	]);
	const configured = Object.entries(unsupportedKeys)
		.filter(([key]) => hasValues(worker[key]))
		.map(([, name]) => name);
	if (hasValues(externalWorkers)) configured.push('external Workers');
	for (const [key, value] of Object.entries(worker)) {
		if (!handled.has(key) && hasValues(value)) configured.push(key);
	}
	if (configured.length > 0) {
		throw new Error(
			`Distilled local development does not yet support these Wrangler bindings: ${configured.join(', ')}.`
		);
	}
}

/** @param {unknown} value */
function hasValues(value) {
	if (value === undefined || value === null || value === false) return false;
	if (Array.isArray(value)) return value.some(hasValues);
	if (typeof value === 'object') return Object.values(value).some(hasValues);
	return true;
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function toRecord(value) {
	return value && typeof value === 'object' && !Array.isArray(value)
		? /** @type {Record<string, unknown>} */ (value)
		: {};
}

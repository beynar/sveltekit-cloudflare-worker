import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USER_HOOKS_ID = 'virtual:sveltekit-cloudflare-worker/user-hooks';
const WORKER_ID = 'virtual:sveltekit-cloudflare-worker/worker';
const RESOLVED_USER_HOOKS_ID = `\0${USER_HOOKS_ID}`;
const RESOLVED_WORKER_ID = `\0${WORKER_ID}`;
export const NODE_DEV_HOOK_BRIDGE = fileURLToPath(
	new URL('./node-dev-hooks.server.js', import.meta.url)
);

/**
 * Install the package-owned server hook while preserving the user's configured hook module.
 *
 * @param {{
 *   root: string,
 *   workerFile: string,
 *   userHooksFile: string,
 *   refreshPlatformProxy(): Promise<void>,
 *   updateWorkerEntry(): Promise<void>
 * }} input
 * @returns {import('vite').Plugin[]}
 */
export function nodeDevIntegration({
	root,
	workerFile,
	userHooksFile,
	refreshPlatformProxy,
	updateWorkerEntry
}) {
	let projectRoot = root;
	let workerPath = path.resolve(projectRoot, workerFile);
	let userHooksPath = path.resolve(projectRoot, userHooksFile);
	let isDevelopment = true;

	/** @type {import('vite').Plugin} */
	const applicationModules = {
		name: 'sveltekit-cloudflare-worker:node-modules',
		enforce: 'pre',
		config(config, environment) {
			isDevelopment = environment.command === 'serve';
			projectRoot = config.root ? path.resolve(config.root) : process.cwd();
			workerPath = path.resolve(projectRoot, workerFile);
			userHooksPath = path.resolve(projectRoot, userHooksFile);
		},
		applyToEnvironment: (environment) => environment.name === 'ssr',
		resolveId(id) {
			if (id === USER_HOOKS_ID) return RESOLVED_USER_HOOKS_ID;
			if (id === WORKER_ID) return RESOLVED_WORKER_ID;
		},
		async load(id) {
			if (id === RESOLVED_WORKER_ID) {
				if (!isDevelopment) {
					return 'export const fetch = (_request, _env, _ctx, next) => next();';
				}
				return `
import * as worker from ${JSON.stringify(workerPath)};
export const fetch = worker.fetch ?? ((_request, _env, _ctx, next) => next());
`;
			}
			if (id !== RESOLVED_USER_HOOKS_ID) return;

			const resolved = await this.resolve(userHooksPath, undefined, { skipSelf: true });
			if (!resolved) {
				this.addWatchFile(path.dirname(userHooksPath));
				return 'export {};';
			}
			this.addWatchFile(resolved.id);
			return `export * from ${JSON.stringify(resolved.id)};`;
		}
	};

	/** @type {import('vite').Plugin} */
	const reload = {
		name: 'sveltekit-cloudflare-worker:reload-dev-modules',
		apply: 'serve',
		configureServer(server) {
			server.watcher.add(path.dirname(userHooksPath));
		},
		async hotUpdate(context) {
			if (this.environment.name !== 'ssr') return;
			if (isUserHooksPath(context.file, userHooksPath)) {
				const moduleGraph = this.environment.moduleGraph;
				const userHooksModule = moduleGraph.getModuleById(RESOLVED_USER_HOOKS_ID);
				if (!userHooksModule) return;
				moduleGraph.invalidateModule(userHooksModule);
				return [...new Set([...context.modules, userHooksModule])];
			}

			if (path.resolve(context.file) !== workerPath) return;
			await updateWorkerEntry();
			await refreshPlatformProxy();
		}
	};

	return [applicationModules, nodeCloudflareWorkersShim(), reload];
}

/** @param {string} file @param {string} configuredPath */
function isUserHooksPath(file, configuredPath) {
	const resolvedFile = path.resolve(file);
	return resolvedFile === configuredPath || resolvedFile.startsWith(`${configuredPath}.`);
}

/** @returns {import('vite').Plugin} */
function nodeCloudflareWorkersShim() {
	const moduleId = '\0sveltekit-cloudflare-worker:cloudflare-workers';
	return {
		name: 'sveltekit-cloudflare-worker:cloudflare-workers-shim',
		apply: 'serve',
		enforce: 'pre',
		applyToEnvironment: (environment) => environment.name === 'ssr',
		resolveId(id) {
			if (id === 'cloudflare:workers') return moduleId;
		},
		load(id) {
			if (id !== moduleId) return;
			return `
export class DurableObject {}
export class WorkflowEntrypoint {}
export class WorkerEntrypoint {}
export class RpcTarget {}
`;
		}
	};
}

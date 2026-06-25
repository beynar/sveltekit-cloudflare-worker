import path from 'node:path';
import { isCSSRequest } from 'vite';
import { toViteImport } from './sveltekit-dev-ssr-strings.js';

export const INLINE_STYLES_ENDPOINT = '/__sveltekit-cloudflare-worker/inline-styles';

const VITE_CSS_QUERY_REGEX = /(?:\?|&)(?:raw|url|inline)(?:&|$)/;

/**
 * @typedef {{
 *   component?: string,
 *   universal?: string
 * }} SvelteKitNode
 *
 * @typedef {{
 *   nodes: SvelteKitNode[]
 * }} SvelteKitManifestData
 *
 * @typedef {{
 *   url: string,
 *   ssrTransformResult?: import('vite').TransformResult | null,
 *   transformResult?: import('vite').TransformResult | null,
 *   importedModules: Set<SvelteKitDevModuleNode>
 * }} SvelteKitDevModuleNode
 */

/**
 * @param {{
 *   root: string,
 *   vite: import('vite').ViteDevServer,
 *   manifestData: SvelteKitManifestData
 * }} options
 */
export function createInlineStylesMiddleware({ root, vite, manifestData }) {
	/**
	 * @param {import('node:http').IncomingMessage} request
	 * @param {import('node:http').ServerResponse} response
	 * @param {(error?: unknown) => void} next
	 */
	return async function inlineStylesMiddleware(request, response, next) {
		const url = new URL(request.url ?? '/', 'http://localhost');
		if (url.pathname !== INLINE_STYLES_ENDPOINT) {
			next();
			return;
		}

		if (request.method !== 'GET') {
			sendJson(response, 405, { error: 'Method not allowed' });
			return;
		}

		const index = Number(url.searchParams.get('node'));
		const node = Number.isInteger(index) ? manifestData.nodes[index] : undefined;
		if (!node) {
			sendJson(response, 400, {
				error: `Unknown SvelteKit node index ${url.searchParams.get('node')}`
			});
			return;
		}

		try {
			const styles = await collectInlineStylesForNode({ root, vite, node });
			sendJson(response, 200, styles);
		} catch (error) {
			next(error);
		}
	};
}

/**
 * @param {{
 *   root?: string,
 *   vite: import('vite').ViteDevServer,
 *   node: SvelteKitNode
 * }} options
 * @returns {Promise<Record<string, string>>}
 */
export async function collectInlineStylesForNode({ root = process.cwd(), vite, node }) {
	/** @type {Set<SvelteKitDevModuleNode>} */
	const deps = new Set();

	for (const file of [node.component, node.universal]) {
		if (!file) continue;

		const moduleNodes = await getEntryModuleNodes(vite, root, file);
		for (const moduleNode of moduleNodes) {
			await findDeps(vite, moduleNode, deps);
		}
	}

	/** @type {Record<string, string>} */
	const styles = {};

	for (const dep of deps) {
		if (!isCSSRequest(dep.url) || VITE_CSS_QUERY_REGEX.test(dep.url)) continue;

		const inlineCssUrl = dep.url.includes('?')
			? dep.url.replace('?', '?inline&')
			: dep.url + '?inline';

		try {
			styles[dep.url] = await loadInlineCss(vite, inlineCssUrl);
		} catch {
			// Same dev-mode tolerance as SvelteKit: Vite can report CSS from dynamic imports
			// that are not loadable in the current SSR pass.
		}
	}

	return styles;
}

/**
 * @param {import('vite').ViteDevServer} vite
 * @param {string} root
 * @param {string} file
 */
async function getEntryModuleNodes(vite, root, file) {
	const moduleNode = await getServerModuleByUrl(vite, toViteImport(file));
	if (moduleNode) return [toDevModuleNode(moduleNode)];

	return Array.from(
		getServerModulesByFile(vite, toAbsoluteFile(root, file)) ?? [],
		toDevModuleNode
	);
}

/**
 * SvelteKit uses `vite.ssrLoadModule(inlineCssUrl)` here. Under Cloudflare's
 * Vite environment, constructing the Node-side SSR module runner from our
 * middleware can crash because the workerd runner channel is not connected.
 * The client transform still uses Vite's CSS pipeline and gives us the same
 * inline CSS module source without evaluating it in the runner.
 *
 * @param {import('vite').ViteDevServer} vite
 * @param {string} inlineCssUrl
 */
async function loadInlineCss(vite, inlineCssUrl) {
	const result = await transformClientRequest(vite, inlineCssUrl);

	if (!result?.code) {
		throw new Error(`Could not transform SvelteKit dev inline CSS ${inlineCssUrl}.`);
	}

	return parseDefaultStringExport(result.code, inlineCssUrl);
}

/**
 * @param {import('vite').ViteDevServer} vite
 * @param {string} url
 */
function transformClientRequest(vite, url) {
	return vite.environments
		? vite.environments.client.transformRequest(url)
		: vite.transformRequest(url);
}

/**
 * @param {string} code
 * @param {string} id
 */
function parseDefaultStringExport(code, id) {
	const match = /^export default\s+(.+?);?\s*$/s.exec(code.trim());
	if (!match) {
		throw new Error(`Unexpected Vite inline CSS module for ${id}.`);
	}

	const value = JSON.parse(match[1]);
	if (typeof value !== 'string') {
		throw new Error(`Vite inline CSS module for ${id} did not export a string.`);
	}

	return value;
}

/**
 * Copied from SvelteKit's dev manifest CSS traversal. Keep this shape close to
 * SvelteKit so contract tests catch private API drift.
 *
 * @param {import('vite').ViteDevServer} vite
 * @param {SvelteKitDevModuleNode} node
 * @param {Set<SvelteKitDevModuleNode>} deps
 */
async function findDeps(vite, node, deps) {
	/** @type {Promise<void>[]} */
	const branches = [];

	/** @param {SvelteKitDevModuleNode} moduleNode */
	async function add(moduleNode) {
		if (!deps.has(moduleNode)) {
			deps.add(moduleNode);
			await findDeps(vite, moduleNode, deps);
		}
	}

	/** @param {string} url */
	async function addByUrl(url) {
		const moduleNode = await getServerModuleByUrl(vite, url);
		if (moduleNode) {
			await add(toDevModuleNode(moduleNode));
		}
	}

	const transformResult = node.ssrTransformResult || node.transformResult;

	if (transformResult) {
		if (transformResult.deps) {
			transformResult.deps.forEach((url) => branches.push(addByUrl(url)));
		}

		if (transformResult.dynamicDeps) {
			transformResult.dynamicDeps.forEach((url) => branches.push(addByUrl(url)));
		}
	} else {
		node.importedModules.forEach((moduleNode) => branches.push(add(moduleNode)));
	}

	await Promise.all(branches);
}

/**
 * @param {unknown} moduleNode
 * @returns {SvelteKitDevModuleNode}
 */
function toDevModuleNode(moduleNode) {
	return /** @type {SvelteKitDevModuleNode} */ (moduleNode);
}

/**
 * @param {import('vite').ViteDevServer} vite
 * @param {string} url
 */
function getServerModuleByUrl(vite, url) {
	return vite.environments
		? vite.environments.ssr.moduleGraph.getModuleByUrl(url)
		: vite.moduleGraph.getModuleByUrl(url, true);
}

/**
 * @param {import('vite').ViteDevServer} vite
 * @param {string} file
 */
function getServerModulesByFile(vite, file) {
	return vite.environments
		? vite.environments.ssr.moduleGraph.getModulesByFile(file)
		: vite.moduleGraph.getModulesByFile(file);
}

/**
 * @param {string} root
 * @param {string} file
 */
function toAbsoluteFile(root, file) {
	return path.isAbsolute(file) ? file : path.resolve(root, file);
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(response, status, body) {
	response.statusCode = status;
	response.setHeader('content-type', 'application/json');
	response.end(JSON.stringify(body));
}

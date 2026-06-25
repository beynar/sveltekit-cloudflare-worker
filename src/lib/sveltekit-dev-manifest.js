import path from 'node:path';
import {
	serialize,
	toFsPath,
	toJsString,
	toPosix,
	toViteImport
} from './sveltekit-dev-ssr-strings.js';

/**
 * @typedef {{
 *   kit: {
 *     appDir: string,
 *     outDir: string,
 *     paths: { base: string },
 *     router: { resolution: string }
 *   }
 * }} SvelteKitConfig
 *
 * @typedef {{
 *   component?: string,
 *   universal?: string,
 *   server?: string,
 *   page_options?: Record<string, unknown>
 * }} SvelteKitNode
 *
 * @typedef {{
 *   layouts: (number | undefined)[],
 *   errors: number[],
 *   leaf: number
 * }} SvelteKitRoutePage
 *
 * @typedef {{
 *   id: string,
 *   pattern: RegExp,
 *   params: unknown[],
 *   page: SvelteKitRoutePage | null,
 *   endpoint: { file: string } | null
 * }} SvelteKitRoute
 *
 * @typedef {{
 *   assets: { file: string, type: string | null }[],
 *   nodes: SvelteKitNode[],
 *   routes: SvelteKitRoute[],
 *   matchers: Record<string, string>
 * }} SvelteKitManifestData
 *
 * @typedef {{
 *   file: string,
 *   hash: string
 * }} SvelteKitRemote
 *
 */

/**
 * @param {{
 *   root: string,
 *   config: SvelteKitConfig,
 *   manifestData: SvelteKitManifestData,
 *   kitRoot: string,
 *   remotes: SvelteKitRemote[],
 *   serverAssets: Record<string, number>,
 *   inlineStyleEndpoint: string
 * }} options
 */
export function buildManifestExpression({
	root,
	config,
	manifestData,
	kitRoot,
	remotes,
	serverAssets,
	inlineStyleEndpoint
}) {
	const appPath = toFsPath(config.kit.outDir);
	const runtimePath =
		path.relative(root, kitRoot).startsWith('..') || path.isAbsolute(path.relative(root, kitRoot))
			? toFsPath(path.join(kitRoot, 'src/runtime'))
			: '/' + toPosix(path.relative(root, path.join(kitRoot, 'src/runtime')));
	const client = buildClientManifest({ appPath, runtimePath, config, manifestData });

	return `{
\tappDir: ${toJsString(config.kit.appDir)},
\tappPath: ${toJsString(config.kit.appDir)},
\tassets: new Set(${JSON.stringify(manifestData.assets.map((asset) => asset.file))}),
\tmimeTypes: ${JSON.stringify(toMimeTypes(manifestData))},
\t_: {
\t\tclient: ${serialize(client)},
\t\tnodes: [
\t\t\t${manifestData.nodes
		.map((node, index) =>
			buildNodeLoader({
				node,
				index,
				inlineStyleEndpoint
			})
		)
		.join(',\n\t\t\t')}
	\t\t],
\t\tremotes: ${buildRemoteLoaders(remotes)},
	\t\troutes: [
\t\t\t${manifestData.routes.map(buildRoute).filter(Boolean).join(',\n\t\t\t')}
\t\t],
\t\tprerendered_routes: new Set(),
	\t\tmatchers: async () => {
	\t\t\tconst matchers = {};
\t\t\t${Object.entries(manifestData.matchers)
		.map(
			([name, file]) =>
				`matchers[${toJsString(name)}] = (await import(${toJsString(toViteImport(file))})).match;`
		)
		.join('\n\t\t\t')}
	\t\t\treturn matchers;
	\t\t},
\t\tserver_assets: ${serialize(serverAssets)}
	\t}
		}`;
}

/**
 * @param {SvelteKitRemote[]} remotes
 */
function buildRemoteLoaders(remotes) {
	if (remotes.length === 0) return '{}';

	return `{
\t\t\t${remotes
		.map(
			(remote) =>
				`${toJsString(remote.hash)}: async () => {
\t\t\t\tconst module = await import(${toJsString(toViteImport(toRemoteSsrSource(remote.file)))});
\t\t\t\tconst { init_remote_functions } = await import('@sveltejs/kit/internal');
\t\t\t\tinit_remote_functions(module, ${toJsString(remote.file)}, ${toJsString(remote.hash)});
\t\t\t\treturn { default: module };
\t\t\t}`
		)
		.join(',\n\t\t\t')}
\t\t}`;
}

/**
 * @param {string} file
 */
function toRemoteSsrSource(file) {
	return file.replace(/\.remote(\.[^.]+)$/, '.skcw-remote$1');
}

/**
 * @param {{
 *   appPath: string,
 *   runtimePath: string,
 *   config: SvelteKitConfig,
 *   manifestData: SvelteKitManifestData
 * }} options
 */
function buildClientManifest({ appPath, runtimePath, config, manifestData }) {
	return {
		start: `${runtimePath}/client/entry.js`,
		app: `${appPath}/generated/client/app.js`,
		imports: [],
		stylesheets: [],
		fonts: [],
		uses_env_dynamic_public: true,
		nodes:
			config.kit.router.resolution === 'client'
				? undefined
				: manifestData.nodes.map((node, index) =>
						node.component || node.universal
							? `${config.kit.paths.base}${appPath}/generated/client/nodes/${index}.js`
							: undefined
					),
		routes:
			config.kit.router.resolution === 'client'
				? undefined
				: manifestData.routes
						.map((route) => {
							if (!route.page) return null;
							return {
								id: route.id,
								pattern: route.pattern,
								params: route.params,
								layouts: route.page.layouts.map((layout) =>
									layout !== undefined
										? [Boolean(manifestData.nodes[layout].server), layout]
										: undefined
								),
								errors: route.page.errors,
								leaf: [Boolean(manifestData.nodes[route.page.leaf].server), route.page.leaf]
							};
						})
						.filter(Boolean)
	};
}

/**
 * @param {{
 *   node: SvelteKitNode,
 *   index: number,
 *   inlineStyleEndpoint: string
 * }} options
 */
function buildNodeLoader({ node, index, inlineStyleEndpoint }) {
	const lines = [
		'async () => {',
		'\tconst node = {',
		`\t\tindex: ${index},`,
		`\t\tuniversal_id: ${serialize(node.universal)},`,
		`\t\tserver_id: ${serialize(node.server)},`,
		'\t\timports: [],',
		'\t\tstylesheets: [],',
		'\t\tfonts: [],',
		`\t\tinline_styles: ${buildInlineStylesLoader({ index, inlineStyleEndpoint })}`
	];

	if (node.component) {
		lines.push(`,\n\t\tcomponent: ${buildComponentLoader(node.component)}`);
	}
	if (node.universal) {
		if (node.page_options?.ssr === false) {
			lines.push(`,\n\t\tuniversal: ${serialize(node.page_options)}`);
		} else {
			lines.push(`,\n\t\tuniversal: await import(${toJsString(toViteImport(node.universal))})`);
		}
	}
	if (node.server) {
		lines.push(`,\n\t\tserver: await import(${toJsString(toViteImport(node.server))})`);
	}

	lines.push('\n\t};', '\treturn node;', '}');
	return lines.join('\n');
}

/**
 * @param {{ index: number, inlineStyleEndpoint: string }} options
 */
function buildInlineStylesLoader({ index, inlineStyleEndpoint }) {
	if (!inlineStyleEndpoint) return 'async () => ({})';
	return `async () => loadInlineStyles(${index})`;
}

/**
 * @param {string} component
 */
function buildComponentLoader(component) {
	if (isDefaultErrorComponent(component)) {
		return 'async () => __sveltekitCloudflareWorkerDefaultError';
	}

	return `async () => (await import(${toJsString(toViteImport(component))})).default`;
}

/**
 * @param {string} component
 */
function isDefaultErrorComponent(component) {
	return /@sveltejs\/kit\/src\/runtime\/components\/.+\/error\.svelte$/.test(component);
}

/**
 * @param {SvelteKitRoute} route
 */
function buildRoute(route) {
	if (!route.page && !route.endpoint) return '';

	return `{
\t\t\t\tid: ${toJsString(route.id)},
\t\t\t\tpattern: ${route.pattern.toString()},
\t\t\t\tparams: ${serialize(route.params)},
\t\t\t\tpage: ${serialize(route.page)},
\t\t\t\tendpoint: ${
		route.endpoint ? `async () => import(${toJsString(toViteImport(route.endpoint.file))})` : 'null'
	},
\t\t\t\tendpoint_id: ${serialize(route.endpoint?.file)}
\t\t\t}`;
}

/**
 * @param {SvelteKitManifestData} manifestData
 */
function toMimeTypes(manifestData) {
	/** @type {Record<string, string>} */
	const mimeTypes = {};
	for (const asset of manifestData.assets) {
		if (!asset.type) continue;
		const extension = path.extname(asset.file);
		mimeTypes[extension] = asset.type;
	}
	return mimeTypes;
}

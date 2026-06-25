import path from 'node:path';
import { buildManifestExpression } from './sveltekit-dev-manifest.js';
import { toImportPath, toJsString } from './sveltekit-dev-ssr-strings.js';

const SVELTE_KIT_ASSETS = '/_svelte_kit_assets';
const SVELTE_KIT_ASSETS_MODULE = '$' + 'app/paths/internal/server';

/**
 * @typedef {{
 *   kit: {
 *     appDir: string,
 *     outDir: string,
 *     paths: { assets: string, base: string },
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
 */

/**
 * @param {{
 *   root: string,
 *   dir: string,
 *   kitRoot: string,
 *   config: SvelteKitConfig,
 *   manifestData: SvelteKitManifestData,
 *   remotes: SvelteKitRemote[],
 *   serverAssets: Record<string, number>,
 *   inlineStyleEndpoint: string
 * }} options
 */
export function buildSvelteKitDevSsrModule({
	root,
	dir,
	kitRoot,
	config,
	manifestData,
	remotes,
	serverAssets,
	inlineStyleEndpoint
}) {
	const serverImport = toImportPath(dir, path.join(kitRoot, 'src/runtime/server/index.js'));
	const sharedServerImport = toImportPath(dir, path.join(kitRoot, 'src/runtime/shared-server.js'));
	const featuresImport = toImportPath(dir, path.join(kitRoot, 'src/utils/features.js'));
	const assetsPath = config.kit.paths.assets ? SVELTE_KIT_ASSETS : config.kit.paths.base;
	const manifest = buildManifestExpression({
		root,
		config,
		manifestData,
		kitRoot,
		remotes,
		serverAssets,
		inlineStyleEndpoint
	});
	const assetFiles = JSON.stringify(manifestData.assets.map((asset) => asset.file));

	return `import { Server } from '${serverImport}';
import { check_feature } from '${featuresImport}';
import { set_fix_stack_trace } from '${sharedServerImport}';
import { set_assets } from '${SVELTE_KIT_ASSETS_MODULE}';
import { getContext } from 'svelte';

const assetFiles = new Set(${assetFiles});
const manifest = ${manifest};
const server = new Server(manifest);
const inlineStyleEndpoint = ${toJsString(inlineStyleEndpoint)};
const featureCheckAdapter = {
\tname: 'sveltekit-cloudflare-worker',
\tsupports: {
\t\tread: () => true
\t}
};
let currentFeatureContext;
let currentRequestOrigin = '';
let initialized;

set_fix_stack_trace((error) => error?.stack);
(globalThis as any).__SVELTEKIT_TRACK__ = (label) => {
\tif (!currentFeatureContext || currentFeatureContext.prerender === true) return;
\tcheck_feature(
\t\tcurrentFeatureContext.event.route.id,
\t\tcurrentFeatureContext.config,
\t\tlabel,
\t\tfeatureCheckAdapter
\t);
};

export async function respond(request, env, ctx) {
\tif (shouldUseAssetBinding(request)) {
\t\treturn env.ASSETS.fetch(request);
\t}

\tcurrentRequestOrigin = new URL(request.url).origin;
\tset_assets(${toJsString(assetsPath)});
\tinitialized ??= server.init({
\t\tenv,
\t\tread: (file) => readAsset(env, request, file)
\t});
\tawait initialized;

\treturn server.respond(request, {
\t\tplatform: {
\t\t\tenv,
\t\t\tctx,
\t\t\tcontext: ctx,
\t\t\tcaches,
\t\t\tcf: request.cf
\t\t},
\t\tread: (file) => readAsset(env, request, file),
\t\tbefore_handle(event, config, prerender, handle) {
\t\t\tcurrentFeatureContext = { event, config, prerender };
\t\t\treturn handle();
\t\t},
\t\tgetClientAddress() {
\t\t\treturn request.headers.get('cf-connecting-ip') ?? '';
\t\t}
\t});
}

async function loadInlineStyles(index) {
\tif (!currentRequestOrigin) return {};

\tconst url = new URL(inlineStyleEndpoint, currentRequestOrigin);
\turl.searchParams.set('node', String(index));

\tconst response = await fetch(url);
\tif (!response.ok) {
\t\tthrow new Error(
\t\t\t\`Could not load SvelteKit dev inline styles for node \${index}: \${response.status} \${response.statusText}\`
\t\t);
\t}

\treturn response.json();
}

async function readAsset(env, request, file) {
\tconst url = new URL('/' + file.replace(/^\\//, ''), request.url);
\tconst response = await env.ASSETS.fetch(url);
\tif (!response.ok || !response.body) {
\t\tthrow new Error(\`Could not read SvelteKit asset \${file}: \${response.status} \${response.statusText}\`);
\t}
\treturn response.body;
}

function shouldUseAssetBinding(request) {
\tconst pathname = new URL(request.url).pathname;
\tif (
\t\tpathname.startsWith('/@') ||
\t\tpathname.startsWith('/node_modules/') ||
\t\tpathname.startsWith('/.svelte-kit/') ||
\t\tpathname.startsWith('/src/') ||
\t\tpathname.startsWith('/favicon.')
\t) {
\t\treturn true;
\t}

\tconst file = pathname.replace(/^\\//, '');
\treturn assetFiles.has(file) || assetFiles.has(file + '/index.html');
}

function __sveltekitCloudflareWorkerDefaultError($$renderer) {
\t$$renderer.component(($$renderer2) => {
\t\tconst requestContext = getContext('__request__');
\t\tconst status = requestContext?.page?.status ?? 500;
\t\tconst message = requestContext?.page?.error?.message ?? 'Error';
\t\t$$renderer2.push(\`<h1>\${escapeHtml(status)}</h1> <p>\${escapeHtml(message)}</p>\`);
\t});
}

function escapeHtml(value) {
\treturn String(value)
\t\t.replaceAll('&', '&amp;')
\t\t.replaceAll('<', '&lt;')
\t\t.replaceAll('>', '&gt;')
\t\t.replaceAll('"', '&quot;')
\t\t.replaceAll("'", '&#39;');
}
`;
}

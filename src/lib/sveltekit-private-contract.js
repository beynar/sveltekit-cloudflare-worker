import { readFileSync } from 'node:fs';
import path from 'node:path';

const CONTRACTS = [
	{
		file: 'src/exports/vite/dev/index.js',
		checks: [
			['manifest refresh', 'function update_manifest()'],
			['route sync', '({ manifest_data } = sync.create(svelte_config));'],
			['manifest object', 'manifest = {'],
			['app directory', 'appDir: svelte_config.kit.appDir'],
			['client manifest', 'client: {'],
			['server asset metadata', 'server_assets: new Proxy('],
			['node loaders', 'nodes: manifest_data.nodes.map((node, index)'],
			['inline style loader', 'result.inline_styles = async () =>'],
			['inline style graph traversal', 'await find_deps(vite, module_node, deps);'],
			['inline css filter', 'isCSSRequest(dep.url) && !vite_css_query_regex.test(dep.url)'],
			['inline css loading', 'const mod = await vite.ssrLoadModule(inlineCssUrl);'],
			['dependency traversal helper', 'async function find_deps(vite, node, deps)'],
			['transformed static dependencies', 'transform_result.deps'],
			['transformed dynamic dependencies', 'transform_result.dynamicDeps'],
			['module graph lookup helper', 'function get_server_module_by_url(vite, url)'],
			['remote loader map', 'get remotes()'],
			[
				'remote module loader',
				'vite.ssrLoadModule(remote.file).then((module) => ({ default: module }))'
			],
			['route manifest', 'routes: compact('],
			['matcher loader', 'matchers: async () =>']
		]
	},
	{
		file: 'src/exports/vite/index.js',
		checks: [
			['remote registry', 'const remotes = [];'],
			['remote file hash', 'hash: hash(file)'],
			['remote registration', 'remotes.push(remote)'],
			[
				'remote metadata initializer',
				"import { init_remote_functions as $$_init_$$ } from '@sveltejs/kit/internal';"
			],
			['remote id initialization', '$$_init_$$($$_self_$$, ${s(file)}, ${s(remote.hash)});'],
			['remote export id', "fn.__.id = ${s(remote.hash)} + '/' + name"]
		]
	},
	{
		file: 'src/runtime/server/remote.js',
		checks: [
			['remote id format', "const [hash, name, additional_args] = id.split('/');"],
			['manifest remote table', 'const remotes = manifest._.remotes;'],
			['remote table loader', 'const module = await remotes[hash]();'],
			['remote export lookup', 'const fn = module.default[name];'],
			['remote URL prefix', 'url.pathname.startsWith(`${base}/${app_dir}/remote/`)']
		]
	}
];

/**
 * @param {{ kitRoot: string }} options
 */
export function assertSvelteKitPrivateContract({ kitRoot }) {
	for (const contract of CONTRACTS) {
		const source = readPrivateSource(kitRoot, contract.file);

		for (const [label, snippet] of contract.checks) {
			if (!source.includes(snippet)) {
				throw new Error(
					`sveltekit-cloudflare-worker dev SSR cannot run with this @sveltejs/kit install. ` +
						`Private SvelteKit contract changed in ${contract.file}: missing ${label}.`
				);
			}
		}
	}
}

/**
 * @param {string} kitRoot
 * @param {string} file
 */
function readPrivateSource(kitRoot, file) {
	const sourcePath = path.join(kitRoot, file);
	try {
		return readFileSync(sourcePath, 'utf-8');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read SvelteKit private source ${file}: ${message}`);
	}
}

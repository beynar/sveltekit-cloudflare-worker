import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { parse } from 'acorn';
import { KNOWN_HANDLERS } from './constants.js';
import { __sveltekitCloudflareWorkerWaitUntilLast } from './wait-until-last.js';

/** Internal modules written next to the composed `_worker.js`. */
export const USER_WORKER = '_user-worker.js';
export const SVELTEKIT_WORKER = '_sveltekit-worker.js';

const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith('_')));
const RESOLVE_EXTENSIONS = ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.cts', '.cjs', '.json'];
const PARSE_OPTIONS = /** @type {const} */ ({ ecmaVersion: 'latest', sourceType: 'module' });
/** SvelteKit's own aliases point at framework modules that cannot run in the Worker entry. */
const FRAMEWORK_ALIASES = new Set(['$app', '$env', '<sveltekit:generated>']);

/**
 * @typedef {{ handlers: string[], classes: string[] }} WorkerExports
 * @typedef {{ find: string | RegExp, replacement: string }} Alias
 */

/**
 * Bundle `src/worker.ts` for the production Worker.
 *
 * Imports resolve like in the application: Vite `resolve.alias` entries, application
 * package.json `imports` (`#lib/...`) with Vite-style extension lookup, and Node built-ins, which
 * stay external under the `node:` prefix (workerd provides them with `nodejs_compat`).
 *
 * @param {string} workerPath
 * @param {{ aliases?: readonly Alias[], logLevel?: 'silent' | 'warning' }} [options]
 * @returns {Promise<{ content: string, exports: WorkerExports, modules: { name: string, file: string }[] }>}
 */
export async function bundleWorker(workerPath, { aliases = [], logLevel = 'warning' } = {}) {
	const { build } = await import('esbuild');
	/** @type {Map<string, string>} */
	const wasm = new Map();
	const result = await build({
		entryPoints: [workerPath],
		write: false,
		metafile: true,
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2024',
		conditions: ['workerd', 'worker'],
		external: ['cloudflare:*', 'node:*'],
		resolveExtensions: RESOLVE_EXTENSIONS,
		plugins: [wasmPlugin(wasm), resolvePlugin(aliases)],
		logLevel
	});
	const [output] = Object.values(result.metafile.outputs);
	const content = result.outputFiles[0].text;
	return {
		content,
		exports: classifyWorkerExports(output.exports, content),
		modules: [...wasm].map(([name, file]) => ({ name, file }))
	};
}

/**
 * `import module from './x.wasm'` (or `x.wasm?module`) is a CompiledWasm module on Cloudflare.
 * Keep it external as a file next to the bundle: Wrangler's default module rules upload it as
 * CompiledWasm, and its default export is a WebAssembly.Module.
 * @param {Map<string, string>} modules output file name -> source path
 * @returns {import('esbuild').Plugin}
 */
function wasmPlugin(modules) {
	return {
		name: 'sveltekit-cloudflare-worker:wasm',
		setup(build) {
			build.onResolve({ filter: /\.wasm(\?module)?$/ }, async (args) => {
				if (args.pluginData?.wasm) return undefined;
				const resolved = await build.resolve(args.path.replace(/\?module$/, ''), {
					kind: args.kind,
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: { wasm: true, resolved: true }
				});
				if (resolved.errors.length > 0) return { errors: resolved.errors };
				const hash = createHash('sha256').update(readFileSync(resolved.path)).digest('hex');
				const name = `${path.basename(resolved.path, '.wasm')}-${hash.slice(0, 8)}.wasm`;
				modules.set(name, resolved.path);
				return { path: `./${name}`, external: true };
			});
		}
	};
}

/** @param {string} workerPath @param {readonly Alias[]} [aliases] */
export async function detectWorkerExports(workerPath, aliases) {
	return (await bundleWorker(workerPath, { aliases, logLevel: 'silent' })).exports;
}

/**
 * Export names declared by the entry file itself, without bundling. Used in development when the
 * full bundle fails (Vite-only imports, virtual modules). Every capitalized non-handler export is
 * a class candidate: an unused class wrapper is inert.
 * @param {string} workerPath
 * @returns {Promise<WorkerExports>}
 */
export async function detectWorkerExportsShallow(workerPath) {
	const { transform } = await import('esbuild');
	const { code } = await transform(readFileSync(workerPath, 'utf-8'), {
		loader: /\.[cm]?tsx?$/.test(workerPath) ? 'ts' : 'js',
		format: 'esm'
	});
	const names = [];
	for (const node of /** @type {any} */ (parse(code, PARSE_OPTIONS)).body) {
		if (node.type !== 'ExportNamedDeclaration') continue;
		if (node.declaration?.id) names.push(node.declaration.id.name);
		for (const declaration of node.declaration?.declarations ?? []) names.push(declaration.id.name);
		for (const specifier of node.specifiers) {
			names.push(specifier.exported.name ?? specifier.exported.value);
		}
	}
	return {
		handlers: names.filter((name) => KNOWN_HANDLERS.includes(name)),
		classes: names.filter((name) => !KNOWN_HANDLERS.includes(name) && /^[A-Z]/.test(name))
	};
}

/**
 * Handlers are recognized by name. Other exports are kept only when they are real classes: workerd
 * validates the export map, so ordinary values must stay private.
 * @param {string[]} exportNames
 * @param {string} bundledSource
 * @returns {WorkerExports}
 */
function classifyWorkerExports(exportNames, bundledSource) {
	const classBindings = new Set();
	/** @type {[local: string, exported: string][]} */
	const specifiers = [];
	for (const node of /** @type {any} */ (parse(bundledSource, PARSE_OPTIONS)).body) {
		if (node.type === 'ClassDeclaration') classBindings.add(node.id.name);
		if (node.type === 'VariableDeclaration') {
			for (const declaration of node.declarations) {
				if (declaration.init?.type === 'ClassExpression') classBindings.add(declaration.id.name);
			}
		}
		if (node.type === 'ExportNamedDeclaration') {
			for (const specifier of node.specifiers) {
				specifiers.push([specifier.local.name, specifier.exported.name]);
			}
		}
	}
	const classExports = new Set(
		specifiers.filter(([local]) => classBindings.has(local)).map(([, exported]) => exported)
	);
	return {
		handlers: exportNames.filter((name) => KNOWN_HANDLERS.includes(name)),
		classes: exportNames.filter((name) => name !== 'default' && classExports.has(name))
	};
}

/**
 * The production entry: SvelteKit's Worker behind the user `fetch(request, env, ctx, next)`,
 * the user's other handlers, and the user's classes as named exports.
 * @param {WorkerExports} exports
 */
export function createWorkerFacade({ handlers, classes }) {
	const lines = [
		'// Generated by sveltekit-cloudflare-worker.',
		`import svelteKit from './${SVELTEKIT_WORKER}';`,
		`import * as worker from './${USER_WORKER}';`,
		...classes.map((name) => `export { ${name} } from './${USER_WORKER}';`)
	];
	if (handlers.length === 0) return [...lines, 'export default svelteKit;', ''].join('\n');

	const entries = handlers.map((handler) =>
		handler === 'fetch'
			? `async fetch(request, env, ctx) {
		const { ctx: context, flush } = __sveltekitCloudflareWorkerWaitUntilLast(ctx);
		try {
			let response;
			const next = () => (response ??= svelteKit.fetch(request, env, context));
			return (await worker.fetch(request, env, context, next)) ?? (await next());
		} finally {
			flush();
		}
	}`
			: `async ${handler}(event, env, ctx) {
		const { ctx: context, flush } = __sveltekitCloudflareWorkerWaitUntilLast(ctx);
		try {
			return await worker.${handler}(event, env, context);
		} finally {
			flush();
		}
	}`
	);
	if (!handlers.includes('fetch')) entries.unshift('fetch: svelteKit.fetch');
	return [
		...lines,
		__sveltekitCloudflareWorkerWaitUntilLast.toString(),
		`export default {\n\t${entries.join(',\n\t')}\n};`,
		''
	].join('\n');
}

/**
 * Resolve Vite aliases, application `#imports` and Node built-ins like the application does.
 * @param {readonly Alias[]} aliases
 * @returns {import('esbuild').Plugin}
 */
function resolvePlugin(aliases) {
	const usable = aliases.filter(
		(alias) => typeof alias.find !== 'string' || !FRAMEWORK_ALIASES.has(alias.find)
	);
	return {
		name: 'sveltekit-cloudflare-worker:resolve',
		setup(build) {
			build.onResolve({ filter: /^[^./]/ }, async (args) => {
				if (args.pluginData?.resolved) return undefined;
				if (NODE_BUILTINS.has(args.path)) return { path: `node:${args.path}`, external: true };

				const target = args.path.startsWith('#')
					? packageImport(args)
					: usable.map((alias) => applyAlias(alias, args.path)).find(Boolean);
				if (!target) return undefined;

				const file = path.isAbsolute(target) ? findFile(target) : undefined;
				if (file) return { path: file };
				const result = await build.resolve(target, {
					kind: args.kind,
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: { resolved: true }
				});
				return result.errors.length > 0 ? { errors: result.errors } : result;
			});
		}
	};
}

/** @param {Alias} alias @param {string} id */
function applyAlias({ find, replacement }, id) {
	if (typeof find !== 'string') return find.test(id) ? id.replace(find, replacement) : undefined;
	if (id === find) return replacement;
	if (id.startsWith(`${find}/`)) return replacement + id.slice(find.length);
}

/**
 * Application package.json `imports`, resolved like Vite: the target may omit its extension or
 * use the emitted `.js` extension of a TypeScript file. Dependencies keep esbuild's resolution.
 * @param {import('esbuild').OnResolveArgs} args
 */
function packageImport(args) {
	if (args.importer.split(path.sep).includes('node_modules')) return undefined;
	const pkg = nearestPackageJson(args.resolveDir);
	if (!pkg?.json.imports) return undefined;
	const target = matchImports(pkg.json.imports, args.path);
	return target?.startsWith('./') ? path.resolve(pkg.directory, target) : target;
}

/** @param {string} directory @returns {{ directory: string, json: any } | undefined} */
function nearestPackageJson(directory) {
	for (let current = directory; ; current = path.dirname(current)) {
		const file = path.join(current, 'package.json');
		if (existsSync(file))
			return { directory: current, json: JSON.parse(readFileSync(file, 'utf-8')) };
		if (path.dirname(current) === current) return undefined;
	}
}

/** @param {Record<string, unknown>} imports @param {string} specifier */
function matchImports(imports, specifier) {
	if (specifier in imports) return pickCondition(imports[specifier]);
	for (const [key, value] of Object.entries(imports)) {
		const [prefix, suffix] = key.split('*');
		if (suffix === undefined || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
			continue;
		}
		const match = specifier.slice(prefix.length, specifier.length - suffix.length);
		return pickCondition(value)?.replaceAll('*', match);
	}
}

/** @param {unknown} value @returns {string | undefined} */
function pickCondition(value) {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(pickCondition).find(Boolean);
	if (value && typeof value === 'object') {
		const conditions = /** @type {Record<string, unknown>} */ (value);
		return ['workerd', 'worker', 'import', 'module', 'default']
			.filter((condition) => condition in conditions)
			.map((condition) => pickCondition(conditions[condition]))
			.find(Boolean);
	}
}

/** @param {string} file */
function findFile(file) {
	const candidates = [
		file,
		// TypeScript sources are imported with their emitted extension (`./index.js` -> `./index.ts`).
		file.replace(/\.(m|c)?js(x?)$/, (_, kind = '', jsx) => `.${kind}ts${jsx}`),
		...RESOLVE_EXTENSIONS.map((extension) => file + extension),
		...RESOLVE_EXTENSIONS.map((extension) => path.join(file, `index${extension}`))
	];
	return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

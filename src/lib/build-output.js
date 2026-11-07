import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import { BUILD_ENTRY_MARKER, bundleWorker, createWorkerFacade } from './worker-composition.js';
import { readWranglerConfig } from './wrangler-config.js';

const LOG_PREFIX = '[sveltekit-cloudflare-worker]';

/**
 * Compose adapter-cloudflare's `_worker.js` and the bundled `src/worker.ts` into one Worker
 * entry. Every unexpected output shape is a build error: a silently skipped composition would
 * deploy a Worker without the Durable Object classes and handlers.
 *
 * @param {{ root: string, workerFile: string, configPath?: string, cloudflareEnv?: string, aliases?: readonly import('./worker-composition.js').Alias[], log: (...args: unknown[]) => void }} input
 */
export async function composeBuildOutput({
	root,
	workerFile,
	configPath,
	cloudflareEnv,
	aliases = [],
	log
}) {
	const workerPath = path.resolve(root, workerFile);
	assertWorkerFile(workerPath, workerFile);

	const { workerDest, assetsDirectory } = await findBuildOutput(root, configPath, cloudflareEnv);
	if (!existsSync(workerDest)) {
		throw new Error(
			`${LOG_PREFIX} adapter-cloudflare did not write the Worker entry at ${path.relative(root, workerDest)}. ` +
				'Check that the Wrangler "main" field points at the adapter output (for example ".svelte-kit/cloudflare/_worker.js").'
		);
	}

	const workerContent = readFileSync(workerDest, 'utf-8');
	if (workerContent.startsWith(BUILD_ENTRY_MARKER)) {
		throw new Error(
			`${LOG_PREFIX} ${path.relative(root, workerDest)} is already a composed entry. adapter-cloudflare should have regenerated it; refusing to compose twice.`
		);
	}
	assertDefaultFetchExport(workerContent, workerDest, root);

	const userWorker = await bundleWorker(workerPath, { aliases });
	const exports = userWorker.exports;

	const workerDestDir = path.dirname(workerDest);
	const userWorkerDest = path.join(workerDestDir, '_user-worker.js');
	const svelteKitWorkerDest = path.join(workerDestDir, '_sveltekit-worker.js');
	rmSync(userWorkerDest, { force: true });
	rmSync(svelteKitWorkerDest, { force: true });
	writeFileSync(userWorkerDest, userWorker.content);
	copyFileSync(workerDest, svelteKitWorkerDest);
	writeFileSync(workerDest, createWorkerFacade(exports));
	appendInternalAssetsIgnore(assetsDirectory, [svelteKitWorkerDest, userWorkerDest]);

	const summary =
		`Composed ${path.relative(root, workerDest)}: ` +
		`handlers=[${exports.handlers.join(', ')}] classes=[${exports.classes.join(', ')}]`;
	log(summary);
	return { workerDest, exports };
}

/**
 * The facade imports the adapter Worker's default export and calls its `fetch`. Validate that
 * contract on the actual output instead of matching a specific line of generated code.
 * @param {string} source
 * @param {string} file
 * @param {string} root
 */
function assertDefaultFetchExport(source, file, root) {
	/** @type {any} */
	let program;
	try {
		program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
	} catch (error) {
		throw new Error(
			`${LOG_PREFIX} Cannot parse ${path.relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}
	const hasDefault = program.body.some(
		(/** @type {any} */ node) =>
			node.type === 'ExportDefaultDeclaration' ||
			(node.type === 'ExportNamedDeclaration' &&
				node.specifiers?.some(
					(/** @type {any} */ specifier) =>
						(specifier.exported?.name ?? specifier.exported?.value) === 'default'
				))
	);
	if (!hasDefault || !/\bfetch\b/.test(source)) {
		throw new Error(
			`${LOG_PREFIX} ${path.relative(root, file)} has no default export with a fetch handler. ` +
				'This adapter-cloudflare output shape is not supported; please report the adapter version.'
		);
	}
}

/**
 * @param {string} root
 * @param {string | undefined} configPath
 * @param {string | undefined} cloudflareEnv
 */
async function findBuildOutput(root, configPath, cloudflareEnv) {
	const config = await readWranglerConfig(root, () => {}, configPath, cloudflareEnv);
	const configRoot =
		typeof config.configPath === 'string' ? path.dirname(path.resolve(config.configPath)) : root;
	const workerDest =
		typeof config.main === 'string'
			? path.resolve(configRoot, config.main)
			: path.resolve(root, '.svelte-kit/cloudflare/_worker.js');
	const assets =
		config.assets && typeof config.assets === 'object' && !Array.isArray(config.assets)
			? /** @type {Record<string, unknown>} */ (config.assets)
			: {};
	const assetsDirectory =
		typeof assets.directory === 'string'
			? path.resolve(configRoot, assets.directory)
			: path.dirname(workerDest);
	return { workerDest, assetsDirectory };
}

/** @param {string} assetsDirectory @param {string[]} files */
function appendInternalAssetsIgnore(assetsDirectory, files) {
	const assetsIgnorePath = path.join(assetsDirectory, '.assetsignore');
	const content = existsSync(assetsIgnorePath) ? readFileSync(assetsIgnorePath, 'utf-8') : '';
	const entries = files.flatMap((file) => {
		const relative = path.relative(assetsDirectory, file);
		if (relative.startsWith('..') || path.isAbsolute(relative)) return [];
		return [relative.replace(/\\/g, '/')];
	});
	const lines = content.split(/\r?\n/);
	const missing = entries.filter((file) => !lines.includes(file));
	if (missing.length === 0) return;
	writeFileSync(assetsIgnorePath, `${content.trimEnd()}\n${missing.join('\n')}\n`.trimStart());
}

/** @param {string} workerPath @param {string} workerFile */
function assertWorkerFile(workerPath, workerFile) {
	if (existsSync(workerPath)) return;
	throw new Error(`${LOG_PREFIX} could not find the Worker entry at ${workerFile}.`);
}

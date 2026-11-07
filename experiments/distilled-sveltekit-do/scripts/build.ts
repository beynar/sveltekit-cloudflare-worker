import * as SvelteKit from '@distilled.cloud/sveltekit';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { build } from 'esbuild';
import * as Effect from 'effect/Effect';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIRECTORY = path.join(ROOT, '.distilled-build');
const COMPATIBILITY_DATE = '2026-07-11';

const framework = await SvelteKit.make({
	root: ROOT,
	compatibilityDate: COMPATIBILITY_DATE,
	compatibilityFlags: ['nodejs_compat']
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

const output = await framework.build({ root: ROOT }).pipe(Effect.runPromise);
const modules = output.serverModules;
if (!modules?.length) {
	throw new Error('Distilled SvelteKit produced no Worker modules');
}

await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
for (const module of modules) {
	const destination = path.join(OUTPUT_DIRECTORY, module.name);
	await mkdir(path.dirname(destination), { recursive: true });
	await writeFile(destination, module.content);
}

const workerModule = await bundleWorker();
await writeFile(path.join(OUTPUT_DIRECTORY, 'worker.js'), workerModule);
await writeFile(path.join(OUTPUT_DIRECTORY, 'index.js'), makeFacade(modules[0].name));

console.log(`Built ${modules.length + 2} modules in ${path.relative(ROOT, OUTPUT_DIRECTORY)}`);
console.log('Deployment entry exports: default, Counter');

async function bundleWorker(): Promise<string> {
	const result = await build({
		entryPoints: [path.join(ROOT, 'src', 'worker.ts')],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		conditions: ['workerd', 'worker', 'browser'],
		external: ['cloudflare:*']
	});
	const worker = result.outputFiles[0];
	if (!worker) {
		throw new Error('esbuild produced no Worker module');
	}
	return worker.text;
}

function makeFacade(svelteKitEntry: string): string {
	return `import sveltekit from ${JSON.stringify(`./${svelteKitEntry}`)};
import * as worker from './worker.js';
export { Counter } from './worker.js';

export default {
  async fetch(request, env, ctx) {
    let nextResponse;
    const next = () => {
      nextResponse ??= sveltekit.fetch(request, env, ctx);
      return nextResponse;
    };
    const response = await worker.fetch(request, env, ctx, next);
    return response ?? await (nextResponse ?? next());
  }
};
`;
}

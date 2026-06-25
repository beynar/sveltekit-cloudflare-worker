import { describe, expect, it } from 'vitest';
import { collectInlineStylesForNode } from './sveltekit-dev-inline-styles.js';

describe('collectInlineStylesForNode', () => {
	it('walks the Vite SSR module graph like SvelteKit dev inline styles', async () => {
		const graph = new Map<string, FakeModuleNode>();
		graph.set(
			'/src/routes/+page.svelte',
			createModule('/src/routes/+page.svelte', {
				deps: ['/src/routes/page.css', '/src/lib/child.ts'],
				dynamicDeps: ['/src/lib/lazy.css']
			})
		);
		graph.set(
			'/src/lib/child.ts',
			createModule('/src/lib/child.ts', {
				deps: ['/src/lib/child.css?used', '/src/lib/asset.css?url']
			})
		);
		graph.set('/src/routes/page.css', createModule('/src/routes/page.css'));
		graph.set('/src/lib/lazy.css', createModule('/src/lib/lazy.css'));
		graph.set('/src/lib/child.css?used', createModule('/src/lib/child.css?used'));
		graph.set('/src/lib/asset.css?url', createModule('/src/lib/asset.css?url'));

		const loadedCss: string[] = [];
		const transformedServerModules: string[] = [];
		const vite = createFakeVite(
			graph,
			loadedCss,
			transformedServerModules
		) as unknown as import('vite').ViteDevServer;

		const styles = await collectInlineStylesForNode({
			vite,
			node: { component: 'src/routes/+page.svelte' }
		});

		expect(styles).toEqual({
			'/src/routes/page.css': 'css:/src/routes/page.css?inline',
			'/src/lib/child.css?used': 'css:/src/lib/child.css?inline&used',
			'/src/lib/lazy.css': 'css:/src/lib/lazy.css?inline'
		});
		expect(loadedCss).not.toContain('/src/lib/asset.css?inline&url');
		expect(transformedServerModules).toEqual([]);
	});
});

type FakeModuleNode = {
	url: string;
	ssrTransformResult?: {
		deps?: string[];
		dynamicDeps?: string[];
	};
	transformResult?: {
		deps?: string[];
		dynamicDeps?: string[];
	};
	importedModules: Set<FakeModuleNode>;
};

function createModule(
	url: string,
	ssrTransformResult?: FakeModuleNode['ssrTransformResult']
): FakeModuleNode {
	return {
		url,
		ssrTransformResult,
		importedModules: new Set()
	};
}

function createFakeVite(
	graph: Map<string, FakeModuleNode>,
	loadedCss: string[],
	transformedServerModules: string[]
) {
	return {
		environments: {
			ssr: {
				moduleGraph: {
					getModuleByUrl: async (url: string) => graph.get(url)
				},
				transformRequest: async (url: string) => {
					transformedServerModules.push(url);
					return { code: `export default ${JSON.stringify(`css:${url}`)};` };
				}
			},
			client: {
				transformRequest: async (url: string) => {
					loadedCss.push(url);
					return { code: `export default ${JSON.stringify(`css:${url}`)};` };
				}
			}
		}
	};
}

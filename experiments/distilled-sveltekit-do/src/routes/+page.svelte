<svelte:head>
	<title>Distilled SvelteKit Durable Object probe</title>
</svelte:head>

<main>
	<p>Distilled Cloudflare runtime · no Alchemy</p>
	<h1>Unified fetch middleware probe</h1>
	<p>
		One request calls the same Durable Object before SvelteKit, inside SvelteKit, and after SvelteKit.
	</p>
	<pre><code>curl -i -X POST $APP_URL/kit/counter/demo</code></pre>
</main>

<style>
	:global(body) {
		font-family: system-ui, sans-serif;
		margin: 0;
		background: #111;
		color: #eee;
	}

	main {
		max-width: 48rem;
		margin: 5rem auto;
		padding: 0 1.5rem;
	}

	pre {
		padding: 1rem;
		background: #222;
		overflow-x: auto;
	}
</style>

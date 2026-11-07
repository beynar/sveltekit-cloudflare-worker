<svelte:head>
	<title>Alchemy beta.70 local Durable Object test</title>
	<meta
		name="description"
		content="A SvelteKit test project for local Durable Objects through Alchemy dev."
	/>
</svelte:head>

<main>
	<p>Alchemy 2.0.0-beta.70 · SvelteKit</p>
	<h1>Local Durable Object probe</h1>
	<p>
		The counter API reaches a Durable Object hosted by a local Worker through
		<code>platform.env.COUNTER</code>.
	</p>
	<pre><code>curl -X POST http://localhost:1337/api/counter/demo</code></pre>
</main>

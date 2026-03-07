<script lang="ts">
	import { onMount } from 'svelte';
	import { highlight } from 'sugar-high';

	// --- Fetch demo ---
	let fetchResult = $state<{ message: string; timestamp: number; runtime: string } | null>(null);
	let fetchLoading = $state(false);

	async function callFetchHandler() {
		fetchLoading = true;
		fetchResult = null;
		const res = await fetch('/api/hello');
		fetchResult = await res.json();
		fetchLoading = false;
	}

	// --- Durable Object counter ---
	let doCount = $state<number | null>(null);
	let doLoading = $state(false);

	async function incrementDO() {
		doLoading = true;
		const res = await fetch('/api/do/increment');
		const data = await res.json();
		doCount = data.count;
		doLoading = false;
	}

	async function resetDO() {
		doLoading = true;
		const res = await fetch('/api/do/reset');
		const data = await res.json();
		doCount = data.count;
		doLoading = false;
	}

	onMount(async () => {
		const res = await fetch('/api/do/count');
		const data = await res.json();
		doCount = data.count;
	});

	// --- SvelteKit fallthrough ---
	let skResult = $state<string | null>(null);
	let skLoading = $state(false);

	async function callSvelteKit() {
		skLoading = true;
		skResult = null;
		const res = await fetch('/');
		skResult =
			res.status === 200
				? `${res.status} OK — ${(await res.text()).length} bytes`
				: `${res.status}`;
		skLoading = false;
	}

	// --- WebSocket chat ---
	type ChatMessage =
		| { type: 'message'; name: string; text: string }
		| { type: 'system'; text: string };

	let chatMessages = $state<ChatMessage[]>([]);
	let chatInput = $state('');
	let chatName = $state('user-' + Math.random().toString(36).slice(2, 6));
	let chatConnected = $state(false);
	let chatWs = $state<WebSocket | null>(null);
	let chatEl: HTMLDivElement | undefined = $state();

	function connectChat() {
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const ws = new WebSocket(
			`${protocol}//${location.host}/api/chat?room=demo&name=${encodeURIComponent(chatName)}`
		);

		ws.onopen = () => {
			chatConnected = true;
			chatMessages = [...chatMessages, { type: 'system', text: 'Connected' }];
		};

		ws.onmessage = (e) => {
			try {
				const msg = JSON.parse(e.data) as ChatMessage;
				chatMessages = [...chatMessages, msg];
				scrollChat();
			} catch {}
		};

		ws.onclose = () => {
			chatConnected = false;
			chatMessages = [...chatMessages, { type: 'system', text: 'Disconnected' }];
		};

		chatWs = ws;
	}

	function disconnectChat() {
		chatWs?.close();
		chatWs = null;
	}

	function sendChat() {
		if (!chatWs || !chatInput.trim()) return;
		chatWs.send(chatInput.trim());
		chatInput = '';
	}

	function scrollChat() {
		requestAnimationFrame(() => {
			if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
		});
	}

	function handleChatKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendChat();
		}
	}

	// --- Workflow demo ---
	type WorkflowMessage = {
		type: 'workflow-progress';
		step: number;
		totalSteps: number;
		label: string;
		status: 'running' | 'waiting' | 'completed' | 'error';
		workflowId: string;
	};

	let workflowRunning = $state(false);
	let workflowProgress = $state<WorkflowMessage | null>(null);
	let workflowWs = $state<WebSocket | null>(null);
	let workflowId = $state<string | null>(null);
	let approvalLoading = $state(false);

	function ensureWorkflowWs(): Promise<WebSocket> {
		if (workflowWs && workflowWs.readyState === WebSocket.OPEN) {
			return Promise.resolve(workflowWs);
		}
		return new Promise((resolve, reject) => {
			const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
			const ws = new WebSocket(`${protocol}//${location.host}/api/workflow/ws`);

			ws.onopen = () => {
				workflowWs = ws;
				resolve(ws);
			};
			ws.onerror = () => reject(new Error('WebSocket connection failed'));
			ws.onmessage = (e) => {
				try {
					const msg = JSON.parse(e.data) as WorkflowMessage;
					if (msg.type === 'workflow-progress') {
						workflowProgress = msg;
						if (msg.status === 'completed' || msg.status === 'error') {
							workflowRunning = false;
						}
					}
				} catch {}
			};
			ws.onclose = () => {
				workflowWs = null;
				workflowRunning = false;
			};
		});
	}

	async function startWorkflow() {
		await ensureWorkflowWs();
		workflowProgress = null;
		workflowRunning = true;
		const res = await fetch('/api/workflow/start', { method: 'POST' });
		const data = await res.json();
		workflowId = data.workflowId;
	}

	async function approveWorkflow(approved: boolean) {
		if (!workflowId) return;
		approvalLoading = true;
		await fetch('/api/workflow/approve', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ workflowId, approved })
		});
		approvalLoading = false;
	}

	// --- Code examples ---
	const honoCode = highlight(`import type { WorkerFetch } from 'sveltekit-cloudflare-worker';
import { Hono } from 'hono';

const api = new Hono<{ Bindings: Env }>()
  .basePath('/api')
  .get('/users', async (c) => {
    const users = await c.env.DB.prepare('SELECT * FROM users').all();
    return c.json(users.results);
  })
  .post('/users', async (c) => {
    const body = await c.req.json();
    await c.env.DB.prepare('INSERT INTO users (name) VALUES (?)').bind(body.name).run();
    return c.json({ ok: true }, 201);
  });

export const fetch: WorkerFetch<Env> = async (req, env, ctx, next) => {
  const res = await api.fetch(req, env, ctx);
  if (res.status === 404) return; // fall through to SvelteKit
  return res;
};`);

	const transformCode =
		highlight(`export const fetch: WorkerFetch = async (req, env, ctx, next) => {
  const url = new URL(req.url);

  if (url.pathname.startsWith('/api/')) {
    return new Response('handled by worker');
  }

  // Add security headers to all SvelteKit responses
  const res = await next();
  const headers = new Headers(res.headers);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(res.body, { status: res.status, headers });
};`);

	const doCode = highlight(`import type { WorkerFetch } from 'sveltekit-cloudflare-worker';
import { DurableObject } from 'cloudflare:workers';

export const fetch: WorkerFetch<Env> = async (req, env, ctx, next) => {
  const url = new URL(req.url);

  if (url.pathname === '/api/do/increment') {
    const stub = env.MY_DO.get(env.MY_DO.idFromName('demo'));
    return Response.json({ count: await stub.increment() });
  }

  if (url.pathname === '/api/chat') {
    const roomId = env.CHAT_ROOM.idFromName('demo');
    return env.CHAT_ROOM.get(roomId).fetch(req);
  }
};

export class MyDurableObject extends DurableObject {
  async increment() {
    const count = ((await this.ctx.storage.get('count')) ?? 0) + 1;
    await this.ctx.storage.put('count', count);
    return count;
  }
}

export class ChatRoom extends DurableObject {
  async fetch(request) {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    const { success } = await this.env.RATELIMIT_CHAT.limit({ key: name });
    if (!success) return ws.send(JSON.stringify({ type: 'system', text: 'Rate limited' }));
    this.ctx.getWebSockets().forEach(s => s.send(message));
  }
}`);
</script>

<div class="min-h-screen bg-zinc-950 text-zinc-100">
	<header class="border-b border-zinc-800">
		<div class="mx-auto max-w-3xl px-6 py-16">
			<p class="mb-3 font-mono text-sm text-orange-400">sveltekit-cloudflare-worker</p>
			<h1 class="mb-4 text-4xl font-bold tracking-tight text-white">
				Full Workers platform from SvelteKit
			</h1>
			<p class="max-w-xl text-lg text-zinc-400">
				Export Durable Objects, define scheduled handlers, and intercept requests before SvelteKit —
				all from a single <code class="rounded bg-zinc-800 px-1.5 py-0.5 text-sm text-zinc-300"
					>src/worker.ts</code
				> file.
			</p>
		</div>
	</header>

	<main class="mx-auto max-w-3xl space-y-10 px-6 py-12">
		<!-- How it works -->
		<section>
			<h2 class="mb-2 text-sm font-semibold tracking-wider text-zinc-500 uppercase">
				How it works
			</h2>
			<p class="leading-relaxed text-zinc-400">
				Your <code class="rounded bg-zinc-800 px-1.5 py-0.5 text-sm text-zinc-300">fetch</code>
				handler runs first. Return a
				<code class="rounded bg-zinc-800 px-1.5 py-0.5 text-sm text-zinc-300">Response</code>
				to handle it, or return nothing to let SvelteKit take over. Class exports like Durable Objects
				and Workflows are re-exported from the final worker automatically.
			</p>
		</section>

		<!-- Fetch interception -->
		<section class="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
			<div class="mb-4">
				<h3 class="text-lg font-semibold text-white">Fetch interception</h3>
				<p class="mt-1 text-sm text-zinc-500">
					<code class="text-zinc-400">GET /api/hello</code> — handled by the worker before SvelteKit sees
					it.
				</p>
			</div>
			<button
				onclick={callFetchHandler}
				disabled={fetchLoading}
				class="rounded bg-orange-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-500 disabled:opacity-50"
			>
				{fetchLoading ? 'Calling...' : 'Call /api/hello'}
			</button>
			{#if fetchResult}
				<pre
					class="mt-4 overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">{JSON.stringify(
						fetchResult,
						null,
						2
					)}</pre>
			{/if}
		</section>

		<!-- Durable Object counter -->
		<section class="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
			<div class="mb-4">
				<h3 class="text-lg font-semibold text-white">Durable Object — Counter</h3>
				<p class="mt-1 text-sm text-zinc-500">
					Persistent counter using <code class="text-zinc-400">DurableObject</code> with SQLite storage.
					State survives restarts.
				</p>
			</div>
			<div class="flex items-center gap-3">
				<button
					onclick={incrementDO}
					disabled={doLoading}
					class="rounded bg-orange-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-500 disabled:opacity-50"
				>
					Increment
				</button>
				<button
					onclick={resetDO}
					disabled={doLoading}
					class="rounded border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-50"
				>
					Reset
				</button>
				{#if doCount !== null}
					<span class="font-mono text-2xl text-white">{doCount}</span>
				{/if}
			</div>
		</section>

		<!-- WebSocket Chat -->
		<section class="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
			<div class="mb-4">
				<h3 class="text-lg font-semibold text-white">Durable Object — WebSocket Chat</h3>
				<p class="mt-1 text-sm text-zinc-500">
					Real-time chat backed by a <code class="text-zinc-400">ChatRoom</code> Durable Object with
					WebSocket hibernation. Rate limited by a native
					<code class="text-zinc-400">RateLimit</code> binding.
				</p>
			</div>

			{#if !chatConnected}
				<div class="flex items-center gap-3">
					<input
						type="text"
						bind:value={chatName}
						placeholder="Your name"
						class="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-orange-500 focus:outline-none"
					/>
					<button
						onclick={connectChat}
						class="rounded bg-orange-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-500"
					>
						Connect
					</button>
				</div>
			{:else}
				<!-- Chat messages -->
				<div
					bind:this={chatEl}
					class="mb-3 h-64 space-y-1 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-3"
				>
					{#each chatMessages as msg}
						{#if msg.type === 'system'}
							<div class="text-xs text-zinc-600 italic">{msg.text}</div>
						{:else}
							<div class="text-sm">
								<span class="font-semibold text-orange-400">{msg.name}</span>
								<span class="text-zinc-400">{msg.text}</span>
							</div>
						{/if}
					{/each}
				</div>

				<!-- Input -->
				<div class="flex gap-2">
					<input
						type="text"
						bind:value={chatInput}
						onkeydown={handleChatKey}
						placeholder="Type a message..."
						class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-orange-500 focus:outline-none"
					/>
					<button
						onclick={sendChat}
						class="rounded bg-orange-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-500"
					>
						Send
					</button>
					<button
						onclick={disconnectChat}
						class="rounded border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-700"
					>
						Leave
					</button>
				</div>
			{/if}
		</section>

		<!-- Workflow demo -->
		<section class="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
			<div class="mb-4">
				<h3 class="text-lg font-semibold text-white">Cloudflare Workflow</h3>
				<p class="mt-1 text-sm text-zinc-500">
					A <code class="text-zinc-400">WorkflowEntrypoint</code> with 3 steps, reporting progress to
					a <code class="text-zinc-400">DurableObject</code> via RPC, which broadcasts updates over
					WebSocket.
				</p>
			</div>

			<button
				onclick={startWorkflow}
				disabled={workflowRunning}
				class="rounded bg-orange-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-500 disabled:opacity-50"
			>
				{workflowRunning ? 'Running...' : 'Start Workflow'}
			</button>

			{#if workflowProgress}
				<div class="mt-4 space-y-3">
					<!-- Progress bar -->
					<div class="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
						<div
							class="h-full rounded-full transition-all duration-500 {workflowProgress.status ===
							'completed'
								? 'bg-green-500'
								: workflowProgress.status === 'error'
									? 'bg-red-500'
									: workflowProgress.status === 'waiting'
										? 'bg-yellow-500'
										: 'bg-orange-500'}"
							style="width: {(workflowProgress.step / workflowProgress.totalSteps) * 100}%"
						></div>
					</div>

					<!-- Step info -->
					<div class="flex items-center justify-between text-sm">
						<span class="text-zinc-400">
							Step {workflowProgress.step} / {workflowProgress.totalSteps}
						</span>
						<span
							class="font-medium {workflowProgress.status === 'completed'
								? 'text-green-400'
								: workflowProgress.status === 'error'
									? 'text-red-400'
									: workflowProgress.status === 'waiting'
										? 'text-yellow-400'
										: 'text-orange-400'}"
						>
							{workflowProgress.label}
						</span>
					</div>

					<!-- Approval buttons -->
					{#if workflowProgress.status === 'waiting'}
						<div
							class="rounded border border-yellow-800 bg-yellow-950 px-4 py-3 text-sm text-yellow-400"
						>
							<p class="mb-3">AI image tagging requires your approval to continue.</p>
							<div class="flex gap-2">
								<button
									onclick={() => approveWorkflow(true)}
									disabled={approvalLoading}
									class="rounded bg-green-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-green-500 disabled:opacity-50"
								>
									Approve
								</button>
								<button
									onclick={() => approveWorkflow(false)}
									disabled={approvalLoading}
									class="rounded bg-red-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-red-500 disabled:opacity-50"
								>
									Reject
								</button>
							</div>
						</div>
					{/if}

					<!-- Completion badge -->
					{#if workflowProgress.status === 'completed'}
						<div
							class="rounded border border-green-800 bg-green-950 px-3 py-2 text-sm text-green-400"
						>
							Workflow completed successfully.
						</div>
					{/if}

					<!-- Rejection badge -->
					{#if workflowProgress.status === 'error'}
						<div
							class="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-400"
						>
							{workflowProgress.label}
						</div>
					{/if}
				</div>
			{/if}
		</section>

		<!-- SvelteKit fallthrough -->
		<section class="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
			<div class="mb-4">
				<h3 class="text-lg font-semibold text-white">SvelteKit fallthrough</h3>
				<p class="mt-1 text-sm text-zinc-500">
					Requests that don't match the worker's fetch handler fall through to SvelteKit. This page
					itself is served by SvelteKit.
				</p>
			</div>
			<button
				onclick={callSvelteKit}
				disabled={skLoading}
				class="rounded bg-orange-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-500 disabled:opacity-50"
			>
				{skLoading ? 'Calling...' : 'Fetch / (this page)'}
			</button>
			{#if skResult}
				<pre
					class="mt-4 overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">{skResult}</pre>
			{/if}
		</section>

		<!-- Code examples -->
		<section>
			<h2 class="mb-4 text-sm font-semibold tracking-wider text-zinc-500 uppercase">
				Code examples
			</h2>

			<div class="space-y-6">
				<!-- Hono example -->
				<div class="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
					<h3 class="mb-1 text-base font-semibold text-white">Works with Hono</h3>
					<p class="mb-3 text-sm text-zinc-500">
						Mount a full Hono app for your API. Unmatched routes fall through to SvelteKit.
					</p>
					<pre
						class="sh overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-4 text-sm leading-relaxed"><code
							>{@html honoCode}</code
						></pre>
				</div>

				<!-- Response transformation example -->
				<div class="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
					<h3 class="mb-1 text-base font-semibold text-white">Transform SvelteKit responses</h3>
					<p class="mb-3 text-sm text-zinc-500">
						Call <code class="text-zinc-400">next()</code> to get SvelteKit's response, then modify it.
					</p>
					<pre
						class="sh overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-4 text-sm leading-relaxed"><code
							>{@html transformCode}</code
						></pre>
				</div>

				<!-- Durable Object + Chat example -->
				<div class="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
					<h3 class="mb-1 text-base font-semibold text-white">
						Durable Objects + WebSocket + Rate Limiting
					</h3>
					<p class="mb-3 text-sm text-zinc-500">The code powering this demo page.</p>
					<pre
						class="sh overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-4 text-sm leading-relaxed"><code
							>{@html doCode}</code
						></pre>
				</div>
			</div>
		</section>
	</main>

	<footer class="border-t border-zinc-800 py-8 text-center text-sm text-zinc-600">
		sveltekit-cloudflare-worker
	</footer>
</div>

<style>
	:global(.sh__line) {
		min-height: 1lh;
	}
	:global(:root) {
		--sh-class: #e5c07b;
		--sh-identifier: #e06c75;
		--sh-keyword: #c678dd;
		--sh-string: #98c379;
		--sh-property: #56b6c2;
		--sh-entity: #61afef;
		--sh-comment: #5c6370;
		--sh-jsxliterals: #56b6c2;
		--sh-sign: #abb2bf;
	}
</style>

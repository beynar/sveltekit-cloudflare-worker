import type { WorkerFetch, WorkerScheduled } from 'sveltekit-cloudflare-worker';
import { DurableObject } from 'cloudflare:workers';

interface Env {
	MY_DO: DurableObjectNamespace<MyDurableObject>;
	CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
	RATELIMIT_CHAT: RateLimit;
	ASSETS: Fetcher;
}

export const fetch: WorkerFetch<Env> = async (req, env, ctx, next) => {
	const url = new URL(req.url);

	// Durable Object demo — counter with RPC
	if (url.pathname === '/api/do/increment') {
		const id = env.MY_DO.idFromName('demo');
		const stub = env.MY_DO.get(id);
		const count = await stub.increment();
		return Response.json({ count });
	}

	if (url.pathname === '/api/do/count') {
		const id = env.MY_DO.idFromName('demo');
		const stub = env.MY_DO.get(id);
		const count = await stub.getCount();
		return Response.json({ count });
	}

	if (url.pathname === '/api/do/reset') {
		const id = env.MY_DO.idFromName('demo');
		const stub = env.MY_DO.get(id);
		await stub.reset();
		return Response.json({ count: 0 });
	}

	// WebSocket chat — upgrade to the ChatRoom DO
	if (url.pathname === '/api/chat') {
		const upgradeHeader = req.headers.get('Upgrade');
		if (upgradeHeader !== 'websocket') {
			return new Response('Expected WebSocket', { status: 426 });
		}

		const room = url.searchParams.get('room') ?? 'default';
		const roomId = env.CHAT_ROOM.idFromName(room);
		const stub = env.CHAT_ROOM.get(roomId);
		return stub.fetch(req);
	}

	// Simple fetch interception demo
	if (url.pathname === '/api/hello') {
		return Response.json({
			message: 'Hello from the worker fetch handler!',
			timestamp: Date.now(),
			runtime: 'workerd'
		});
	}

	// Return nothing → falls through to SvelteKit
};

export const scheduled: WorkerScheduled<Env> = async (controller, env, ctx) => {
	console.log('cron job triggered', controller.cron);
};

// --- Durable Objects ---

export class MyDurableObject extends DurableObject<Env> {
	async increment(): Promise<number> {
		const count = ((await this.ctx.storage.get<number>('count')) ?? 0) + 1;
		await this.ctx.storage.put('count', count);
		return count;
	}

	async getCount(): Promise<number> {
		return (await this.ctx.storage.get<number>('count')) ?? 0;
	}

	async reset(): Promise<void> {
		await this.ctx.storage.delete('count');
	}
}

export class ChatRoom extends DurableObject<Env> {
	sessions: Map<WebSocket, string> = new Map();

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const name = url.searchParams.get('name') ?? 'anonymous';

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		this.ctx.acceptWebSocket(server);
		this.sessions.set(server, name);

		this.broadcast({ type: 'system', text: `${name} joined` }, server);

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const name = this.sessions.get(ws);
		if (!name) return;

		const text = typeof message === 'string' ? message : new TextDecoder().decode(message);

		// Rate limit via native binding
		const { success } = await this.env.RATELIMIT_CHAT.limit({ key: name });
		if (!success) {
			ws.send(JSON.stringify({ type: 'system', text: 'Rate limited — slow down!' }));
			return;
		}

		this.broadcast({ type: 'message', name, text }, null);
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		const name = this.sessions.get(ws);
		if (name) {
			this.sessions.delete(ws);
			this.broadcast({ type: 'system', text: `${name} left` }, null);
		}
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.sessions.delete(ws);
	}

	private broadcast(data: object, exclude: WebSocket | null): void {
		const msg = JSON.stringify(data);
		for (const ws of this.ctx.getWebSockets()) {
			if (ws !== exclude) {
				try {
					ws.send(msg);
				} catch {
					// Dead socket, will be cleaned up by webSocketClose
				}
			}
		}
	}
}

import type { WorkerFetch, WorkerScheduled } from 'sveltekit-cloudflare-worker';
import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';

type WorkflowParams = {
	orchestratorId: string;
};

type WorkflowProgress = {
	step: number;
	totalSteps: number;
	label: string;
	status: 'running' | 'waiting' | 'completed' | 'error';
	workflowId: string;
};

interface Env {
	MY_DO: DurableObjectNamespace<MyDurableObject>;
	CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
	WORKFLOW_DO: DurableObjectNamespace<WorkflowOrchestrator>;
	PROGRESS_WORKFLOW: Workflow;
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

	// Workflow demo — start a workflow
	if (url.pathname === '/api/workflow/start' && req.method === 'POST') {
		const doId = env.WORKFLOW_DO.idFromName('demo');
		const stub = env.WORKFLOW_DO.get(doId);
		const workflowId = await stub.startWorkflow();
		return Response.json({ workflowId });
	}

	// Workflow demo — approve or reject a waiting workflow
	if (url.pathname === '/api/workflow/approve' && req.method === 'POST') {
		const { workflowId, approved } = (await req.json()) as {
			workflowId: string;
			approved: boolean;
		};
		const instance = await env.PROGRESS_WORKFLOW.get(workflowId);
		await instance.sendEvent({
			type: 'approval-for-ai-tagging',
			payload: { approved }
		});
		return Response.json({ ok: true });
	}

	// Workflow demo — WebSocket for progress updates
	if (url.pathname === '/api/workflow/ws') {
		const upgradeHeader = req.headers.get('Upgrade');
		if (upgradeHeader !== 'websocket') {
			return new Response('Expected WebSocket', { status: 426 });
		}
		const doId = env.WORKFLOW_DO.idFromName('demo');
		const stub = env.WORKFLOW_DO.get(doId);
		return stub.fetch(req);
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

export class WorkflowOrchestrator extends DurableObject<Env> {
	async startWorkflow(): Promise<string> {
		const id = crypto.randomUUID();
		const orchestratorId = this.ctx.id.toString();

		await this.env.PROGRESS_WORKFLOW.create({
			id,
			params: { orchestratorId } satisfies WorkflowParams
		});

		this.broadcast({
			step: 0,
			totalSteps: 3,
			label: 'Starting workflow...',
			status: 'running',
			workflowId: id
		});

		return id;
	}

	async reportProgress(progress: WorkflowProgress): Promise<void> {
		this.broadcast(progress);
	}

	async fetch() {
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	private broadcast(progress: WorkflowProgress): void {
		const msg = JSON.stringify({ type: 'workflow-progress', ...progress });
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(msg);
			} catch {
				// Dead socket
			}
		}
	}
}

export class ProgressWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: Readonly<WorkflowEvent<WorkflowParams>>, step: WorkflowStep): Promise<void> {
		const { orchestratorId } = event.payload;
		const doId = this.env.WORKFLOW_DO.idFromString(orchestratorId);
		const stub = this.env.WORKFLOW_DO.get(doId);
		const workflowId = event.instanceId;

		await step.do('validate-input', async () => {
			await stub.reportProgress({
				step: 1,
				totalSteps: 3,
				label: 'Validating input data...',
				status: 'running',
				workflowId
			});
			return { validated: true };
		});

		await step.sleep('wait-after-validation', '2 seconds');

		await step.do('process-records', async () => {
			await stub.reportProgress({
				step: 2,
				totalSteps: 3,
				label: 'Processing records...',
				status: 'running',
				workflowId
			});
			return { processed: true };
		});

		const res = await step.do('request-approval', async () => {
			await stub.reportProgress({
				step: 2,
				totalSteps: 3,
				label: 'Waiting for AI tagging approval...',
				status: 'waiting',
				workflowId
			});

			const approval = await step.waitForEvent<{ approved: boolean }>(
				'Wait for AI Image tagging approval',
				{
					type: 'approval-for-ai-tagging',
					timeout: '5 minute'
				}
			);

			if (!approval.payload.approved) {
				await step.do('rejected', async () => {
					await stub.reportProgress({
						step: 2,
						totalSteps: 3,
						label: 'Workflow rejected',
						status: 'error',
						workflowId
					});
					return { rejected: true, requested: false };
				});
				return;
			}
			return { requested: true, rejected: false };
		});

		if (res.requested) {
			await step.do('generate-report', async () => {
				await stub.reportProgress({
					step: 3,
					totalSteps: 3,
					label: 'Generating report...',
					status: 'running',
					workflowId
				});
				return { reportUrl: '/reports/demo.pdf' };
			});

			await step.sleep('finalization-delay', '1 second');

			await step.do('mark-complete', async () => {
				await stub.reportProgress({
					step: 3,
					totalSteps: 3,
					label: 'Workflow complete!',
					status: 'completed',
					workflowId
				});
				return { done: true };
			});
		} else {
			await step.do('mark-complete', async () => {
				await stub.reportProgress({
					step: 2,
					totalSteps: 3,
					label: 'Workflow rejected',
					status: 'error',
					workflowId
				});
				return { done: true };
			});
		}
	}
}

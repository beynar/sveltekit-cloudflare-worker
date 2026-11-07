import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const NAME = `probe-${Date.now()}-${crypto.randomUUID()}`;

let server;
try {
	server = await startServer();
	await assertSequence(server.url, NAME, { before: 1, sveltekit: 2, after: 3 });
	await assertWebSocket(server.url, NAME, { connected: 4, message: 5 });
	await assertSequence(server.url, NAME, { before: 6, sveltekit: 7, after: 8 });
	await server.stop();
	server = undefined;

	server = await startServer();
	await assertWebSocket(server.url, NAME, { connected: 9, message: 10 });
	await assertSequence(server.url, NAME, { before: 11, sveltekit: 12, after: 13 });

	console.log(`PASS ${NAME}: HTTP 1/2/3 -> WS 4/5 -> HTTP 6/7/8 -> restart -> WS 9/10 -> HTTP 11/12/13`);
	console.log('Node SvelteKit, Worker WebSockets, and the fetch middleware used one persisted Distilled DO.');
} finally {
	await server?.stop();
}

async function startServer() {
	const child = spawn(
		process.execPath,
		[VITE, 'dev', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
		{
			cwd: ROOT,
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
	const url = await waitForUrl(child);
	return { url, stop: () => stop(child) };
}

async function waitForUrl(child) {
	let output = '';
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`Timed out starting Vite:\n${output}`)),
			45_000
		);
		const inspect = (chunk) => {
			const text = chunk.toString();
			output += text;
			process.stderr.write(text);
			const plainOutput = output.replace(/\u001b\[[0-9;]*m/g, '');
			const url = /Local:\s+(http:\/\/127\.0\.0\.1:\d+\/?)/.exec(plainOutput)?.[1];
			if (url) {
				clearTimeout(timeout);
				resolve(url.replace(/\/$/, ''));
			}
		};
		child.stdout.on('data', inspect);
		child.stderr.on('data', inspect);
		child.once('exit', (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`Vite exited before publishing its URL (${code ?? signal}):\n${output}`));
		});
	});
}

async function stop(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once('exit', resolve));
	child.kill('SIGTERM');
	const force = setTimeout(() => child.kill('SIGKILL'), 30_000);
	await exited;
	clearTimeout(force);
}

async function assertSequence(url, name, expected) {
	const response = await fetch(`${url}/probe?name=${encodeURIComponent(name)}`, { method: 'POST' });
	if (!response.ok) throw new Error(`${response.status} from probe: ${await response.text()}`);

	assertHeader(response, 'x-counter-before', expected.before);
	assertHeader(response, 'x-counter-after', expected.after);
	assertHeader(response, 'x-user-hook', 'preserved');
	const body = await response.json();
	if (!isRecord(body) || body.count !== expected.sveltekit || body.stage !== 'sveltekit') {
		throw new Error(
			`Expected SvelteKit count ${expected.sveltekit}, received ${JSON.stringify(body)}`
		);
	}
}

async function assertWebSocket(url, name, expected) {
	const socketUrl = new URL(`/socket?name=${encodeURIComponent(name)}`, url);
	socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
	const socket = new WebSocket(socketUrl);
	const messages = messageQueue(socket);

	try {
		await waitForEvent(socket, 'open');
		assertSocketMessage(await messages.next(), {
			count: expected.connected,
			stage: 'websocket-connect'
		});

		socket.send('increment');
		assertSocketMessage(await messages.next(), {
			count: expected.message,
			message: 'increment',
			stage: 'websocket-message'
		});
	} finally {
		await closeWebSocket(socket);
	}
}

async function closeWebSocket(socket) {
	if (socket.readyState === WebSocket.CLOSED) return;
	let hadError = false;
	socket.addEventListener('error', () => (hadError = true), { once: true });
	const closed = waitForEvent(socket, 'close', false);
	socket.close();
	const event = await closed;
	if (!event.wasClean || hadError) {
		throw new Error(
			`WebSocket did not close cleanly (code=${event.code}, reason=${JSON.stringify(event.reason)})`
		);
	}
}

function messageQueue(socket) {
	const values = [];
	const waiters = [];
	socket.addEventListener('message', (event) => {
		const waiter = waiters.shift();
		if (waiter) waiter(event.data);
		else values.push(event.data);
	});
	return {
		next() {
			if (values.length > 0) return Promise.resolve(values.shift());
			return new Promise((resolve) => waiters.push(resolve));
		}
	};
}

function waitForEvent(target, type, rejectOnError = true) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for WebSocket ${type}`)), 15_000);
		target.addEventListener(
			type,
			(event) => {
				clearTimeout(timeout);
				resolve(event);
			},
			{ once: true }
		);
		if (rejectOnError) {
			target.addEventListener(
				'error',
				() => {
					clearTimeout(timeout);
					reject(new Error(`WebSocket failed before ${type}`));
				},
				{ once: true }
			);
		}
	});
}

function assertSocketMessage(raw, expected) {
	const message = JSON.parse(String(raw));
	for (const [name, value] of Object.entries(expected)) {
		if (message[name] !== value) {
			throw new Error(`Expected WebSocket ${name}=${JSON.stringify(value)}, received ${JSON.stringify(message)}`);
		}
	}
}

function assertHeader(response, name, expected) {
	const received = response.headers.get(name);
	if (received !== String(expected)) {
		throw new Error(`Expected ${name}: ${expected}, received ${received}`);
	}
}

function isRecord(value) {
	return value !== null && typeof value === 'object';
}

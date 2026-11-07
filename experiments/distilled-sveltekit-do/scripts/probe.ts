import { spawn, type ChildProcessByStdio } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = `probe-${Date.now()}-${crypto.randomUUID()}`;

let server: RunningServer | undefined;
try {
	server = await startServer();
	await assertMiddlewareSequence(server.appUrl, NAME, { before: 1, sveltekit: 2, after: 3 });
	await server.stop();
	server = undefined;

	server = await startServer();
	await assertMiddlewareSequence(server.appUrl, NAME, { before: 4, sveltekit: 5, after: 6 });
	assertCount(await get(`${server.appUrl}/kit/counter/${NAME}`), 6);

	console.log(`PASS ${NAME}: before 1 -> SvelteKit 2 -> after 3 -> restart -> 4/5/6`);
	console.log('One HTTP request crossed the fetch middleware around SvelteKit using one persisted DO.');
} finally {
	await server?.stop();
}

interface RunningServer {
	appUrl: string;
	stop(): Promise<void>;
}

interface ExpectedSequence {
	before: number;
	sveltekit: number;
	after: number;
}

type DevProcess = ChildProcessByStdio<null, Readable, Readable>;

async function startServer(): Promise<RunningServer> {
	const child = spawn(process.execPath, ['scripts/dev.ts'], {
		cwd: ROOT,
		env: process.env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const appUrl = await waitForUrl(child);
	return { appUrl, stop: () => stop(child) };
}

async function waitForUrl(child: DevProcess): Promise<string> {
	let output = '';
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out starting dev:\n${output}`)), 30_000);
		const inspect = (chunk: Buffer) => {
			const text = chunk.toString();
			output += text;
			process.stderr.write(text);
			const appUrl = /APP_URL=(https?:\/\/\S+)/.exec(output)?.[1];
			if (appUrl) {
				clearTimeout(timeout);
				resolve(appUrl);
			}
		};
		child.stdout.on('data', inspect);
		child.stderr.on('data', inspect);
		child.once('exit', (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`Dev exited before publishing its URL (${code ?? signal}):\n${output}`));
		});
	});
}

async function stop(child: DevProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
	child.kill('SIGTERM');
	await exited;
}

async function assertMiddlewareSequence(
	appUrl: string,
	name: string,
	expected: ExpectedSequence
): Promise<void> {
	const response = await fetch(`${appUrl}/kit/counter/${name}`, { method: 'POST' });
	if (!response.ok) {
		throw new Error(`${response.status} from middleware request: ${await response.text()}`);
	}
	assertHeader(response, 'x-counter-before', expected.before);
	assertHeader(response, 'x-counter-after', expected.after);
	assertCount(await response.json(), expected.sveltekit, 'sveltekit');
}

async function get(url: string): Promise<unknown> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${response.status} from ${url}: ${await response.text()}`);
	return response.json();
}

function assertHeader(response: Response, name: string, value: number): void {
	const received = response.headers.get(name);
	if (received !== String(value)) {
		throw new Error(`Expected ${name}: ${value}, received ${received}`);
	}
}

function assertCount(value: unknown, count: number, stage?: string): void {
	if (!isRecord(value) || value.count !== count || (stage !== undefined && value.stage !== stage)) {
		throw new Error(
			`Expected ${JSON.stringify({ count, ...(stage ? { stage } : {}) })}, received ${JSON.stringify(value)}`
		);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}

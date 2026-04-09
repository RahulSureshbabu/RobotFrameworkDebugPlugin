import * as cp from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	Handles,
	InitializedEvent,
	LoggingDebugSession,
	OutputEvent,
	Scope,
	Source,
	StackFrame,
	StoppedEvent,
	TerminatedEvent,
	Thread,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

const THREAD_ID = 1;

type RuntimeCommand = {
	command: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'setBreakpoints';
	breakpoints?: Record<string, number[]>;
};

type RuntimeStackFrame = {
	id: number;
	name: string;
	source: string;
	line: number;
	column?: number;
};

type RuntimeVariable = {
	name: string;
	value: string;
	type?: string;
	variablesReference?: number;
};

type RuntimeMessage =
	| {
		event: 'output';
		category?: 'stdout' | 'stderr' | 'console';
		output: string;
	}
	| {
		event: 'stopped';
		reason: 'breakpoint' | 'step' | 'entry';
		description?: string;
		stack?: RuntimeStackFrame[];
		variables?: RuntimeVariable[];
	}
	| {
		event: 'terminated';
		exitCode?: number;
	};

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
};

export function createDeferredPromise<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolver) => {
		resolve = resolver;
	});
	return { promise, resolve };
}

export interface RobotLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	target: string;
	testName?: string;
	pythonPath: string;
	cwd?: string;
}

export function buildRuntimePythonArgs(
	runnerPath: string,
	runtimePort: number,
	target: string,
	testName?: string,
	debugpyPort?: number,
): string[] {
	const commandArguments = [
		'-Xfrozen_modules=off',
		runnerPath,
		'--event-port',
		String(runtimePort),
	];

	if (debugpyPort !== undefined) {
		commandArguments.push('--debugpy-port', String(debugpyPort));
	}

	commandArguments.push('--target', target);

	if (testName) {
		commandArguments.push('--test', testName);
	}

	return commandArguments;
}

export class RobotDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	public resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		configuration: vscode.DebugConfiguration,
	): vscode.ProviderResult<vscode.DebugConfiguration> {
		if (configuration.type !== 'rfw-robot') {
			return configuration;
		}

		const activeDocument = vscode.window.activeTextEditor?.document;
		if (!configuration.target && activeDocument?.uri.fsPath.toLowerCase().endsWith('.robot')) {
			configuration.target = activeDocument.uri.fsPath;
		}

		if (!configuration.cwd && configuration.target) {
			configuration.cwd = folder?.uri.fsPath ?? path.dirname(configuration.target as string);
		}

		if (!configuration.pythonPath) {
			configuration.pythonPath = vscode.workspace
				.getConfiguration('rfw-plugin')
				.get<string>('pythonPath', 'python');
		}

		if (!configuration.target) {
			void vscode.window.showErrorMessage('Open a .robot file before starting Robot debugging.');
			return undefined;
		}

		return configuration;
	}
}

export class RobotDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	constructor(private readonly extensionContext: vscode.ExtensionContext) {}

	public createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		const implementation = new RobotDebugSession(session, this.extensionContext.extensionPath);
		return new vscode.DebugAdapterInlineImplementation(implementation);
	}
}

class RobotDebugSession extends LoggingDebugSession {
	private readonly variableHandles = new Handles<RuntimeVariable[]>();
	private readonly configurationDone = createDeferredPromise<void>();
	private readonly breakpoints = new Map<string, number[]>();
	private currentStack: RuntimeStackFrame[] = [];
	private currentVariables: RuntimeVariable[] = [];
	private runtimeServer?: net.Server;
	private runtimeSocket?: net.Socket;
	private runtimeProcess?: cp.ChildProcess;
	private nextBreakpointId = 1;

	constructor(
		private readonly ownerSession: vscode.DebugSession,
		private readonly extensionPath: string,
	) {
		super('robot-debug.txt');
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	protected override initializeRequest(
		response: DebugProtocol.InitializeResponse,
	): void {
		response.body = {
			supportsConfigurationDoneRequest: true,
			supportsTerminateRequest: true,
		};
		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	protected override configurationDoneRequest(
		response: DebugProtocol.ConfigurationDoneResponse,
	): void {
		this.configurationDone.resolve();
		this.sendResponse(response);
	}

	protected override launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: RobotLaunchRequestArguments,
	): void {
		void this.handleLaunchRequest(response, args);
	}

	private async handleLaunchRequest(
		response: DebugProtocol.LaunchResponse,
		args: RobotLaunchRequestArguments,
	): Promise<void> {
		try {
			await this.configurationDone.promise;
			const runtimePort = await this.startRuntimeServer();
			const debugpyPort = await getAvailablePort();
			this.spawnRuntimeProcess(args, runtimePort, debugpyPort);
			this.sendResponse(response);
			void this.attachPythonDebugger(args, debugpyPort);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sendEvent(new OutputEvent(`${message}\n`, 'stderr'));
			response.success = false;
			response.message = message;
			this.sendResponse(response);
		}
	}

	protected override disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
	): void {
		void this.shutdownRuntime();
		this.sendResponse(response);
	}

	protected override terminateRequest(
		response: DebugProtocol.TerminateResponse,
	): void {
		void this.shutdownRuntime();
		this.sendResponse(response);
	}

	protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [new Thread(THREAD_ID, 'Robot Main Thread')],
		};
		this.sendResponse(response);
	}

	protected override setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments,
	): void {
		const sourcePath = normalizePath(args.source.path);
		const requestedLines: number[] = args.lines
			?? args.breakpoints?.map((item: DebugProtocol.SourceBreakpoint) => item.line)
			?? [];
		const uniqueLines = Array.from(new Set<number>(requestedLines)).sort((left, right) => left - right);

		if (sourcePath) {
			this.breakpoints.set(sourcePath, uniqueLines);
		}

		response.body = {
			breakpoints: uniqueLines.map((line) => ({
				verified: true,
				line,
				id: this.nextBreakpointId++,
			})),
		};
		this.sendResponse(response);
		this.pushBreakpointsToRuntime();
	}

	protected override stackTraceRequest(
		response: DebugProtocol.StackTraceResponse,
	): void {
		const frames = this.currentStack.length > 0
			? this.currentStack
			: [{ id: 1, name: 'Robot Test', source: '', line: 1 }];

		response.body = {
			stackFrames: frames.map((frame) => new StackFrame(
				frame.id,
				frame.name,
				frame.source ? new Source(path.basename(frame.source), frame.source) : undefined,
				frame.line,
				frame.column ?? 1,
			)),
			totalFrames: frames.length,
		};
		this.sendResponse(response);
	}

	protected override scopesRequest(
		response: DebugProtocol.ScopesResponse,
	): void {
		response.body = {
			scopes: [
				new Scope('Locals', this.variableHandles.create(this.currentVariables), false),
			],
		};
		this.sendResponse(response);
	}

	protected override variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments,
	): void {
		const variables = this.variableHandles.get(args.variablesReference) ?? [];
		response.body = {
			variables: variables.map((variable: RuntimeVariable) => ({
				name: variable.name,
				value: variable.value,
				type: variable.type,
				variablesReference: variable.variablesReference ?? 0,
			})),
		};
		this.sendResponse(response);
	}

	protected override continueRequest(
		response: DebugProtocol.ContinueResponse,
	): void {
		this.sendRuntimeCommand({ command: 'continue' });
		response.body = { allThreadsContinued: true };
		this.sendResponse(response);
	}

	protected override nextRequest(response: DebugProtocol.NextResponse): void {
		this.sendRuntimeCommand({ command: 'next' });
		this.sendResponse(response);
	}

	protected override stepInRequest(response: DebugProtocol.StepInResponse): void {
		this.sendRuntimeCommand({ command: 'stepIn' });
		this.sendResponse(response);
	}

	protected override stepOutRequest(response: DebugProtocol.StepOutResponse): void {
		this.sendRuntimeCommand({ command: 'stepOut' });
		this.sendResponse(response);
	}

	private async startRuntimeServer(): Promise<number> {
		this.runtimeServer = net.createServer((socket) => {
			this.runtimeSocket = socket;
			socket.setEncoding('utf8');
			let buffer = '';
			socket.on('data', (chunk: string | Buffer) => {
				buffer += chunk.toString();
				let separatorIndex = buffer.indexOf('\n');
				while (separatorIndex >= 0) {
					const line = buffer.slice(0, separatorIndex).trim();
					buffer = buffer.slice(separatorIndex + 1);
					if (line) {
						this.handleRuntimeMessage(line);
					}
					separatorIndex = buffer.indexOf('\n');
				}
			});
			socket.on('close', () => {
				this.runtimeSocket = undefined;
			});
			this.pushBreakpointsToRuntime();
		});

		await new Promise<void>((resolve, reject) => {
			this.runtimeServer?.once('error', reject);
			this.runtimeServer?.listen(0, '127.0.0.1', () => resolve());
		});

		const address = this.runtimeServer.address();
		if (!address || typeof address === 'string') {
			throw new Error('Unable to allocate a Robot debug server port.');
		}

		return address.port;
	}

	private spawnRuntimeProcess(args: RobotLaunchRequestArguments, runtimePort: number, debugpyPort: number): void {
		const runnerPath = path.join(this.extensionPath, 'python', 'robot_debug_runner.py');
		const cwd = args.cwd ?? path.dirname(args.target);
		const commandArguments = buildRuntimePythonArgs(
			runnerPath,
			runtimePort,
			args.target,
			args.testName,
			debugpyPort,
		);

		this.runtimeProcess = cp.spawn(args.pythonPath, commandArguments, {
			cwd,
			env: {
				...process.env,
				PYDEVD_DISABLE_FILE_VALIDATION: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		this.runtimeProcess.stdout?.on('data', (data: Buffer) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stdout'));
		});

		this.runtimeProcess.stderr?.on('data', (data: Buffer) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stderr'));
		});

		this.runtimeProcess.on('exit', (code) => {
			this.sendEvent(new OutputEvent(`Robot debug process exited with code ${code ?? 0}.\n`, 'console'));
			this.sendEvent(new TerminatedEvent());
		});
	}

	private async attachPythonDebugger(args: RobotLaunchRequestArguments, debugpyPort: number): Promise<void> {
		try {
			await this.waitForDebugpyStartup(debugpyPort);
			await this.startPythonChildSession(args, debugpyPort);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sendEvent(new OutputEvent(`${message}\n`, 'stderr'));
			this.sendEvent(new OutputEvent('Robot-file breakpoints can still work even if Python attach was not established.\n', 'console'));
		}
	}

	private async waitForDebugpyStartup(debugpyPort: number): Promise<void> {
		this.sendEvent(new OutputEvent(`Waiting for Python debugger on 127.0.0.1:${debugpyPort}\n`, 'console'));
		await waitForTcpPort('127.0.0.1', debugpyPort, 10000);
		if (this.runtimeProcess && this.runtimeProcess.exitCode !== null) {
			throw new Error(`Robot debug runtime exited before the Python debugger was ready (code ${this.runtimeProcess.exitCode}).`);
		}
	}

	private async startPythonChildSession(args: RobotLaunchRequestArguments, debugpyPort: number): Promise<void> {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(args.target));
		this.sendEvent(new OutputEvent(`Requesting Python attach on 127.0.0.1:${debugpyPort}\n`, 'console'));
		const attached = await vscode.debug.startDebugging(workspaceFolder, {
			name: `Python keywords: ${path.basename(args.target)}`,
			type: 'debugpy',
			request: 'attach',
			connect: {
				host: '127.0.0.1',
				port: debugpyPort,
			},
			justMyCode: false,
			subProcess: true,
		});

		if (!attached) {
			throw new Error(`Unable to attach to the Python debugger at 127.0.0.1:${debugpyPort}.`);
		}

		this.sendEvent(new OutputEvent('Python debugger attached.\n', 'console'));
	}

	private handleRuntimeMessage(line: string): void {
		const message = JSON.parse(line) as RuntimeMessage;
		switch (message.event) {
			case 'output':
				this.sendEvent(new OutputEvent(message.output, message.category ?? 'console'));
				break;
			case 'stopped':
				this.currentStack = message.stack ?? [];
				this.currentVariables = message.variables ?? [];
				this.sendEvent(new StoppedEvent(message.reason, THREAD_ID, message.description));
				break;
			case 'terminated':
				this.sendEvent(new TerminatedEvent());
				break;
			default:
				break;
		}
	}

	private pushBreakpointsToRuntime(): void {
		this.sendRuntimeCommand({
			command: 'setBreakpoints',
			breakpoints: Object.fromEntries(this.breakpoints.entries()),
		});
	}

	private sendRuntimeCommand(command: RuntimeCommand): void {
		if (!this.runtimeSocket || this.runtimeSocket.destroyed) {
			return;
		}

		this.runtimeSocket.write(`${JSON.stringify(command)}\n`);
	}

	private async shutdownRuntime(): Promise<void> {
		this.runtimeSocket?.destroy();
		this.runtimeServer?.close();
		if (this.runtimeProcess && !this.runtimeProcess.killed) {
			this.runtimeProcess.kill();
		}
	}
}

function normalizePath(sourcePath: string | undefined): string {
	return sourcePath ? path.normalize(sourcePath).toLowerCase() : '';
}

async function getAvailablePort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});

	const address = server.address();
	server.close();
	if (!address || typeof address === 'string') {
		throw new Error('Unable to acquire an open TCP port.');
	}
	return address.port;
}

async function waitForTcpPort(host: string, port: number, timeoutMilliseconds: number): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMilliseconds) {
		const isOpen = await new Promise<boolean>((resolve) => {
			const socket = net.createConnection({ host, port });
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => {
				socket.destroy();
				resolve(false);
			});
		});

		if (isOpen) {
			return;
		}

		await delay(200);
	}

	throw new Error(`Timed out waiting for the Python debugger on ${host}:${port}.`);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	RobotDebugAdapterFactory,
	RobotDebugConfigurationProvider,
} from './debug/robotDebugSession';
import { RobotCodeLensProvider } from './robotCodeLensProvider';

const CONFIG_SECTION = 'rfw-plugin';
const PYTHON_PATH_KEY = 'pythonPath';
const STOP_COMMAND = 'rfw-plugin.stopRobotExecution';

let activeRobotTerminal: vscode.Terminal | undefined;
let activeDebugSession: vscode.DebugSession | undefined;
let stopStatusBarItem: vscode.StatusBarItem | undefined;

type UriLike = vscode.Uri | {
	fsPath?: string;
	scheme?: string;
	authority?: string;
	path?: string;
	query?: string;
	fragment?: string;
};

export function activate(context: vscode.ExtensionContext) {
	console.log('Robot Framework support for rfw-plugin is now active.');

	const robotSelector: vscode.DocumentSelector = [
		{ scheme: 'file', pattern: '**/*.robot' },
		{ language: 'robotframework' },
	];

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(robotSelector, new RobotCodeLensProvider()),
		vscode.debug.registerDebugConfigurationProvider('rfw-robot', new RobotDebugConfigurationProvider()),
		vscode.debug.registerDebugAdapterDescriptorFactory('rfw-robot', new RobotDebugAdapterFactory(context)),
		vscode.commands.registerCommand('rfw-plugin.setPythonPath', setPythonPath),
		vscode.commands.registerCommand('rfw-plugin.runRobotTest', runRobotTest),
		vscode.commands.registerCommand('rfw-plugin.debugRobotTest', debugRobotTest),
		vscode.commands.registerCommand('rfw-plugin.runRobotSuite', runRobotSuite),
		vscode.commands.registerCommand('rfw-plugin.debugRobotSuite', debugRobotSuite),
		vscode.commands.registerCommand(STOP_COMMAND, stopRobotExecution),
		vscode.window.onDidCloseTerminal(handleClosedTerminal),
		vscode.debug.onDidStartDebugSession(handleDebugSessionStarted),
		vscode.debug.onDidTerminateDebugSession(handleDebugSessionTerminated),
	);
}

async function setPythonPath(): Promise<void> {
	const pythonPath = await promptForPythonPath(getStoredPythonPath() ?? getSuggestedPythonPath());
	if (!pythonPath) {
		return;
	}

	await savePythonPath(pythonPath);
	void vscode.window.showInformationMessage(`Robot Framework Python path saved: ${pythonPath}`);
}

type ResolvedRobotTarget = {
	fileUri: vscode.Uri;
	testName?: string;
	displayName: string;
};

async function runRobotTest(fileUri?: UriLike, testName?: string): Promise<void> {
	const target = await resolveRobotTarget(fileUri, testName, true);
	if (!target) {
		return;
	}

	await runResolvedRobotTarget(target);
}

async function runRobotSuite(fileUri?: UriLike): Promise<void> {
	const target = await resolveRobotTarget(fileUri);
	if (!target) {
		return;
	}

	await runResolvedRobotTarget(target);
}

async function runResolvedRobotTarget(target: ResolvedRobotTarget): Promise<void> {
	const pythonPath = await ensurePythonPath();
	if (!pythonPath) {
		void vscode.window.showWarningMessage('Set a Python path before running Robot Framework tests.');
		return;
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(target.fileUri);
	const cwd = workspaceFolder?.uri.fsPath ?? path.dirname(target.fileUri.fsPath);
	const terminalOptions: vscode.TerminalOptions = {
		name: `Robot: ${target.displayName}`,
		cwd,
	};

	if (process.platform === 'win32') {
		terminalOptions.shellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
	}

	const terminal = vscode.window.createTerminal(terminalOptions);
	activeDebugSession = undefined;
	activeRobotTerminal = terminal;
	showStopButton();
	terminal.show(true);
	terminal.sendText(buildShellCommand(pythonPath, buildRobotArguments(target.fileUri.fsPath, target.testName)), true);
}

async function debugRobotTest(fileUri?: UriLike, testName?: string): Promise<void> {
	const target = await resolveRobotTarget(fileUri, testName, true);
	if (!target) {
		return;
	}

	await debugResolvedRobotTarget(target);
}

async function debugRobotSuite(fileUri?: UriLike): Promise<void> {
	const target = await resolveRobotTarget(fileUri);
	if (!target) {
		return;
	}

	await debugResolvedRobotTarget(target);
}

async function debugResolvedRobotTarget(target: ResolvedRobotTarget): Promise<void> {
	const pythonPath = await ensurePythonPath();
	if (!pythonPath) {
		void vscode.window.showWarningMessage('Set a Python path before debugging Robot Framework tests.');
		return;
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(target.fileUri);
	const started = await vscode.debug.startDebugging(
		workspaceFolder,
		buildRobotDebugConfiguration(target.fileUri, target.testName, pythonPath),
	);

	if (started) {
		activeRobotTerminal = undefined;
		showStopButton();
	}

	if (!started) {
		void vscode.window.showErrorMessage(
			'Unable to start Robot Framework debugging. Make sure the Python extension is installed and the selected Python environment contains `robotframework`.',
		);
	}
}

async function stopRobotExecution(): Promise<void> {
	if (activeDebugSession) {
		await vscode.debug.stopDebugging(activeDebugSession);
		return;
	}

	if (activeRobotTerminal) {
		activeRobotTerminal.dispose();
		return;
	}

	void vscode.window.showInformationMessage('No active Robot Framework execution to stop.');
}

function showStopButton(): void {
	if (!stopStatusBarItem) {
		stopStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		stopStatusBarItem.command = STOP_COMMAND;
		stopStatusBarItem.text = '$(debug-stop) Stop Robot Test';
		stopStatusBarItem.tooltip = 'Stop the currently running Robot Framework test';
	}

	stopStatusBarItem.show();
}

function hideStopButton(): void {
	stopStatusBarItem?.hide();
}

function clearActiveRobotExecution(): void {
	activeRobotTerminal = undefined;
	activeDebugSession = undefined;
	hideStopButton();
}

function handleClosedTerminal(terminal: vscode.Terminal): void {
	if (activeRobotTerminal && terminal === activeRobotTerminal) {
		clearActiveRobotExecution();
	}
}

function handleDebugSessionStarted(session: vscode.DebugSession): void {
	if (session.type === 'rfw-robot') {
		activeDebugSession = session;
		showStopButton();
	}
}

function handleDebugSessionTerminated(session: vscode.DebugSession): void {
	if (activeDebugSession && session.id === activeDebugSession.id) {
		clearActiveRobotExecution();
	}
}

async function resolveRobotTarget(
	fileUri?: UriLike,
	testName?: string,
	promptForTestName = false,
): Promise<ResolvedRobotTarget | undefined> {
	const activeDocument = vscode.window.activeTextEditor?.document;
	const resolvedFileUri = reviveUri(fileUri) ?? activeDocument?.uri;

	if (!resolvedFileUri || !resolvedFileUri.fsPath.toLowerCase().endsWith('.robot')) {
		void vscode.window.showWarningMessage('Open a .robot file to run or debug a Robot Framework test suite.');
		return undefined;
	}

	const resolvedTestName = testName ?? (promptForTestName
		? await vscode.window.showInputBox({
			title: 'Robot Framework Test Name',
			prompt: 'Enter the test case name to run or debug',
			ignoreFocusOut: true,
		})
		: undefined);

	if (promptForTestName && !resolvedTestName) {
		return undefined;
	}

	return {
		fileUri: resolvedFileUri,
		testName: resolvedTestName,
		displayName: resolvedTestName ?? path.basename(resolvedFileUri.fsPath),
	};
}

async function ensurePythonPath(): Promise<string | undefined> {
	const configuredPath = getStoredPythonPath();
	if (configuredPath) {
		return configuredPath;
	}

	const pythonPath = await promptForPythonPath(getSuggestedPythonPath());
	if (!pythonPath) {
		return undefined;
	}

	await savePythonPath(pythonPath);
	return pythonPath;
}

function getStoredPythonPath(): string | undefined {
	return getConfiguredStringValue(CONFIG_SECTION, PYTHON_PATH_KEY);
}

function getConfiguredStringValue(section: string, setting: string): string | undefined {
	const inspectedValue = vscode.workspace.getConfiguration(section).inspect<string>(setting);
	const configuredPath = inspectedValue?.workspaceFolderValue
		?? inspectedValue?.workspaceValue
		?? inspectedValue?.globalValue;

	return typeof configuredPath === 'string' && configuredPath.trim().length > 0
		? configuredPath.trim()
		: undefined;
}

function getSuggestedPythonPath(): string {
	const pythonConfiguration = vscode.workspace.getConfiguration('python');
	const configuredInterpreter = pythonConfiguration.get<string>('defaultInterpreterPath')?.trim();
	return configuredInterpreter && configuredInterpreter.length > 0 ? configuredInterpreter : 'python';
}

async function promptForPythonPath(initialValue: string): Promise<string | undefined> {
	const selection = await vscode.window.showQuickPick([
		{ label: '$(edit) Enter path manually', action: 'manual' as const },
		{ label: '$(folder-opened) Browse for Python executable', action: 'browse' as const },
	], {
		title: 'Robot Framework Python Path',
		placeHolder: 'Choose how to provide the Python executable',
		ignoreFocusOut: true,
	});

	if (!selection) {
		return undefined;
	}

	if (selection.action === 'browse') {
		const pickedFiles = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: 'Select Python executable',
			filters: process.platform === 'win32' ? { 'Python Executable': ['exe'] } : undefined,
		});

		return pickedFiles?.[0]?.fsPath;
	}

	const enteredValue = await vscode.window.showInputBox({
		title: 'Robot Framework Python Path',
		prompt: 'Enter the Python executable path used to run Robot Framework tests',
		placeHolder: 'python or C:\\Python312\\python.exe',
		value: initialValue,
		ignoreFocusOut: true,
		validateInput: (value) => value.trim().length === 0 ? 'Python path is required.' : undefined,
	});

	return enteredValue?.trim() || undefined;
}

async function savePythonPath(pythonPath: string): Promise<void> {
	const configurationTarget = vscode.workspace.workspaceFolders?.length
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;

	await vscode.workspace.getConfiguration(CONFIG_SECTION).update(PYTHON_PATH_KEY, pythonPath, configurationTarget);
}

export function reviveUri(fileUri?: UriLike): vscode.Uri | undefined {
	if (!fileUri) {
		return undefined;
	}

	if (fileUri instanceof vscode.Uri) {
		return fileUri;
	}

	if (typeof fileUri.fsPath === 'string' && fileUri.fsPath.length > 0) {
		return vscode.Uri.file(fileUri.fsPath);
	}

	if (typeof fileUri.path === 'string' && typeof fileUri.scheme === 'string') {
		return vscode.Uri.from({
			scheme: fileUri.scheme,
			authority: fileUri.authority ?? '',
			path: fileUri.path,
			query: fileUri.query ?? '',
			fragment: fileUri.fragment ?? '',
		});
	}

	return undefined;
}

export function buildRobotDebugConfiguration(
	fileUri: vscode.Uri,
	testName: string | undefined,
	pythonPath: string,
): vscode.DebugConfiguration {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
	const configuration: vscode.DebugConfiguration = {
		name: testName
			? `Debug Robot Test: ${testName}`
			: `Debug Robot Suite: ${path.basename(fileUri.fsPath)}`,
		type: 'rfw-robot',
		request: 'launch',
		cwd: workspaceFolder?.uri.fsPath ?? path.dirname(fileUri.fsPath),
		target: fileUri.fsPath,
		pythonPath,
	};

	if (testName) {
		configuration.testName = testName;
	}

	return configuration;
}

export function buildRobotArguments(filePath: string, testName?: string): string[] {
	const args = ['-m', 'robot'];

	if (testName) {
		args.push('--test', testName);
	}

	args.push(filePath);
	return args;
}

export function buildShellCommand(pythonPath: string, args: string[]): string {
	const trimmedPythonPath = pythonPath.trim();

	if (process.platform === 'win32') {
		const executable = /\s/.test(trimmedPythonPath)
			? `& ${shellQuote(trimmedPythonPath)}`
			: trimmedPythonPath;
		return [executable, ...args.map(shellQuote)].join(' ');
	}

	return [shellQuote(trimmedPythonPath), ...args.map(shellQuote)].join(' ');
}

function shellQuote(value: string): string {
	if (process.platform === 'win32') {
		return `"${value.replace(/"/g, '""')}"`;
	}

	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function deactivate() {}

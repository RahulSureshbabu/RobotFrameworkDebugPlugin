import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import { RobotConfig } from './testController';

/**
 * Responsible for spawning `robot` processes and handling debug sessions.
 */
export class RobotRunner {
    constructor(_outputChannel: vscode.OutputChannel) {}

    /**
     * Run (or debug) a robot target (file or directory).
     *
     * When `debug` is true the extension launches VS Code's built-in debug
     * session using a `robotframework` launch configuration, which in turn
     * uses `debugpy` to attach to the running Python process.
     */
    public async runTarget(
        target: string,
        extraArgs: string[],
        config: RobotConfig,
        outputChannel: vscode.OutputChannel,
        debug: boolean
    ): Promise<void> {
        if (debug) {
            await this.startDebugSession(target, extraArgs, config);
        } else {
            await this.spawnRobot(target, extraArgs, config, outputChannel);
        }
    }

    // -----------------------------------------------------------------------
    // Running without debug
    // -----------------------------------------------------------------------

    public async spawnRobot(
        target: string,
        extraArgs: string[],
        config: RobotConfig,
        outputChannel: vscode.OutputChannel
    ): Promise<void> {
        const outputDir = resolveOutputDir(config.outputDir);
        ensureDir(outputDir);

        const args = [
            '--outputdir', outputDir,
            ...config.extraArgs,
            ...extraArgs,
            target,
        ];

        outputChannel.show(true);
        outputChannel.appendLine(`\n[Robot Framework] Running: ${config.robotCommand} ${args.join(' ')}\n`);

        return new Promise<void>((resolve, reject) => {
            const cwd = workspaceRoot();
            const proc = cp.spawn(config.robotCommand, args, {
                cwd,
                shell: process.platform === 'win32',
                env: { ...process.env },
            });

            proc.stdout.on('data', (data: Buffer) => {
                outputChannel.append(data.toString());
            });

            proc.stderr.on('data', (data: Buffer) => {
                outputChannel.append(data.toString());
            });

            proc.on('error', (err) => {
                outputChannel.appendLine(`[Robot Framework] Error: ${err.message}`);
                reject(err);
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    outputChannel.appendLine('[Robot Framework] Tests completed successfully.');
                    resolve();
                } else {
                    const msg = `[Robot Framework] Tests finished with exit code ${code}.`;
                    outputChannel.appendLine(msg);
                    reject(new Error(msg));
                }
            });
        });
    }

    // -----------------------------------------------------------------------
    // Debug session
    // -----------------------------------------------------------------------

    private async startDebugSession(
        target: string,
        extraArgs: string[],
        config: RobotConfig
    ): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        const debugConfig: vscode.DebugConfiguration = {
            type: 'robotframework',
            request: 'launch',
            name: 'Robot Framework: Debug',
            target,
            args: extraArgs,
            pythonPath: config.pythonPath,
            robotCommand: config.robotCommand,
            outputDir: config.outputDir,
            debugPort: config.debugPort,
            debugHost: config.debugHost,
            cwd: workspaceRoot(),
        };

        await vscode.debug.startDebugging(workspaceFolder, debugConfig);
    }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function resolveOutputDir(template: string): string {
    const root = workspaceRoot();
    return template.replace('${workspaceFolder}', root);
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Build the command-line arguments needed to launch robot in debug mode.
 * The listener is expected to be the Python script shipped with the extension.
 */
export function buildDebugArgs(
    listenerPath: string,
    host: string,
    port: number,
    outputDir: string,
    extraArgs: string[],
    target: string
): string[] {
    return [
        '--listener', `${listenerPath}:${host}:${port}`,
        '--outputdir', outputDir,
        ...extraArgs,
        target,
    ];
}

/**
 * Build arguments that wrap robot with `debugpy` so that VS Code's Python
 * debugger can attach and support full breakpoint / stepping in keyword
 * implementations (Python code).
 */
export function buildDebugpyArgs(
    _pythonPath: string,
    host: string,
    port: number,
    _robotCommand: string,
    outputDir: string,
    extraArgs: string[],
    target: string
): string[] {
    return [
        '-m', 'debugpy',
        '--listen', `${host}:${port}`,
        '--wait-for-client',
        '-m', 'robot',
        '--outputdir', outputDir,
        ...extraArgs,
        target,
    ];
}

export { resolveOutputDir, workspaceRoot };

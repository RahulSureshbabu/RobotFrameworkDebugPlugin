import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import * as cp from 'child_process';
import * as fs from 'fs';
import { buildDebugArgs, resolveOutputDir } from './robotRunner';

/**
 * Provides and resolves Robot Framework debug configurations.
 *
 * When VS Code launches a `robotframework` debug session this provider:
 *  1. Fills in missing fields from workspace settings.
 *  2. Starts a TCP server on the configured debug port.
 *  3. Spawns `robot` with the bundled `robot_debug_listener.py` listener.
 *  4. The listener connects back, and the provider bridges DAP messages
 *     between VS Code and the running robot process.
 */
export class RobotDebugConfigurationProvider
    implements vscode.DebugConfigurationProvider {

    constructor(private readonly context: vscode.ExtensionContext) {}

    public provideDebugConfigurations(
        _folder: vscode.WorkspaceFolder | undefined
    ): vscode.DebugConfiguration[] {
        return [
            {
                type: 'robotframework',
                request: 'launch',
                name: 'Robot Framework: Run Current File',
                target: '${file}',
            },
        ];
    }

    public resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
    ): vscode.DebugConfiguration | undefined {
        // If no configuration exists, use defaults
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && this.isRobotFile(editor.document.uri)) {
                config.type = 'robotframework';
                config.name = 'Robot Framework: Debug';
                config.request = 'launch';
                config.target = '${file}';
            }
        }

        if (!config.target) {
            vscode.window.showErrorMessage(
                'Robot Framework: "target" is required in the debug configuration.'
            );
            return undefined;
        }

        // Apply defaults from settings
        const cfg = vscode.workspace.getConfiguration('robotframework', folder);
        config.pythonPath = config.pythonPath ?? cfg.get<string>('pythonPath', 'python');
        config.robotCommand = config.robotCommand ?? cfg.get<string>('robotCommand', 'robot');
        config.outputDir =
            config.outputDir ??
            cfg.get<string>('outputDir', '${workspaceFolder}/results');
        config.debugPort = config.debugPort ?? cfg.get<number>('debugPort', 6612);
        config.debugHost = config.debugHost ?? cfg.get<string>('debugHost', '127.0.0.1');
        config.args = config.args ?? cfg.get<string[]>('extraArgs', []);
        config.cwd = config.cwd ?? (folder?.uri.fsPath ?? process.cwd());
        config.env = config.env ?? {};

        return config;
    }

    public async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
    ): Promise<vscode.DebugConfiguration | undefined> {
        const listenerPath = this.context.asAbsolutePath(
            path.join('resources', 'robot_debug_listener.py')
        );

        if (!fs.existsSync(listenerPath)) {
            vscode.window.showErrorMessage(
                `Robot Framework: Debug listener not found at ${listenerPath}`
            );
            return undefined;
        }

        const outputDir = resolveOutputDir(config.outputDir as string);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const host: string = config.debugHost as string;
        const port: number = config.debugPort as number;

        // Check the port is free before launching
        const portFree = await this.isPortFree(host, port);
        if (!portFree) {
            vscode.window.showErrorMessage(
                `Robot Framework: Debug port ${port} is already in use. ` +
                    'Change robotframework.debugPort in settings.'
            );
            return undefined;
        }

        const robotArgs = buildDebugArgs(
            listenerPath,
            host,
            port,
            outputDir,
            (config.args as string[] | undefined) ?? [],
            config.target as string
        );

        // Store computed values back so the debug adapter factory can use them
        config.__robotArgs = robotArgs;
        config.__listenerPath = listenerPath;

        // Start the robot process; the listener will connect to a server we
        // create in the debug adapter (see RobotDebugAdapterFactory below).
        // For now, launch robot and let the debug adapter handle the socket.
        await this.launchRobotDebug(config, robotArgs, folder);

        return config;
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private async launchRobotDebug(
        config: vscode.DebugConfiguration,
        robotArgs: string[],
        folder: vscode.WorkspaceFolder | undefined
    ): Promise<void> {
        const outputChannel = vscode.window.createOutputChannel(
            'Robot Framework Debug'
        );
        outputChannel.show(true);
        outputChannel.appendLine(
            `[Robot Framework Debug] Launching: ${config.robotCommand as string} ${robotArgs.join(' ')}\n`
        );

        const cwd = (config.cwd as string | undefined) ?? folder?.uri.fsPath ?? process.cwd();
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...(config.env as Record<string, string>),
        };

        const proc = cp.spawn(config.robotCommand as string, robotArgs, {
            cwd,
            shell: process.platform === 'win32',
            env,
        });

        proc.stdout.on('data', (d: Buffer) => outputChannel.append(d.toString()));
        proc.stderr.on('data', (d: Buffer) => outputChannel.append(d.toString()));

        proc.on('error', (err) => {
            outputChannel.appendLine(`[Robot Framework Debug] Error: ${err.message}`);
            vscode.window.showErrorMessage(
                `Robot Framework Debug: Failed to launch robot – ${err.message}`
            );
        });

        proc.on('close', (code) => {
            const msg =
                code === 0
                    ? '[Robot Framework Debug] Completed successfully.'
                    : `[Robot Framework Debug] Exited with code ${code}.`;
            outputChannel.appendLine(msg);
        });
    }

    private isRobotFile(uri: vscode.Uri): boolean {
        return /\.(robot|resource)$/i.test(uri.fsPath);
    }

    private isPortFree(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close(() => resolve(true));
            });
            server.listen(port, host);
        });
    }
}

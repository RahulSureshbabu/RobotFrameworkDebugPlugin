import * as vscode from 'vscode';
import { RobotTestController } from './testController';
import { RobotDebugConfigurationProvider } from './debugProvider';
import { RobotRunner } from './robotRunner';

let testController: RobotTestController | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('Robot Framework');
    context.subscriptions.push(outputChannel);

    const runner = new RobotRunner(outputChannel);
    testController = new RobotTestController(context, runner, outputChannel);

    const debugProvider = new RobotDebugConfigurationProvider(context);
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('robotframework', debugProvider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('robotframework.runAllTests', () => {
            vscode.commands.executeCommand('testing.runAll');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('robotframework.refreshTests', () => {
            testController?.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('robotframework.runTest', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) {
                vscode.window.showWarningMessage('No Robot Framework file is active.');
                return;
            }
            testController?.runFile(target, false);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('robotframework.debugTest', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) {
                vscode.window.showWarningMessage('No Robot Framework file is active.');
                return;
            }
            testController?.runFile(target, true);
        })
    );

    outputChannel.appendLine('Robot Framework Debug extension activated.');
}

export function deactivate(): void {
    testController?.dispose();
    testController = undefined;
}

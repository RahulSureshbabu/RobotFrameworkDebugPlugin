import * as vscode from 'vscode';
import { parseRobotTestCases } from './robotTestParser';

export class RobotCodeLensProvider implements vscode.CodeLensProvider {
	public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const isEnabled = vscode.workspace
			.getConfiguration('rfw-plugin')
			.get<boolean>('enableCodeLens', true);

		if (!isEnabled || !document.uri.fsPath.toLowerCase().endsWith('.robot')) {
			return [];
		}

		const topRange = new vscode.Range(0, 0, 0, 0);
		const suiteCodeLenses = [
			new vscode.CodeLens(topRange, {
				title: '▶ Run Suite',
				command: 'rfw-plugin.runRobotSuite',
				arguments: [document.uri],
			}),
			new vscode.CodeLens(topRange, {
				title: '🐞 Debug Suite',
				command: 'rfw-plugin.debugRobotSuite',
				arguments: [document.uri],
			}),
		];

		const testCodeLenses = parseRobotTestCases(document.getText()).flatMap((testCase) => {
			const range = new vscode.Range(testCase.line, 0, testCase.line, 0);

			return [
				new vscode.CodeLens(range, {
					title: '▶ Run Test',
					command: 'rfw-plugin.runRobotTest',
					arguments: [document.uri, testCase.name],
				}),
				new vscode.CodeLens(range, {
					title: '🐞 Debug Test',
					command: 'rfw-plugin.debugRobotTest',
					arguments: [document.uri, testCase.name],
				}),
			];
		});

		return [...suiteCodeLenses, ...testCodeLenses];
	}
}

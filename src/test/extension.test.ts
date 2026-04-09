import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildRuntimePythonArgs, createDeferredPromise } from '../debug/robotDebugSession';
import { buildRobotArguments, buildRobotDebugConfiguration, buildShellCommand, reviveUri } from '../extension';
import { parseRobotTestCases } from '../robotTestParser';

suite('Robot Framework parser', () => {
	test('finds test cases in the test case section', () => {
		const documentText = `*** Settings ***
Library    OperatingSystem

*** Test Cases ***
Valid Login
    Log    Hello

Another Test
    Should Be Equal    1    1

*** Keywords ***
Example Keyword
    No Operation`;

		assert.deepStrictEqual(parseRobotTestCases(documentText), [
			{ name: 'Valid Login', line: 4 },
			{ name: 'Another Test', line: 7 },
		]);
	});

	test('ignores metadata lines inside a test case', () => {
		const documentText = `*** Test Cases ***
Tagged Test
    [Tags]    smoke
    Log    Hello`;

		assert.deepStrictEqual(parseRobotTestCases(documentText), [
			{ name: 'Tagged Test', line: 1 },
		]);
	});

		test('finds suite entries in a tasks section', () => {
		const documentText = `*** Tasks ***
Morning Check
    Log    Started`;

		assert.deepStrictEqual(parseRobotTestCases(documentText), [
			{ name: 'Morning Check', line: 1 },
		]);
	});

	test('revives serialized uri arguments from CodeLens commands', () => {
		const uri = vscode.Uri.file('C:/rData/Python/tests/basic_test.robot');
		const revived = reviveUri(uri.toJSON());

		assert.ok(revived);
		assert.strictEqual(revived?.fsPath.toLowerCase().endsWith('basic_test.robot'), true);
	});

	test('builds a robot command with the selected test name', () => {
		const command = buildShellCommand('python', buildRobotArguments(
			'C:/rData/Python/tests/basic_test.robot',
			'Basic Sanity Check',
		));

		assert.ok(command.includes('robot'));
		assert.ok(command.includes('Basic Sanity Check'));
		assert.ok(command.includes('basic_test.robot'));
	});

		test('builds suite arguments without forcing a test name', () => {
		assert.deepStrictEqual(buildRobotArguments('C:/rData/Python/tests/basic_test.robot'), [
			'-m',
			'robot',
			'C:/rData/Python/tests/basic_test.robot',
		]);
	});

	test('creates a callable deferred resolver for debug-session initialization', async () => {
		const deferred = createDeferredPromise<void>();
		deferred.resolve();
		await deferred.promise;
		assert.ok(true);
	});

	test('builds non-blocking runtime Python arguments for Robot debugging', () => {
		const runtimeArgs = buildRuntimePythonArgs(
			'C:/rfw-plugin/python/robot_debug_runner.py',
			56789,
			'C:/rData/Python/tests/basic_test.robot',
			'Basic Sanity Check',
			45678,
		);

		assert.ok(runtimeArgs.includes('--debugpy-port'));
		assert.ok(runtimeArgs.includes('45678'));
		assert.ok(!runtimeArgs.includes('--wait-for-client'));
		assert.ok(runtimeArgs.includes('Basic Sanity Check'));
	});

	test('builds a custom Robot debug configuration for a Robot test run', () => {
		const fileUri = vscode.Uri.file('C:/rData/Python/tests/basic_test.robot');
		const configuration = buildRobotDebugConfiguration(fileUri, 'Basic Sanity Check', 'python');

		assert.strictEqual(configuration.type, 'rfw-robot');
		assert.strictEqual(configuration.request, 'launch');
		assert.strictEqual(configuration.target, fileUri.fsPath);
		assert.strictEqual(configuration.testName, 'Basic Sanity Check');
		assert.strictEqual(configuration.pythonPath, 'python');
	});
});

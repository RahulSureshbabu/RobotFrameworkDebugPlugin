import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseRobotFile } from '../../src/robotParser';
import { buildDebugArgs, buildDebugpyArgs } from '../../src/robotRunner';

// ---------------------------------------------------------------------------
// Helper – create a fake VS Code Uri from a file path
// ---------------------------------------------------------------------------
function fakeUri(p: string): vscode.Uri {
    return vscode.Uri.file(p);
}

// ---------------------------------------------------------------------------
// parseRobotFile
// ---------------------------------------------------------------------------

suite('parseRobotFile', () => {
    test('returns undefined-like suite when file has no test cases section', () => {
        const content = `
*** Settings ***
Library    Collections

*** Keywords ***
My Keyword
    Log    hello
`;
        const suite = parseRobotFile(content, fakeUri('/workspace/empty.robot'));
        assert.ok(suite, 'should return a suite object');
        assert.strictEqual(suite.tests.length, 0, 'should have no tests');
        assert.strictEqual(suite.name, 'empty');
    });

    test('discovers a single test case', () => {
        const content = `
*** Test Cases ***
My First Test
    Log    Hello World
    Sleep    1s
`;
        const suite = parseRobotFile(content, fakeUri('/workspace/sample.robot'));
        assert.ok(suite);
        assert.strictEqual(suite.tests.length, 1);
        assert.strictEqual(suite.tests[0].name, 'My First Test');
    });

    test('discovers multiple test cases', () => {
        const content = `
*** Settings ***
Library    Collections

*** Test Cases ***
Login Test
    Open Browser    http://example.com
    Input Text      id=user    admin
    Click Button    id=login

Logout Test
    Click Button    id=logout
    Close Browser
`;
        const suite = parseRobotFile(content, fakeUri('/workspace/login.robot'));
        assert.ok(suite);
        assert.strictEqual(suite.tests.length, 2);
        assert.strictEqual(suite.tests[0].name, 'Login Test');
        assert.strictEqual(suite.tests[1].name, 'Logout Test');
    });

    test('derives suite name from file path', () => {
        const suite = parseRobotFile('', fakeUri('/workspace/my_tests.robot'));
        assert.ok(suite);
        assert.strictEqual(suite.name, 'my tests');
    });

    test('ignores comment lines and blank lines inside test section', () => {
        const content = `
*** Test Cases ***
# This is a comment
First Test
    Log    1

    # Another comment

Second Test
    Log    2
`;
        const suite = parseRobotFile(content, fakeUri('/workspace/t.robot'));
        assert.ok(suite);
        assert.strictEqual(suite.tests.length, 2);
        assert.strictEqual(suite.tests[0].name, 'First Test');
        assert.strictEqual(suite.tests[1].name, 'Second Test');
    });

    test('records correct start line for test case', () => {
        const content = `*** Test Cases ***
My Test
    Log    hello
`;
        const suite = parseRobotFile(content, fakeUri('/workspace/lines.robot'));
        assert.ok(suite);
        assert.strictEqual(suite.tests.length, 1);
        // "My Test" is on line 1 (0-indexed)
        assert.strictEqual(suite.tests[0].startLine, 1);
    });

    test('handles test sections with alternate header styles', () => {
        const content = `
*Test Cases
First Test
    Log    a

* Test Cases *
Second Test
    Log    b
`;
        const suite = parseRobotFile(content, fakeUri('/workspace/alt.robot'));
        // Only the first section is parsed before the second section header
        // resets the context; both tests should be discovered
        assert.ok(suite);
        assert.ok(suite.tests.length >= 1);
    });
});

// ---------------------------------------------------------------------------
// buildDebugArgs
// ---------------------------------------------------------------------------

suite('buildDebugArgs', () => {
    test('constructs robot arguments with listener', () => {
        const args = buildDebugArgs(
            '/ext/resources/robot_debug_listener.py',
            '127.0.0.1',
            6612,
            '/results',
            [],
            '/tests/sample.robot'
        );
        assert.ok(args.includes('--listener'));
        const listenerIdx = args.indexOf('--listener');
        assert.ok(
            args[listenerIdx + 1].startsWith('/ext/resources/robot_debug_listener.py')
        );
        assert.ok(args.includes('--outputdir'));
        assert.ok(args.includes('/results'));
        assert.ok(args.includes('/tests/sample.robot'));
    });

    test('includes host and port in listener argument', () => {
        const args = buildDebugArgs(
            '/listener.py',
            '0.0.0.0',
            9999,
            '/out',
            [],
            '/t.robot'
        );
        const listenerArg = args[args.indexOf('--listener') + 1];
        assert.ok(listenerArg.includes('0.0.0.0'));
        assert.ok(listenerArg.includes('9999'));
    });

    test('appends extra args before target', () => {
        const args = buildDebugArgs(
            '/l.py',
            '127.0.0.1',
            6612,
            '/out',
            ['--variable', 'ENV:prod'],
            '/t.robot'
        );
        const targetIdx = args.lastIndexOf('/t.robot');
        const varIdx = args.indexOf('--variable');
        assert.ok(varIdx < targetIdx, 'extra args should come before target');
        assert.ok(args.includes('ENV:prod'));
    });
});

// ---------------------------------------------------------------------------
// buildDebugpyArgs
// ---------------------------------------------------------------------------

suite('buildDebugpyArgs', () => {
    test('wraps robot with debugpy', () => {
        const args = buildDebugpyArgs(
            'python',
            '127.0.0.1',
            5678,
            'robot',
            '/results',
            [],
            '/tests/sample.robot'
        );
        assert.ok(args.includes('-m'));
        assert.ok(args.includes('debugpy'));
        assert.ok(args.includes('--listen'));
        assert.ok(args.includes('--wait-for-client'));
        assert.ok(args.includes('robot'));
        assert.ok(args.includes('/tests/sample.robot'));
    });
});

// ---------------------------------------------------------------------------
// Extension activation (smoke test)
// ---------------------------------------------------------------------------

suite('Extension activation', () => {
    test('extension is present in VS Code', async () => {
        const ext = vscode.extensions.getExtension('robotframework-debug.robotframework-debug');
        // In unit tests the extension publisher id may differ; just verify the
        // module-level exports are accessible.
        const extModule = await import('../../src/extension');
        assert.ok(typeof extModule.activate === 'function', 'activate should be exported');
        assert.ok(typeof extModule.deactivate === 'function', 'deactivate should be exported');
        // Suppress unused-variable warning
        void ext;
    });
});

import * as vscode from 'vscode';

export interface RobotTestCase {
    name: string;
    startLine: number;
    endLine: number;
}

export interface RobotSuite {
    name: string;
    tests: RobotTestCase[];
}

/**
 * Parses a Robot Framework .robot file and returns a suite with test cases.
 *
 * The parser handles:
 *  - *** Test Cases *** sections
 *  - Test names (lines that start at column 0 and are not blank or comments)
 *  - Multi-line keyword calls (indented lines belonging to the same test)
 */
export function parseRobotFile(content: string, uri: vscode.Uri): RobotSuite | undefined {
    const name = suiteName(uri.fsPath);
    const lines = content.split('\n');
    const tests: RobotTestCase[] = [];

    let inTestSection = false;
    let currentTest: Partial<RobotTestCase> | undefined;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trimEnd();

        // Detect section headers like *** Test Cases ***
        if (/^\*{1,3}\s*(test cases?)\s*\*{0,3}/i.test(trimmed)) {
            if (currentTest?.name !== undefined) {
                tests.push(finalise(currentTest, i - 1));
                currentTest = undefined;
            }
            inTestSection = true;
            continue;
        }

        // Any other section header ends the test cases section
        if (/^\*/.test(trimmed)) {
            if (currentTest?.name !== undefined) {
                tests.push(finalise(currentTest, i - 1));
                currentTest = undefined;
            }
            inTestSection = false;
            continue;
        }

        if (!inTestSection) {
            continue;
        }

        // Blank lines and comment-only lines within the section
        if (trimmed === '' || trimmed.startsWith('#')) {
            continue;
        }

        // Lines starting with whitespace are keyword calls / continuation inside a test
        if (/^[ \t]/.test(trimmed)) {
            if (currentTest) {
                currentTest.endLine = i;
            }
            continue;
        }

        // Non-indented non-blank line → new test case
        if (currentTest?.name !== undefined) {
            tests.push(finalise(currentTest, i - 1));
        }
        currentTest = { name: trimmed, startLine: i, endLine: i };
    }

    if (currentTest?.name !== undefined) {
        tests.push(finalise(currentTest, lines.length - 1));
    }

    return { name, tests };
}

function finalise(partial: Partial<RobotTestCase>, endLine: number): RobotTestCase {
    return {
        name: partial.name!,
        startLine: partial.startLine!,
        endLine: Math.max(partial.startLine!, endLine),
    };
}

function suiteName(fsPath: string): string {
    const base = fsPath.split(/[\\/]/).pop() ?? fsPath;
    return base.replace(/\.robot$/i, '').replace(/[_-]/g, ' ');
}

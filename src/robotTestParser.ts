export interface RobotTestCase {
	name: string;
	line: number;
}

const TEST_CASE_SECTION_HEADER = /^\*{3}\s*(test cases?|tasks?)\s*\*{3}$/i;
const ANY_SECTION_HEADER = /^\*{3}.*\*{3}$/;

export function parseRobotTestCases(documentText: string): RobotTestCase[] {
	const lines = documentText.split(/\r?\n/);
	const testCases: RobotTestCase[] = [];
	let inTestCaseSection = false;

	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index];
		const trimmed = rawLine.trim();

		if (TEST_CASE_SECTION_HEADER.test(trimmed)) {
			inTestCaseSection = true;
			continue;
		}

		if (ANY_SECTION_HEADER.test(trimmed)) {
			inTestCaseSection = false;
			continue;
		}

		if (!inTestCaseSection || trimmed.length === 0 || trimmed.startsWith('#')) {
			continue;
		}

		if (trimmed.startsWith('...') || trimmed.startsWith('[')) {
			continue;
		}

		const firstCharacter = rawLine[0];
		if (firstCharacter === ' ' || firstCharacter === '\t') {
			continue;
		}

		testCases.push({
			name: trimmed,
			line: index,
		});
	}

	return testCases;
}

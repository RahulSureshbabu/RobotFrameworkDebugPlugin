import * as vscode from 'vscode';
import * as path from 'path';
import { RobotRunner } from './robotRunner';
import { parseRobotFile } from './robotParser';

/**
 * Manages VS Code Test Controller integration for Robot Framework.
 * Discovers .robot files, populates the test tree, and runs/debugs tests.
 */
export class RobotTestController implements vscode.Disposable {
    private readonly controller: vscode.TestController;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly fileWatchers: vscode.FileSystemWatcher[] = [];
    private readonly testItems = new Map<string, vscode.TestItem>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly runner: RobotRunner,
        private readonly outputChannel: vscode.OutputChannel
    ) {
        this.controller = vscode.tests.createTestController(
            'robotFrameworkTests',
            'Robot Framework'
        );
        this.context.subscriptions.push(this.controller);

        this.controller.resolveHandler = async (item) => {
            if (!item) {
                await this.discoverAllTests();
            } else {
                await this.resolveTestItem(item);
            }
        };

        this.controller.refreshHandler = async () => {
            await this.discoverAllTests();
        };

        this.setupRunProfiles();
        this.setupFileWatchers();
    }

    /** Called when the user triggers a refresh. */
    public async refresh(): Promise<void> {
        await this.discoverAllTests();
    }

    /** Run or debug a specific .robot file, triggered from editor commands. */
    public async runFile(uri: vscode.Uri, debug: boolean): Promise<void> {
        const items: vscode.TestItem[] = [];
        this.controller.items.forEach((item) => {
            if (item.uri?.toString() === uri.toString()) {
                items.push(item);
            }
        });
        if (items.length === 0) {
            // File not discovered yet – run it directly via runner
            const config = this.getConfig();
            await this.runner.runTarget(uri.fsPath, [], config, this.outputChannel, debug);
            return;
        }
        const request = new vscode.TestRunRequest(items);
        if (debug) {
            await this.runTests(request, new vscode.CancellationTokenSource().token, true);
        } else {
            await this.runTests(request, new vscode.CancellationTokenSource().token, false);
        }
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private setupRunProfiles(): void {
        this.controller.createRunProfile(
            'Run',
            vscode.TestRunProfileKind.Run,
            (request, token) => this.runTests(request, token, false),
            true
        );

        this.controller.createRunProfile(
            'Debug',
            vscode.TestRunProfileKind.Debug,
            (request, token) => this.runTests(request, token, true),
            false
        );
    }

    private setupFileWatchers(): void {
        const config = this.getConfig();
        for (const pattern of config.discoverPatterns) {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidCreate((uri) => this.handleFileChange(uri));
            watcher.onDidChange((uri) => this.handleFileChange(uri));
            watcher.onDidDelete((uri) => this.handleFileDelete(uri));
            this.fileWatchers.push(watcher);
            this.disposables.push(watcher);
        }
    }

    private async handleFileChange(uri: vscode.Uri): Promise<void> {
        await this.loadTestFile(uri);
    }

    private handleFileDelete(uri: vscode.Uri): void {
        const key = uri.toString();
        const item = this.testItems.get(key);
        if (item) {
            this.controller.items.delete(item.id);
            this.testItems.delete(key);
        }
    }

    private async discoverAllTests(): Promise<void> {
        this.controller.items.replace([]);
        this.testItems.clear();

        const config = this.getConfig();
        for (const pattern of config.discoverPatterns) {
            const files = await vscode.workspace.findFiles(
                pattern,
                `{${config.excludePatterns.join(',')}}`
            );
            await Promise.all(files.map((f) => this.loadTestFile(f)));
        }
    }

    private async resolveTestItem(item: vscode.TestItem): Promise<void> {
        if (item.uri) {
            await this.loadTestFile(item.uri);
        }
    }

    private async loadTestFile(uri: vscode.Uri): Promise<void> {
        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(uri);
        } catch {
            return;
        }

        const suite = parseRobotFile(document.getText(), uri);
        if (!suite) {
            return;
        }

        const suiteItem = this.getOrCreateSuiteItem(uri, suite.name);
        suiteItem.children.replace([]);

        for (const test of suite.tests) {
            const testItem = this.controller.createTestItem(
                `${uri.toString()}::${test.name}`,
                test.name,
                uri
            );
            testItem.range = new vscode.Range(
                new vscode.Position(test.startLine, 0),
                new vscode.Position(test.endLine, 0)
            );
            suiteItem.children.add(testItem);
        }
    }

    private getOrCreateSuiteItem(uri: vscode.Uri, name: string): vscode.TestItem {
        const key = uri.toString();
        const existing = this.testItems.get(key);
        if (existing) {
            return existing;
        }
        const item = this.controller.createTestItem(uri.toString(), name, uri);
        item.canResolveChildren = true;
        this.controller.items.add(item);
        this.testItems.set(key, item);
        return item;
    }

    private async runTests(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        debug: boolean
    ): Promise<void> {
        const run = this.controller.createTestRun(request);
        const config = this.getConfig();

        try {
            // Collect items to run, grouping by file
            const fileMap = new Map<string, { uri: vscode.Uri; tests: string[] }>();
            const allItems = this.collectItems(request);

            for (const item of allItems) {
                if (token.isCancellationRequested) {
                    break;
                }
                run.started(item);
                const uri = item.uri;
                if (!uri) {
                    continue;
                }
                const fsPath = uri.fsPath;
                if (!fileMap.has(fsPath)) {
                    fileMap.set(fsPath, { uri, tests: [] });
                }
                // If item has no parent test-case name, it's a suite-level item → run all
                const isSuite = item.id === uri.toString();
                if (!isSuite) {
                    // Extract test name from id: "<uri>::<testName>"
                    const testName = item.label;
                    fileMap.get(fsPath)!.tests.push(testName);
                }
            }

            for (const [fsPath, { tests }] of fileMap) {
                if (token.isCancellationRequested) {
                    break;
                }

                const args: string[] = [];
                if (tests.length > 0) {
                    for (const t of tests) {
                        args.push('--test', t);
                    }
                }

                const start = Date.now();
                try {
                    await this.runner.runTarget(fsPath, args, config, this.outputChannel, debug);
                    // Mark items for this file as passed
                    for (const item of allItems) {
                        if (item.uri?.fsPath === fsPath) {
                            run.passed(item, Date.now() - start);
                        }
                    }
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    for (const item of allItems) {
                        if (item.uri?.fsPath === fsPath) {
                            run.failed(item, new vscode.TestMessage(message), Date.now() - start);
                        }
                    }
                }
            }
        } finally {
            run.end();
        }
    }

    private collectItems(request: vscode.TestRunRequest): vscode.TestItem[] {
        const items: vscode.TestItem[] = [];

        if (request.include) {
            for (const item of request.include) {
                items.push(...this.flattenItem(item));
            }
        } else {
            this.controller.items.forEach((item) => {
                items.push(...this.flattenItem(item));
            });
        }

        if (request.exclude) {
            const excludeIds = new Set(request.exclude.map((i) => i.id));
            return items.filter((i) => !excludeIds.has(i.id));
        }

        return items;
    }

    private flattenItem(item: vscode.TestItem): vscode.TestItem[] {
        const result: vscode.TestItem[] = [item];
        item.children.forEach((child) => {
            result.push(...this.flattenItem(child));
        });
        return result;
    }

    private getConfig(): RobotConfig {
        const cfg = vscode.workspace.getConfiguration('robotframework');
        return {
            pythonPath: cfg.get<string>('pythonPath', 'python'),
            robotCommand: cfg.get<string>('robotCommand', 'robot'),
            outputDir: cfg.get<string>('outputDir', path.join('${workspaceFolder}', 'results')),
            extraArgs: cfg.get<string[]>('extraArgs', []),
            debugPort: cfg.get<number>('debugPort', 6612),
            debugHost: cfg.get<string>('debugHost', '127.0.0.1'),
            discoverPatterns: cfg.get<string[]>('discoverPatterns', ['**/*.robot']),
            excludePatterns: cfg.get<string[]>('excludePatterns', [
                '**/node_modules/**',
                '**/.venv/**',
                '**/venv/**',
            ]),
        };
    }

    public dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.controller.dispose();
    }
}

export interface RobotConfig {
    pythonPath: string;
    robotCommand: string;
    outputDir: string;
    extraArgs: string[];
    debugPort: number;
    debugHost: string;
    discoverPatterns: string[];
    excludePatterns: string[];
}

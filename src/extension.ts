import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const JSONL_FILENAME = '.paper-comments.jsonl';
const DIAG_SOURCE = 'paper-review';

interface PaperComment {
	file: string;
	line: number;
	severity?: 'error' | 'warning' | 'info' | 'hint';
	message: string;
	addressed?: boolean;
	category?: string;
	pass?: string;
	agent?: string;
}

function toSeverity(s?: string): vscode.DiagnosticSeverity {
	switch (s) {
		case 'error': return vscode.DiagnosticSeverity.Error;
		case 'warning': return vscode.DiagnosticSeverity.Warning;
		case 'hint': return vscode.DiagnosticSeverity.Hint;
		default: return vscode.DiagnosticSeverity.Information;
	}
}

function loadComments(jsonlPath: string): PaperComment[] {
	const content = fs.readFileSync(jsonlPath, 'utf-8');
	const comments: PaperComment[] = [];
	for (const raw of content.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		try {
			comments.push(JSON.parse(line));
		} catch {
			// skip malformed lines
		}
	}
	return comments;
}

function findJsonlPath(doc: vscode.TextDocument): string | undefined {
	const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
	if (!folder) return;
	const p = path.join(folder.uri.fsPath, JSONL_FILENAME);
	return fs.existsSync(p) ? p : undefined;
}

function findCommentForDiag(jsonlPath: string, doc: vscode.TextDocument, diag: vscode.Diagnostic): { comment: PaperComment; index: number } | undefined {
	const relFile = vscode.workspace.asRelativePath(doc.uri, false);
	const comments = loadComments(jsonlPath);
	const diagLine = diag.range.start.line + 1;
	for (let i = 0; i < comments.length; i++) {
		const c = comments[i];
		if (c.addressed) continue;
		if (c.file === relFile && c.line === diagLine && c.message === diag.message) {
			return { comment: c, index: i };
		}
	}
	return undefined;
}

function markAddressed(jsonlPath: string, index: number) {
	const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n');
	let jsonLineIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim()) continue;
		jsonLineIndex++;
		if (jsonLineIndex === index) {
			try {
				const obj = JSON.parse(lines[i]);
				obj.addressed = true;
				lines[i] = JSON.stringify(obj);
			} catch { /* skip */ }
			break;
		}
	}
	fs.writeFileSync(jsonlPath, lines.join('\n'), 'utf-8');
}

function buildDiscussPrompt(comment: PaperComment, sourceLine: string): string {
	const parts = [
		`I want to discuss this review comment on my paper.`,
		``,
		`File: ${comment.file}, Line ${comment.line}`,
	];
	if (comment.category) parts.push(`Category: ${comment.category}`);
	if (comment.agent) parts.push(`Agent: ${comment.agent} (pass ${comment.pass ?? '?'})`);
	parts.push(
		`Source text: ${sourceLine.trim()}`,
		``,
		`Review comment (severity: ${comment.severity ?? 'info'}):`,
		comment.message,
		``,
		`What do you think? Should I address this, and if so, how?`,
	);
	return parts.join('\n');
}

class PaperHoverProvider implements vscode.HoverProvider {
	constructor(private collection: vscode.DiagnosticCollection) {}

	provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
		const diags = this.collection.get(doc.uri);
		if (!diags) return;

		const hit = diags.filter(d => d.range.contains(pos));
		if (!hit.length) return;

		const parts: vscode.MarkdownString[] = [];
		for (const diag of hit) {
			const lineNum = diag.range.start.line;
			const discussArgs = encodeURIComponent(JSON.stringify([doc.uri.toString(), lineNum, diag.message]));
			const markArgs = encodeURIComponent(JSON.stringify([doc.uri.toString(), lineNum, diag.message]));

			const md = new vscode.MarkdownString();
			md.isTrusted = true;
			md.appendMarkdown(`[Discuss](command:paper-comments.discussFromHover?${discussArgs}) | `);
			md.appendMarkdown(`[Addressed](command:paper-comments.markFromHover?${markArgs})`);
			parts.push(md);
		}

		return new vscode.Hover(parts);
	}
}

function refresh(jsonlPath: string, workspaceRoot: string, collection: vscode.DiagnosticCollection) {
	collection.clear();
	if (!fs.existsSync(jsonlPath)) return;

	const comments = loadComments(jsonlPath).filter(c => !c.addressed);

	const byFile = new Map<string, vscode.Diagnostic[]>();
	for (const c of comments) {
		const lineNum = Math.max(0, (c.line ?? 1) - 1);
		const range = new vscode.Range(lineNum, 0, lineNum, Number.MAX_SAFE_INTEGER);
		const diag = new vscode.Diagnostic(range, c.message, toSeverity(c.severity));
		diag.source = DIAG_SOURCE;
		if (c.category) {
			diag.code = c.category;
		}

		const filePath = c.file;
		if (!byFile.has(filePath)) byFile.set(filePath, []);
		byFile.get(filePath)!.push(diag);
	}

	for (const [filePath, diags] of byFile) {
		const uri = vscode.Uri.file(path.resolve(workspaceRoot, filePath));
		collection.set(uri, diags);
	}
}

class PaperCommentActionProvider implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	provideCodeActions(
		doc: vscode.TextDocument,
		range: vscode.Range,
		context: vscode.CodeActionContext
	): vscode.CodeAction[] {
		const actions: vscode.CodeAction[] = [];
		const paperDiags = context.diagnostics.filter(d => d.source === DIAG_SOURCE);
		if (!paperDiags.length) return actions;

		for (const diag of paperDiags) {
			const discuss = new vscode.CodeAction('Discuss with LLM', vscode.CodeActionKind.QuickFix);
			discuss.command = {
				command: 'paper-comments.discuss',
				title: 'Discuss with LLM',
				arguments: [doc, diag]
			};
			discuss.diagnostics = [diag];
			discuss.isPreferred = false;
			actions.push(discuss);

			const mark = new vscode.CodeAction('Mark Addressed', vscode.CodeActionKind.QuickFix);
			mark.command = {
				command: 'paper-comments.markAddressed',
				title: 'Mark Addressed',
				arguments: [doc, diag]
			};
			mark.diagnostics = [diag];
			mark.isPreferred = false;
			actions.push(mark);
		}

		return actions;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const collection = vscode.languages.createDiagnosticCollection('paper-comments');
	context.subscriptions.push(collection);

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ scheme: 'file' },
			new PaperCommentActionProvider(),
			{ providedCodeActionKinds: PaperCommentActionProvider.providedCodeActionKinds }
		)
	);

	context.subscriptions.push(
		vscode.languages.registerHoverProvider({ scheme: 'file' }, new PaperHoverProvider(collection))
	);

	function resolveDocAndDiag(uriStr: string, lineNum: number, message: string): { doc: vscode.TextDocument; diag: vscode.Diagnostic } | undefined {
		const uri = vscode.Uri.parse(uriStr);
		const diags = collection.get(uri);
		if (!diags) return;
		const diag = diags.find(d => d.range.start.line === lineNum && d.message === message);
		if (!diag) return;
		const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriStr);
		if (!doc) return;
		return { doc, diag };
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('paper-comments.discuss', async (doc: vscode.TextDocument, diag: vscode.Diagnostic) => {
			const jsonlPath = findJsonlPath(doc);
			if (!jsonlPath) return;
			const match = findCommentForDiag(jsonlPath, doc, diag);
			if (!match) return;

			const sourceLine = doc.lineAt(diag.range.start.line).text;
			const prompt = buildDiscussPrompt(match.comment, sourceLine);
			await vscode.env.clipboard.writeText(prompt);
			vscode.window.showInformationMessage('Comment context copied to clipboard — paste into your LLM chat.');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('paper-comments.discussFromHover', async (uriStr: string, lineNum: number, message: string) => {
			const resolved = resolveDocAndDiag(uriStr, lineNum, message);
			if (!resolved) return;
			await vscode.commands.executeCommand('paper-comments.discuss', resolved.doc, resolved.diag);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('paper-comments.markAddressed', async (doc: vscode.TextDocument, diag: vscode.Diagnostic) => {
			const jsonlPath = findJsonlPath(doc);
			if (!jsonlPath) return;
			const match = findCommentForDiag(jsonlPath, doc, diag);
			if (!match) return;

			markAddressed(jsonlPath, match.index);
			vscode.window.showInformationMessage(`Comment on line ${match.comment.line} marked as addressed.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('paper-comments.markFromHover', async (uriStr: string, lineNum: number, message: string) => {
			const resolved = resolveDocAndDiag(uriStr, lineNum, message);
			if (!resolved) return;
			await vscode.commands.executeCommand('paper-comments.markAddressed', resolved.doc, resolved.diag);
		})
	);

	const folders = vscode.workspace.workspaceFolders;
	if (!folders) return;

	for (const folder of folders) {
		const root = folder.uri.fsPath;
		const jsonlPath = path.join(root, JSONL_FILENAME);

		refresh(jsonlPath, root, collection);

		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(folder, JSONL_FILENAME)
		);
		watcher.onDidChange(() => refresh(jsonlPath, root, collection));
		watcher.onDidCreate(() => refresh(jsonlPath, root, collection));
		watcher.onDidDelete(() => collection.clear());
		context.subscriptions.push(watcher);
	}
}

export function deactivate() {}

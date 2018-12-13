/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
	createConnection,
	TextDocuments,
	TextDocument,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	Location,
	Range
} from 'vscode-languageserver';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
	hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
	hasDiagnosticRelatedInformationCapability =
		!!(capabilities.textDocument &&
			capabilities.textDocument.publishDiagnostics &&
			capabilities.textDocument.publishDiagnostics.relatedInformation);

	return {
		capabilities: {
			textDocumentSync: documents.syncKind,
			// Tell the client that the server supports code completion
			completionProvider: {
				resolveProvider: true
			},
			referencesProvider: true,
		}
	};
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(
			DidChangeConfigurationNotification.type,
			undefined
		);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'languageServerExample'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

const documentMap = new Map<string, any>()

const parseSource = (source: string) => {
	let envs = []
	let id = 0

	let refs: any[] = []
	let diags: any[] = []
	let i = 0
	const isName = s => {
		return /[a-zA-Z_]/.test(s)
	}
	const followedByExpr = () => {
		return i < source.length && (isName(source[i]) || source[i] === '(')
	}
	const skipSpaces = () => {
		while (source[i] === ' ' || source[i] === '\n') {
			i++
		}
	}
	const parseName = onName => {
		if (!isName(source[i])) {
			diags.push({
				type: "warn",
				range: [i, i + 1],
				message: "Expected an identifier",
			})
			return
		}

		const name = source[i]
		i++
		onName(name)
	}
	const expect = (expected, next) => {
		if (!source.startsWith(expected, i)) {
			diags.push({
				range: [i, i + 1],
				message: `Expected ${expected}`,
				source: "lambda"
			})
			return
		}

		i += expected.length
		next()
	}

	const parseAtom = next => {
		if (source[i] === '(') {
			i += 1
			skipSpaces()
			parseExpr(expr => {
				expect(')', () => {
					skipSpaces()
					next(expr)
				})
			})
			return
		}

		if (isName(source[i])) {
			const start = i
			parseName(name => {
				const end = i
				let nameId = -1
				for (let d = envs.length - 1; d >= 0; d--) {
					if (envs[d][name] !== undefined) {
						nameId = envs[d][name]
						break
					}
				}
				if (nameId < 0) {
					diags.push({
						message: "Undefined: " + JSON.stringify({name,envs}),
						range: [start, end],
					})
				} else {
					refs.push({
						type: "ref", nameId, name, range: [start, end],
					})
				}
				next({ type: "ref", name })
			})
			return
		}

		diags.push({
			range: [i, i + 1],
			message: `Expected an atomic expression`,
			source: "lambda"
		})
	}

	const parseApp = next => {
		parseAtom(l => {
			skipSpaces()

			if (followedByExpr()) {
				parseExpr(r => {
					next({ type: "app", l, r })
				})
				return
			}

			next(l)
		})
	}

	const parseExpr = next => {
		if (i >= source.length) {
			diags.push({
				range: [i, i + 1],
				message: `Expected an expression buf eof`,
			})
			return
		}

		if (source.startsWith("fun", i)) {
			i += 3

			skipSpaces()
			const start = i
			parseName(name => {
				const end = i

				const nameId = ++id
				envs.push({ [name]: nameId })
				refs.push({ type: "def", nameId, name, range: [start, end] })

				skipSpaces()
				expect("->", () => {
					skipSpaces()

					parseExpr(body => {
						envs.pop()
						next({ type: "fun", arg: name, body })
					})
				})
			})
			return
		}

		parseApp(next)
	}

	skipSpaces()
	if (i < source.length) {
		parseExpr(() => {
			skipSpaces()

			if (i < source.length) {
				diags.push({
					range: [i, i + 1],
					message: `Expected an eof`,
				})
			}
		})
	}

	return {
		diags,
		refs,
	}
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	const { diags, refs } = parseSource(textDocument.getText())

	const diagnostics = diags.map(d => {
		const [start, end] = d.range
		const { message } = d
		return {
			severity: DiagnosticSeverity.Warning,
			range: { start: textDocument.positionAt(start), end: textDocument.positionAt(end) },
			message,
			source: "lambda"
		}
	})
	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });

	const references = refs.map(({ type, nameId, name, range: [start, end] }) => {
		const range = {
			start: textDocument.positionAt(start),
			end: textDocument.positionAt(end),
		}
		return { type, nameId, name, range }
	})

	documentMap.set(textDocument.uri, { references })

	// // In this simple example we get the settings for every validate run.
	// let settings = await getDocumentSettings(textDocument.uri);

	// // The validator creates diagnostics for all uppercase words length 2 and more
	// let text = textDocument.getText();
	// let pattern = /\b[A-Z]{2,}\b/g;
	// let m: RegExpExecArray | null;

	// let problems = 0;
	// let diagnostics: Diagnostic[] = [];
	// while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
	// 	problems++;
	// 	let diagnosic: Diagnostic = {
	// 		severity: DiagnosticSeverity.Warning,
	// 		range: {
	// 			start: textDocument.positionAt(m.index),
	// 			end: textDocument.positionAt(m.index + m[0].length)
	// 		},
	// 		message: `${m[0]} is all uppercase.`,
	// 		source: 'ex'
	// 	};
	// 	if (hasDiagnosticRelatedInformationCapability) {
	// 		diagnosic.relatedInformation = [
	// 			{
	// 				location: {
	// 					uri: textDocument.uri,
	// 					range: Object.assign({}, diagnosic.range)
	// 				},
	// 				message: 'Spelling matters'
	// 			},
	// 			{
	// 				location: {
	// 					uri: textDocument.uri,
	// 					range: Object.assign({}, diagnosic.range)
	// 				},
	// 				message: 'Particularly for names'
	// 			}
	// 		];
	// 	}
	// 	diagnostics.push(diagnosic);
	// }

	// // Send the computed diagnostics to VSCode.
	// connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// The pass parameter contains the position of the text document in
		// which code complete got requested. For the example we ignore this
		// info and always provide the same completion items.
		return [
			{
				label: 'TypeScript',
				kind: CompletionItemKind.Text,
				data: 1
			},
			{
				label: 'JavaScript',
				kind: CompletionItemKind.Text,
				data: 2
			}
		];
	}
);

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (item.data === 1) {
			(item.detail = 'TypeScript details'),
				(item.documentation = 'TypeScript documentation');
		} else if (item.data === 2) {
			(item.detail = 'JavaScript details'),
				(item.documentation = 'JavaScript documentation');
		}
		return item;
	}
);

connection.onReferences(async params => {
	const { context, textDocument, position } = params
	const c = documentMap.get(textDocument.uri)
	if (!c) {
		return []
	}

	const { references } = c
	const locations = []
	for (const { nameId: targetNameId, range: { start, end } } of references) {
		if (position.line === start.line && position.character === start.character) {
			for (const { type, nameId, range } of references) {
				if (!context.includeDeclaration && type === "def") {
					continue
				}
				if (nameId !== targetNameId) {
					continue
				}

				locations.push(Location.create(textDocument.uri, range))
			}
		}
	}

	return locations
})

/*
connection.onDidOpenTextDocument((params) => {
	// A text document got opened in VSCode.
	// params.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.text the initial full content of the document.
	connection.console.log(`${params.textDocument.uri} opened.`);
});
connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

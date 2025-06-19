import * as vscode from 'vscode';

// Global diagnostic collection
let diagnosticCollection: vscode.DiagnosticCollection;

// Per-document validation timeouts
const validationTimeouts = new Map<string, NodeJS.Timeout>();

// Global preview panel reference
let previewPanel: vscode.WebviewPanel | undefined;

// Define proper document selector for MML files
const MML_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
    { scheme: 'file', language: 'mml' },
    { scheme: 'untitled', language: 'mml' }
];

export function activate(context: vscode.ExtensionContext) {
    console.log('MML extension is now active!');

    // Create diagnostic collection
    diagnosticCollection = vscode.languages.createDiagnosticCollection('mml');
    context.subscriptions.push(diagnosticCollection);

    // Function to send MML content to preview
    function sendToPreview(content: string) {
        if (previewPanel) {
            previewPanel.webview.postMessage({
                type: 'source',
                source: content
            });
        }
    }

    // Validation function that can be called from multiple places
    function validateMMLDocument(document: vscode.TextDocument, showMessage: boolean = false) {
        // The document selector should have already filtered this, but be defensive
        if (document.languageId !== 'mml') {
            return;
        }

        const text = document.getText();
        const diagnostics: vscode.Diagnostic[] = [];
        
        // Check for proper tag opening/closing
        const tagStack: Array<{ tag: string, line: number, character: number }> = [];
        
        // Use a more robust approach to find all tags, including multiline ones
        const allTagMatches: Array<{ tag: string, isClosing: boolean, isSelfClosing: boolean, position: vscode.Position, fullMatch: string }> = [];
        
        // Split into lines for position tracking
        const lines = text.split('\n');
        
        // First pass: find all closing tags (they're unambiguous)
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            
            const closingTagRegex = /<\/m-([a-z-]+)>/g;
            let match;
            
            while ((match = closingTagRegex.exec(line)) !== null) {
                const tagName = match[1];
                const position = new vscode.Position(lineIndex, match.index);
                allTagMatches.push({
                    tag: `m-${tagName}`,
                    isClosing: true,
                    isSelfClosing: false,
                    position: position,
                    fullMatch: match[0]
                });
            }
        }
        
        // Second pass: find all opening tags (including multiline ones)
        let currentPos = 0;
        const openingTagRegex = /<m-([a-z-]+)(?=[\s>])/g;
        
        while (currentPos < text.length) {
            openingTagRegex.lastIndex = currentPos;
            const match = openingTagRegex.exec(text);
            if (!match) {
                break;
            }
            
            const tagName = match[1];
            const matchStart = match.index;
            
            // Convert absolute position to line/character
            const beforeMatch = text.substring(0, matchStart);
            const lineBreaks = beforeMatch.split('\n');
            const lineIndex = lineBreaks.length - 1;
            const charIndex = lineBreaks[lineBreaks.length - 1].length;
            const position = new vscode.Position(lineIndex, charIndex);
            
            // Now find the end of this tag (the closing >)
            let searchPos = matchStart + match[0].length;
            let depth = 1; // We're inside a tag
            let isSelfClosing = false;
            let foundEnd = false;
            
            while (searchPos < text.length && depth > 0) {
                const char = text[searchPos];
                
                if (char === '<') {
                    depth++;
                } else if (char === '>') {
                    depth--;
                    if (depth === 0) {
                        // Check if this is self-closing by looking at the character before >
                        if (searchPos > 0 && text[searchPos - 1] === '/') {
                            isSelfClosing = true;
                        }
                        foundEnd = true;
                        break;
                    }
                }
                searchPos++;
            }
            
            if (foundEnd) {
                allTagMatches.push({
                    tag: `m-${tagName}`,
                    isClosing: false,
                    isSelfClosing: isSelfClosing,
                    position: position,
                    fullMatch: match[0]
                });
            }
            
            currentPos = match.index + 1; // Move past this match
        }
        
        // Sort matches by position (line first, then character)
        allTagMatches.sort((a, b) => {
            if (a.position.line !== b.position.line) {
                return a.position.line - b.position.line;
            }
            return a.position.character - b.position.character;
        });
        
        // Process the sorted matches
        for (const tagMatch of allTagMatches) {
            if (tagMatch.isSelfClosing) {
                // Self-closing tags don't need to be tracked
                continue;
            }
            
            if (tagMatch.isClosing) {
                // Find the most recent matching opening tag (LIFO behavior)
                let lastOpeningIndex = -1;
                for (let i = tagStack.length - 1; i >= 0; i--) {
                    if (tagStack[i].tag === tagMatch.tag) {
                        lastOpeningIndex = i;
                        break;
                    }
                }
                
                if (lastOpeningIndex === -1) {
                    // No matching opening tag found
                    const diagnostic = new vscode.Diagnostic(
                        new vscode.Range(tagMatch.position, tagMatch.position.translate(0, tagMatch.fullMatch.length)),
                        `Closing tag </${tagMatch.tag}> has no matching opening tag`,
                        vscode.DiagnosticSeverity.Error
                    );
                    diagnostics.push(diagnostic);
                } else {
                    // Remove the matched opening tag from stack
                    tagStack.splice(lastOpeningIndex, 1);
                }
            } else {
                // It's an opening tag - add to stack
                tagStack.push({
                    tag: tagMatch.tag,
                    line: tagMatch.position.line,
                    character: tagMatch.position.character
                });
            }
        }
        
        // Check for unclosed tags
        for (const unclosedTag of tagStack) {
            const position = new vscode.Position(unclosedTag.line, unclosedTag.character);
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(position, position.translate(0, unclosedTag.tag.length + 1)),
                `Opening tag <${unclosedTag.tag}> is not properly closed`,
                vscode.DiagnosticSeverity.Error
            );
            diagnostics.push(diagnostic);
        }
        
        // Set diagnostics
        diagnosticCollection.set(document.uri, diagnostics);
        
        // If validation passed (no errors), send content to preview
        if (diagnostics.length === 0) {
            sendToPreview(text);
        }
        
        // Show message if requested (for manual validation command)
        if (showMessage) {
            const mmlElements = text.match(/<m-[a-z-]+/g);
            const elementCount = mmlElements ? mmlElements.length : 0;
            
            if (diagnostics.length === 0) {
                vscode.window.showInformationMessage(
                    `✅ MML validation passed! Found ${elementCount} properly formatted MML element(s).`
                );
            } else {
                vscode.window.showWarningMessage(
                    `⚠️ MML validation found ${diagnostics.length} issue(s). Check the Problems panel for details.`
                );
            }
        }
    }

    // Function to create or show the preview panel
    function createOrShowPreview() {
        const columnToShowIn = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : undefined;

        if (previewPanel) {
            // If we already have a panel, show it
            previewPanel.reveal(columnToShowIn);
            return;
        }

        // Otherwise, create a new panel
        previewPanel = vscode.window.createWebviewPanel(
            'mmlPreview',
            'MML 3D Preview',
            columnToShowIn || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Set the webview's initial html content
        previewPanel.webview.html = getWebviewContent();

        // Handle messages from the webview
        previewPanel.webview.onDidReceiveMessage(
            (message: any) => {
                switch (message.command) {
                    case 'alert':
                        vscode.window.showErrorMessage(message.text);
                        return;
                }
            },
            undefined,
            context.subscriptions
        );

        // Reset when the current panel is closed
        previewPanel.onDidDispose(
            () => {
                previewPanel = undefined;
            },
            null,
            context.subscriptions
        );

        // If there's an active MML document, send its content to the preview
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'mml') {
            const text = activeEditor.document.getText();
            // Only send if validation would pass (no need to re-validate, just check if there are current diagnostics)
            const currentDiagnostics = diagnosticCollection.get(activeEditor.document.uri);
            if (!currentDiagnostics || currentDiagnostics.length === 0) {
                sendToPreview(text);
            }
        }
    }

    // Function to generate the webview HTML content
    function getWebviewContent() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MML 3D Preview</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            background: #1e1e1e;
            overflow: hidden;
        }
        iframe {
            width: 100%;
            height: 100vh;
            border: none;
        }
        .loading {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: #cccccc;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="loading" id="loading">Loading MML Preview...</div>
    <iframe id="preview-frame" src="https://new.mml-view.space" style="display: none;"></iframe>
    
    <script>
        const vscode = acquireVsCodeApi();
        const iframe = document.getElementById('preview-frame');
        const loading = document.getElementById('loading');
        
        // Show iframe once it loads
        iframe.onload = function() {
            loading.style.display = 'none';
            iframe.style.display = 'block';
        };
        
        // Handle messages from VS Code
        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.type === 'source') {
                // Forward the message to the iframe
                iframe.contentWindow.postMessage({
                    type: 'source',
                    source: message.source
                }, 'https://new.mml-view.space');
            }
        });
        
        // Handle messages from the iframe (if needed)
        window.addEventListener('message', event => {
            if (event.origin === 'https://new.mml-view.space') {
                // Handle any messages from the MML viewer if needed
                console.log('Message from MML viewer:', event.data);
            }
        });
    </script>
</body>
</html>`;
    }

    // Register command to open MML preview
    const openPreviewCommand = vscode.commands.registerCommand('mml.openPreview', () => {
        createOrShowPreview();
    });

    // Register a command to manually validate MML syntax
    const validateMMLCommand = vscode.commands.registerCommand('mml.validateSyntax', () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showWarningMessage('No active editor found');
            return;
        }

        const document = activeEditor.document;
        if (document.languageId !== 'mml') {
            vscode.window.showWarningMessage('This command only works with MML files');
            return;
        }

        validateMMLDocument(document, true);
    });

    // Auto-validate when opening MML files - VS Code filters based on language registration
    const onDidOpenTextDocument = vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument) => {
        if (document.languageId === 'mml') {
            validateMMLDocument(document);
        }
    });

    // Auto-validate on text changes (debounced) - VS Code filters based on language registration
    const onDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
        if (event.document.languageId === 'mml') {
            // Clear existing timeout
            const timeout = validationTimeouts.get(event.document.uri.toString());
            if (timeout) {
                clearTimeout(timeout);
            }
            
            // Set new timeout for validation (500ms delay)
            const newTimeout = setTimeout(() => {
                validateMMLDocument(event.document);
            }, 500);

            validationTimeouts.set(event.document.uri.toString(), newTimeout);
        }
    });

    // Validate already open MML documents on activation
    vscode.workspace.textDocuments.forEach((document: vscode.TextDocument) => {
        if (document.languageId === 'mml') {
            validateMMLDocument(document);
        }
    });

    // Clear diagnostics when MML files are closed
    const onDidCloseTextDocument = vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
        if (document.languageId === 'mml') {
            diagnosticCollection.delete(document.uri);
            validationTimeouts.delete(document.uri.toString());
        }
    });

    // Register completion provider for MML attributes using proper document selector
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        MML_DOCUMENT_SELECTOR,
        {
            provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
                const linePrefix = document.lineAt(position).text.substr(0, position.character);
                
                // Check if we're inside an MML tag
                const mmlTagMatch = linePrefix.match(/<m-[a-z-]+[^>]*$/);
                if (!mmlTagMatch) {
                    return undefined;
                }

                // Provide common MML attribute completions
                const attributeCompletions = [
                    // Transform attributes
                    { name: 'x', detail: 'X position', insertText: 'x="${1:0}"' },
                    { name: 'y', detail: 'Y position', insertText: 'y="${1:0}"' },
                    { name: 'z', detail: 'Z position', insertText: 'z="${1:0}"' },
                    { name: 'rx', detail: 'X rotation', insertText: 'rx="${1:0}"' },
                    { name: 'ry', detail: 'Y rotation', insertText: 'ry="${1:0}"' },
                    { name: 'rz', detail: 'Z rotation', insertText: 'rz="${1:0}"' },
                    { name: 'sx', detail: 'X scale', insertText: 'sx="${1:1}"' },
                    { name: 'sy', detail: 'Y scale', insertText: 'sy="${1:1}"' },
                    { name: 'sz', detail: 'Z scale', insertText: 'sz="${1:1}"' },
                    
                    // Dimension attributes
                    { name: 'width', detail: 'Width', insertText: 'width="${1:1}"' },
                    { name: 'height', detail: 'Height', insertText: 'height="${1:1}"' },
                    { name: 'depth', detail: 'Depth', insertText: 'depth="${1:1}"' },
                    { name: 'radius', detail: 'Radius', insertText: 'radius="${1:1}"' },
                    
                    // Visual attributes
                    { name: 'color', detail: 'Color', insertText: 'color="${1:red}"' },
                    { name: 'visible', detail: 'Visibility', insertText: 'visible="${1:true}"' },
                    { name: 'opacity', detail: 'Opacity', insertText: 'opacity="${1:1}"' },
                    
                    // Source attributes
                    { name: 'src', detail: 'Source URL', insertText: 'src="${1:https://example.com/model.glb}"' },
                    { name: 'href', detail: 'Link URL', insertText: 'href="${1:https://example.com}"' },
                    
                    // Core attributes
                    { name: 'id', detail: 'Element ID', insertText: 'id="${1:my-element}"' },
                    { name: 'class', detail: 'CSS class', insertText: 'class="${1:my-class}"' },
                    
                    // Audio/Video attributes
                    { name: 'volume', detail: 'Volume (0-1)', insertText: 'volume="${1:1}"' },
                    { name: 'loop', detail: 'Loop playback', insertText: 'loop="${1:false}"' },
                    { name: 'autoplay', detail: 'Auto play', insertText: 'autoplay="${1:false}"' },
                    
                    // Light attributes
                    { name: 'type', detail: 'Light type', insertText: 'type="${1:point}"' },
                    { name: 'intensity', detail: 'Light intensity', insertText: 'intensity="${1:1}"' },
                    { name: 'distance', detail: 'Light distance', insertText: 'distance="${1:0}"' },
                    { name: 'angle', detail: 'Light angle', insertText: 'angle="${1:45}"' },
                    { name: 'enabled', detail: 'Enabled state', insertText: 'enabled="${1:true}"' },
                    { name: 'cast-shadow', detail: 'Cast shadows', insertText: 'cast-shadow="${1:true}"' },
                    { name: 'cast-shadows', detail: 'Cast shadows', insertText: 'cast-shadows="${1:true}"' },
                    
                    // Label/Text attributes
                    { name: 'content', detail: 'Text content', insertText: 'content="${1:Hello World}"' },
                    { name: 'font-size', detail: 'Font size', insertText: 'font-size="${1:24}"' },
                    { name: 'font-color', detail: 'Font color', insertText: 'font-color="${1:black}"' },
                    { name: 'alignment', detail: 'Text alignment', insertText: 'alignment="${1:left}"' },
                    { name: 'padding', detail: 'Text padding', insertText: 'padding="${1:8}"' },
                    { name: 'emissive', detail: 'Emissiveness', insertText: 'emissive="${1:0}"' },
                    
                    // Interaction attributes
                    { name: 'onclick', detail: 'Click handler', insertText: 'onclick="${1:console.log(\'clicked\')}"' },
                    { name: 'onprompt', detail: 'Prompt handler', insertText: 'onprompt="${1:console.log(event.detail.value)}"' },
                    { name: 'onchat', detail: 'Chat handler', insertText: 'onchat="${1:console.log(event.detail.message)}"' },
                    { name: 'oninteraction', detail: 'Interaction handler', insertText: 'oninteraction="${1:console.log(\'interaction\')}"' },
                    
                    // Prompt attributes
                    { name: 'message', detail: 'Prompt message', insertText: 'message="${1:Enter value:}"' },
                    { name: 'placeholder', detail: 'Input placeholder', insertText: 'placeholder="${1:Type here...}"' },
                    { name: 'prefill', detail: 'Pre-filled value', insertText: 'prefill="${1:default}"' },
                    
                    // Probe attributes
                    { name: 'range', detail: 'Detection range', insertText: 'range="${1:1}"' },
                    { name: 'interval', detail: 'Update interval', insertText: 'interval="${1:100}"' },
                    
                    // Animation attributes
                    { name: 'attr', detail: 'Attribute to animate', insertText: 'attr="${1:color}"' },
                    { name: 'start-time', detail: 'Animation start time', insertText: 'start-time="${1:0}"' },
                    { name: 'end-time', detail: 'Animation end time', insertText: 'end-time="${1:1000}"' },
                    { name: 'start-value', detail: 'Starting value', insertText: 'start-value="${1:red}"' },
                    { name: 'end-value', detail: 'Ending value', insertText: 'end-value="${1:blue}"' },
                    { name: 'duration', detail: 'Animation duration', insertText: 'duration="${1:1000}"' },
                    { name: 'easing', detail: 'Easing function', insertText: 'easing="${1:linear}"' },
                    { name: 'ping-pong', detail: 'Ping-pong animation', insertText: 'ping-pong="${1:false}"' },
                    { name: 'pause-time', detail: 'Pause time', insertText: 'pause-time="${1:0}"' },
                    
                    // Link attributes
                    { name: 'target', detail: 'Link target', insertText: 'target="${1:_blank}"' },
                    
                    // Advanced attributes
                    { name: 'socket', detail: 'Bone socket', insertText: 'socket="${1:hand_r}"' },
                    { name: 'debug', detail: 'Debug mode', insertText: 'debug="${1:false}"' },
                    
                    // Collision attributes
                    { name: 'collide', detail: 'Collision detection enabled', insertText: 'collide="${1:true}"' },
                    { name: 'collision-interval', detail: 'Collision event interval (ms)', insertText: 'collision-interval="${1:100}"' },
                    { name: 'oncollisionstart', detail: 'Collision start handler', insertText: 'oncollisionstart="${1:console.log(event)}"' },
                    { name: 'oncollisionmove', detail: 'Collision move handler', insertText: 'oncollisionmove="${1:console.log(event)}"' },
                    { name: 'oncollisionend', detail: 'Collision end handler', insertText: 'oncollisionend="${1:console.log(event)}"' }
                ];

                return attributeCompletions.map(attr => {
                    const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
                    item.detail = attr.detail;
                    item.insertText = new vscode.SnippetString(attr.insertText);
                    return item;
                });
            }
        },
        ' ', '='
    );

    // Register hover provider for MML elements with detailed parameter information
    const hoverProvider = vscode.languages.registerHoverProvider(MML_DOCUMENT_SELECTOR, {
        provideHover(document: vscode.TextDocument, position: vscode.Position) {
            const range = document.getWordRangeAtPosition(position, /<m-[a-z-]+/);
            if (!range) {
                return;
            }

            const word = document.getText(range);
            const elementInfo: { [key: string]: { description: string, params: Array<{ name: string, type: string, description: string, default?: string }> } } = {
                '<m-cube': {
                    description: 'Creates a 3D cube primitive with customizable dimensions and appearance',
                    params: [
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'width', type: 'number', description: 'Width of the cube', default: '1' },
                        { name: 'height', type: 'number', description: 'Height of the cube', default: '1' },
                        { name: 'depth', type: 'number', description: 'Depth of the cube', default: '1' },
                        { name: 'color', type: 'string', description: 'Color of the cube (CSS color format)', default: 'white' },
                        { name: 'opacity', type: 'number', description: 'Opacity (0-1)', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the cube is visible', default: 'true' },
                        { name: 'collide', type: 'boolean', description: 'Whether collision detection is enabled', default: 'true' },
                        { name: 'collision-interval', type: 'number', description: 'Time between collision events (ms)' },
                        { name: 'oncollisionstart', type: 'script', description: 'Script executed when collision starts' },
                        { name: 'oncollisionmove', type: 'script', description: 'Script executed when collision moves' },
                        { name: 'oncollisionend', type: 'script', description: 'Script executed when collision ends' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'cast-shadows', type: 'boolean', description: 'Whether element casts shadows', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-sphere': {
                    description: 'Creates a 3D sphere primitive with customizable radius and appearance',
                    params: [
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'radius', type: 'number', description: 'Radius of the sphere', default: '1' },
                        { name: 'color', type: 'string', description: 'Color of the sphere (CSS color format)', default: 'white' },
                        { name: 'opacity', type: 'number', description: 'Opacity (0-1)', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the sphere is visible', default: 'true' },
                        { name: 'collide', type: 'boolean', description: 'Whether collision detection is enabled', default: 'true' },
                        { name: 'collision-interval', type: 'number', description: 'Time between collision events (ms)' },
                        { name: 'oncollisionstart', type: 'script', description: 'Script executed when collision starts' },
                        { name: 'oncollisionmove', type: 'script', description: 'Script executed when collision moves' },
                        { name: 'oncollisionend', type: 'script', description: 'Script executed when collision ends' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'cast-shadows', type: 'boolean', description: 'Whether element casts shadows', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-cylinder': {
                    description: 'Creates a 3D cylinder primitive',
                    params: [
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'radius', type: 'number', description: 'Radius of the cylinder', default: '0.5' },
                        { name: 'height', type: 'number', description: 'Height of the cylinder' },
                        { name: 'color', type: 'string', description: 'Color of the cylinder (CSS color format)', default: 'white' },
                        { name: 'opacity', type: 'number', description: 'Opacity (0-1)', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the cylinder is visible', default: 'true' },
                        { name: 'collide', type: 'boolean', description: 'Whether collision detection is enabled', default: 'true' },
                        { name: 'collision-interval', type: 'number', description: 'Time between collision events (ms)' },
                        { name: 'oncollisionstart', type: 'script', description: 'Script executed when collision starts' },
                        { name: 'oncollisionmove', type: 'script', description: 'Script executed when collision moves' },
                        { name: 'oncollisionend', type: 'script', description: 'Script executed when collision ends' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'cast-shadows', type: 'boolean', description: 'Whether element casts shadows', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-plane': {
                    description: 'Creates a 3D plane primitive',
                    params: [
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'width', type: 'number', description: 'Width of the plane', default: '1' },
                        { name: 'height', type: 'number', description: 'Height of the plane', default: '1' },
                        { name: 'color', type: 'string', description: 'Color of the plane (CSS color format)', default: 'white' },
                        { name: 'opacity', type: 'number', description: 'Opacity (0-1)', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the plane is visible', default: 'true' },
                        { name: 'collide', type: 'boolean', description: 'Whether collision detection is enabled', default: 'true' },
                        { name: 'collision-interval', type: 'number', description: 'Time between collision events (ms)' },
                        { name: 'oncollisionstart', type: 'script', description: 'Script executed when collision starts' },
                        { name: 'oncollisionmove', type: 'script', description: 'Script executed when collision moves' },
                        { name: 'oncollisionend', type: 'script', description: 'Script executed when collision ends' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'cast-shadows', type: 'boolean', description: 'Whether element casts shadows', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-model': {
                    description: 'Loads and displays a 3D model from a URL (supports GLTF/GLB formats)',
                    params: [
                        { name: 'src', type: 'string', description: 'URL to the 3D model file (.glb, .gltf)' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the model is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'cast-shadows', type: 'boolean', description: 'Whether element casts shadows', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-character': {
                    description: 'Loads a character/avatar model for metaverse experiences',
                    params: [
                        { name: 'src', type: 'string', description: 'URL to the character model file (.glb, .gltf)' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the character is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'cast-shadows', type: 'boolean', description: 'Whether element casts shadows', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-light': {
                    description: 'Creates a light source to illuminate the 3D scene',
                    params: [
                        { name: 'type', type: 'enum', description: 'Type of light (point, spotlight)', default: 'point' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'color', type: 'string', description: 'Color of the light (CSS color format)', default: 'white' },
                        { name: 'intensity', type: 'number', description: 'Intensity/brightness of the light', default: '1' },
                        { name: 'distance', type: 'number', description: 'Maximum distance of light effect', default: '0' },
                        { name: 'angle', type: 'number', description: 'Angle of light cone (for spotlight)', default: '45' },
                        { name: 'enabled', type: 'boolean', description: 'Whether the light is enabled', default: 'true' },
                        { name: 'cast-shadow', type: 'boolean', description: 'Whether the light casts shadows', default: 'true' },
                        { name: 'visible', type: 'boolean', description: 'Whether the light is active', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-audio': {
                    description: 'Plays spatial audio in the 3D environment',
                    params: [
                        { name: 'src', type: 'string', description: 'URL to the audio file (.mp3, .wav, .ogg)' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'volume', type: 'number', description: 'Volume level (0-1)', default: '1' },
                        { name: 'loop', type: 'boolean', description: 'Whether to loop the audio', default: 'false' },
                        { name: 'autoplay', type: 'boolean', description: 'Whether to start playing automatically', default: 'false' },
                        { name: 'distance', type: 'number', description: 'Maximum distance for spatial audio', default: '10' },
                        { name: 'enabled', type: 'boolean', description: 'Whether the audio is enabled', default: 'true' },
                        { name: 'visible', type: 'boolean', description: 'Whether the audio source is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-video': {
                    description: 'Displays video content on a 3D plane',
                    params: [
                        { name: 'src', type: 'string', description: 'URL to the video file (.mp4, .webm)' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'width', type: 'number', description: 'Width of the video plane', default: '1' },
                        { name: 'height', type: 'number', description: 'Height of the video plane', default: '1' },
                        { name: 'volume', type: 'number', description: 'Volume level (0-1)', default: '1' },
                        { name: 'loop', type: 'boolean', description: 'Whether to loop the video', default: 'false' },
                        { name: 'autoplay', type: 'boolean', description: 'Whether to start playing automatically', default: 'false' },
                        { name: 'visible', type: 'boolean', description: 'Whether the video is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'cast-shadows', type: 'boolean', description: 'Whether element casts shadows', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-image': {
                    description: 'Displays image content on a 3D plane',
                    params: [
                        { name: 'src', type: 'string', description: 'URL to the image file (.jpg, .png, .gif)' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'width', type: 'number', description: 'Width of the image plane', default: '1' },
                        { name: 'height', type: 'number', description: 'Height of the image plane', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the image is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'cast-shadows', type: 'boolean', description: 'Whether element casts shadows', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-label': {
                    description: 'Displays text on a plane in a 3D scene',
                    params: [
                        { name: 'content', type: 'string', description: 'The text content to be displayed on the label' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'width', type: 'number', description: 'Width of the label in meters', default: '1' },
                        { name: 'height', type: 'number', description: 'Height of the label in meters', default: '1' },
                        { name: 'font-size', type: 'number', description: 'Font size in centimeters', default: '24' },
                        { name: 'font-color', type: 'string', description: 'Color of the text', default: 'black' },
                        { name: 'color', type: 'string', description: 'Background color of the label', default: 'white' },
                        { name: 'padding', type: 'number', description: 'Padding around text in centimeters', default: '8' },
                        { name: 'alignment', type: 'enum', description: 'Text alignment (left, center, right)', default: 'left' },
                        { name: 'emissive', type: 'number', description: 'Emissiveness strength', default: '0' },
                        { name: 'visible', type: 'boolean', description: 'Whether the label is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'cast-shadows', type: 'boolean', description: 'Whether element casts shadows', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-group': {
                    description: 'Groups multiple MML elements together for organization and transformation',
                    params: [
                        { name: 'x', type: 'number', description: 'X position in 3D space (affects all children)', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space (affects all children)', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space (affects all children)', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees, affects all children)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees, affects all children)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees, affects all children)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis (affects all children)', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis (affects all children)', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis (affects all children)', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the group and its children are visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'onclick', type: 'script', description: 'Script executed when clicked' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-frame': {
                    description: 'Enables composing other MML documents and transforming them as a unit',
                    params: [
                        { name: 'src', type: 'string', description: 'URL to the MML document to embed' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the frame is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-position-probe': {
                    description: 'Requests the position of a user (camera or avatar) when they enter a range',
                    params: [
                        { name: 'range', type: 'number', description: 'Detection range in meters', default: '1' },
                        { name: 'interval', type: 'number', description: 'Update interval in milliseconds', default: '100' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the probe is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-prompt': {
                    description: 'Requests a string from the user when clicked in a 3D scene',
                    params: [
                        { name: 'message', type: 'string', description: 'Message text displayed to the user' },
                        { name: 'placeholder', type: 'string', description: 'Hint text in the input field' },
                        { name: 'prefill', type: 'string', description: 'Default text pre-populated in input' },
                        { name: 'onprompt', type: 'script', description: 'Script executed when user submits input' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the prompt trigger is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-link': {
                    description: 'Opens a web address when clicked in a 3D scene (has no visual representation)',
                    params: [
                        { name: 'href', type: 'string', description: 'URL to open when clicked' },
                        { name: 'target', type: 'string', description: 'Target window (_blank, _self)', default: '_blank' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the link area is active', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-interaction': {
                    description: 'Describes an action that a user can take at a point in 3D space',
                    params: [
                        { name: 'type', type: 'enum', description: 'Type of interaction (click, proximity)', default: 'click' },
                        { name: 'range', type: 'number', description: 'Interaction range in meters', default: '1' },
                        { name: 'oninteraction', type: 'script', description: 'Script executed when interaction occurs' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the interaction area is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-chat-probe': {
                    description: 'Receives messages from a chat system when users are within range',
                    params: [
                        { name: 'range', type: 'number', description: 'Range in meters for receiving chat messages', default: '1' },
                        { name: 'onchat', type: 'script', description: 'Script executed when chat message is received' },
                        { name: 'x', type: 'number', description: 'X position in 3D space', default: '0' },
                        { name: 'y', type: 'number', description: 'Y position in 3D space', default: '0' },
                        { name: 'z', type: 'number', description: 'Z position in 3D space', default: '0' },
                        { name: 'rx', type: 'number', description: 'Rotation around X axis (degrees)', default: '0' },
                        { name: 'ry', type: 'number', description: 'Rotation around Y axis (degrees)', default: '0' },
                        { name: 'rz', type: 'number', description: 'Rotation around Z axis (degrees)', default: '0' },
                        { name: 'sx', type: 'number', description: 'Scale factor on X axis', default: '1' },
                        { name: 'sy', type: 'number', description: 'Scale factor on Y axis', default: '1' },
                        { name: 'sz', type: 'number', description: 'Scale factor on Z axis', default: '1' },
                        { name: 'visible', type: 'boolean', description: 'Whether the probe is visible', default: 'true' },
                        { name: 'socket', type: 'string', description: 'Bone name for skeletal attachment' },
                        { name: 'debug', type: 'boolean', description: 'Show debug information', default: 'false' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-attr-anim': {
                    description: 'Describes document time-synchronized changes to element attributes',
                    params: [
                        { name: 'attr', type: 'string', description: 'Name of the attribute to animate' },
                        { name: 'start-time', type: 'number', description: 'Start time of animation in milliseconds', default: '0' },
                        { name: 'end-time', type: 'number', description: 'End time of animation in milliseconds' },
                        { name: 'start-value', type: 'string', description: 'Starting value of the attribute' },
                        { name: 'end-value', type: 'string', description: 'Ending value of the attribute' },
                        { name: 'easing', type: 'enum', description: 'Easing function (linear, ease-in, ease-out)', default: 'linear' },
                        { name: 'loop', type: 'boolean', description: 'Whether to loop the animation', default: 'false' },
                        { name: 'ping-pong', type: 'boolean', description: 'Whether to reverse on each loop', default: 'false' },
                        { name: 'pause-time', type: 'number', description: 'Time to pause at end before looping', default: '0' },
                        { name: 'enabled', type: 'boolean', description: 'Whether the animation is enabled', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                },
                '<m-attr-lerp': {
                    description: 'Describes time-transitioned changes to element attributes',
                    params: [
                        { name: 'attr', type: 'string', description: 'Name of the attribute to interpolate' },
                        { name: 'value', type: 'string', description: 'Target value to interpolate to' },
                        { name: 'duration', type: 'number', description: 'Duration of interpolation in milliseconds', default: '1000' },
                        { name: 'easing', type: 'enum', description: 'Easing function (linear, ease-in, ease-out)', default: 'ease-out' },
                        { name: 'start-time', type: 'number', description: 'When to start the interpolation', default: '0' },
                        { name: 'enabled', type: 'boolean', description: 'Whether the interpolation is enabled', default: 'true' },
                        { name: 'id', type: 'string', description: 'Unique identifier for the element' },
                        { name: 'class', type: 'string', description: 'CSS class names for styling' }
                    ]
                }
            };

            const info = elementInfo[word];
            if (info) {
                const elementName = word.substring(1); // Remove '<' prefix
                const markdown = new vscode.MarkdownString();
                markdown.isTrusted = true;
                
                // Element title and description
                markdown.appendMarkdown(`**${elementName}**\n\n${info.description}\n\n`);
                
                // Parameters table
                markdown.appendMarkdown(`### Parameters\n\n`);
                markdown.appendMarkdown(`| Parameter | Type | Description | Default |\n`);
                markdown.appendMarkdown(`|-----------|------|-------------|----------|\n`);
                
                for (const param of info.params) {
                    const defaultValue = param.default ? `\`${param.default}\`` : '-';
                    markdown.appendMarkdown(`| \`${param.name}\` | \`${param.type}\` | ${param.description} | ${defaultValue} |\n`);
                }
                
                // Usage example
                const exampleParams = info.params.slice(0, 3).map(p => {
                    const value = p.default || (p.type === 'string' ? '"example"' : '1');
                    return `${p.name}="${value}"`;
                }).join(' ');
                
                markdown.appendMarkdown(`\n### Example\n\`\`\`html\n<${elementName} ${exampleParams}></${elementName}>\n\`\`\``);
                
                return new vscode.Hover(markdown);
            }
        }
    });

    // Add all subscriptions to the context
    context.subscriptions.push(
        validateMMLCommand,
        onDidOpenTextDocument,
        onDidChangeTextDocument,
        onDidCloseTextDocument,
        completionProvider,
        hoverProvider,
        openPreviewCommand
    );
}

export function deactivate() {
    validationTimeouts.forEach((timeout) => {
        clearTimeout(timeout);
    });
    validationTimeouts.clear();
} 
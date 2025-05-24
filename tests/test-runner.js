const fs = require('fs');
const path = require('path');

// Mock VSCode API for testing
const mockVscode = {
    Position: class {
        constructor(line, character) {
            this.line = line;
            this.character = character;
        }
        translate(lineDelta, characterDelta) {
            return new mockVscode.Position(this.line + lineDelta, this.character + characterDelta);
        }
    },
    Range: class {
        constructor(start, end) {
            this.start = start;
            this.end = end;
        }
    },
    Diagnostic: class {
        constructor(range, message, severity) {
            this.range = range;
            this.message = message;
            this.severity = severity;
        }
    },
    DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3
    }
};

// MML validation function (replicated from extension.ts)
function validateMMLDocument(content) {
    const diagnostics = [];
    
    // Check for proper tag opening/closing
    const tagStack = [];
    const allTagMatches = [];
    const lines = content.split('\n');
    
    // First pass: find all closing tags (they're unambiguous)
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        
        const closingTagRegex = /<\/m-([a-z-]+)>/g;
        let match;
        
        while ((match = closingTagRegex.exec(line)) !== null) {
            const tagName = match[1];
            const position = new mockVscode.Position(lineIndex, match.index);
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
    
    while (currentPos < content.length) {
        openingTagRegex.lastIndex = currentPos;
        const match = openingTagRegex.exec(content);
        if (!match) break;
        
        const tagName = match[1];
        const matchStart = match.index;
        
        // Convert absolute position to line/character
        const beforeMatch = content.substring(0, matchStart);
        const lineBreaks = beforeMatch.split('\n');
        const lineIndex = lineBreaks.length - 1;
        const charIndex = lineBreaks[lineBreaks.length - 1].length;
        const position = new mockVscode.Position(lineIndex, charIndex);
        
        // Now find the end of this tag (the closing >)
        let searchPos = matchStart + match[0].length;
        let depth = 1; // We're inside a tag
        let isSelfClosing = false;
        let foundEnd = false;
        
        while (searchPos < content.length && depth > 0) {
            const char = content[searchPos];
            
            if (char === '<') {
                depth++;
            } else if (char === '>') {
                depth--;
                if (depth === 0) {
                    // Check if this is self-closing by looking at the character before >
                    if (searchPos > 0 && content[searchPos - 1] === '/') {
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
                const diagnostic = new mockVscode.Diagnostic(
                    new mockVscode.Range(tagMatch.position, tagMatch.position.translate(0, tagMatch.fullMatch.length)),
                    `Closing tag </${tagMatch.tag}> has no matching opening tag`,
                    mockVscode.DiagnosticSeverity.Error
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
        const position = new mockVscode.Position(unclosedTag.line, unclosedTag.character);
        const diagnostic = new mockVscode.Diagnostic(
            new mockVscode.Range(position, position.translate(0, unclosedTag.tag.length + 1)),
            `Opening tag <${unclosedTag.tag}> is not properly closed`,
            mockVscode.DiagnosticSeverity.Error
        );
        diagnostics.push(diagnostic);
    }
    
    return diagnostics;
}

// Test configuration
const testCases = [
    {
        name: 'test-multiline.mml',
        description: 'Multiline MML tags should validate without errors',
        expectedErrors: 0
    },
    {
        name: 'test-comprehensive.mml', 
        description: 'Comprehensive test with various MML element types',
        expectedErrors: 0
    },
    {
        name: 'test-sphere.mml',
        description: 'Simple sphere test',
        expectedErrors: 0
    },
    {
        name: 'test-validation.mml',
        description: 'Validation test with intentional errors',
        expectedErrors: 2 // This file has intentional errors
    },
    {
        name: 'test-errors.mml',
        description: 'Error test file with intentional validation errors',
        expectedErrors: 5 // This file has 5 intentional errors
    }
];

// Run tests
console.log('🧪 Running MML Validation Tests\n');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

for (const testCase of testCases) {
    totalTests++;
    const filePath = path.join(__dirname, testCase.name);
    
    if (!fs.existsSync(filePath)) {
        console.log(`❌ FAIL: ${testCase.name} - File not found`);
        failedTests++;
        continue;
    }
    
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const diagnostics = validateMMLDocument(content);
        const errorCount = diagnostics.filter(d => d.severity === mockVscode.DiagnosticSeverity.Error).length;
        
        if (errorCount === testCase.expectedErrors) {
            console.log(`✅ PASS: ${testCase.name} - ${testCase.description}`);
            console.log(`   Expected ${testCase.expectedErrors} error(s), found ${errorCount}`);
            passedTests++;
        } else {
            console.log(`❌ FAIL: ${testCase.name} - ${testCase.description}`);
            console.log(`   Expected ${testCase.expectedErrors} error(s), but found ${errorCount}`);
            
            if (diagnostics.length > 0) {
                console.log('   Validation errors found:');
                diagnostics.forEach((diagnostic, index) => {
                    console.log(`     ${index + 1}. Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`);
                });
            }
            failedTests++;
        }
        
    } catch (error) {
        console.log(`❌ FAIL: ${testCase.name} - Error reading/validating file: ${error.message}`);
        failedTests++;
    }
    
    console.log(); // Empty line for readability
}

// Summary
console.log('📊 Test Summary');
console.log('================');
console.log(`Total tests: ${totalTests}`);
console.log(`Passed: ${passedTests}`);
console.log(`Failed: ${failedTests}`);
console.log(`Success rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

if (failedTests > 0) {
    console.log('\n❌ Some tests failed!');
    process.exit(1);
} else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
} 
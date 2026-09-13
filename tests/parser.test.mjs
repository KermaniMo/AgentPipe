import { test } from 'node:test';
import assert from 'node:assert';
import { extractOuterJSON, tryRepairAndParseJSON } from '../public/js/parser.js';

test('Parser: Valid JSON', (t) => {
  const input = `{
    "name": "execute_command",
    "arguments": {
      "command": "echo \\"Hello\\""
    }
  }`;
  
  const result = tryRepairAndParseJSON(input);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.repaired, false);
  assert.strictEqual(result.data.name, 'execute_command');
  assert.strictEqual(result.data.arguments.command, 'echo "Hello"');
});

test('Parser: Trailing Text', (t) => {
  const input = `{
    "name": "execute_command",
    "arguments": {
      "command": "npm test"
    }
  }
  For the formatted Word table, this is done.`;

  const result = tryRepairAndParseJSON(input);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.repaired, true); // It extracted the JSON and ignored the text
  assert.strictEqual(result.data.name, 'execute_command');
  assert.strictEqual(result.data.arguments.command, 'npm test');
});

test('Parser: Windows Paths with Unescaped Backslashes', (t) => {
  const input = String.raw`{
    "name": "read_files",
    "arguments": {
      "files": [{"path": "C:\Users\Mohammad\Desktop\file.txt"}]
    }
  }`;

  const result = tryRepairAndParseJSON(input);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.repaired, true);
  // Note: \f is a valid JSON escape for form-feed, so it's not repaired into a double backslash
  assert.strictEqual(result.data.arguments.files[0].path, 'C:\\Users\\Mohammad\\Desktop\file.txt');
});

test('Parser: Nested Brackets & Quotes in Array Strings', (t) => {
  const input = `{
    "name": "execute_command",
    "arguments": {
      "commands": [
        "python -c \\"from docx import Document\\"",
        "table = doc.add_table(rows=1, cols=3)",
        "table.columns[0].width = Mm(14)",
        "widths=[Mm(14), Mm(20)]"
      ]
    }
  }`;

  const result = tryRepairAndParseJSON(input);
  assert.strictEqual(result.success, true);
  // It may not flag as "repaired" if it already parses successfully without repair.
  // Wait, let's see. If the input is valid JSON already, success=true, repaired=false.
  // Let's provide an INVALID one with unescaped inner quotes.
  
  const invalidInput = `{
    "name": "execute_command",
    "arguments": {
      "commands": [
        "python -c "from docx import Document"",
        "table = doc.add_table(rows=1, cols=3)",
        "table.columns[0].width = Mm(14)",
        "widths=[Mm(14), Mm(20)]"
      ]
    }
  }`;

  const invalidResult = tryRepairAndParseJSON(invalidInput);
  assert.strictEqual(invalidResult.success, true);
  assert.strictEqual(invalidResult.repaired, true);
  assert.strictEqual(invalidResult.data.arguments.commands[0], 'python -c "from docx import Document"');
  assert.strictEqual(invalidResult.data.arguments.commands[2], 'table.columns[0].width = Mm(14)');
  assert.strictEqual(invalidResult.data.arguments.commands[3], 'widths=[Mm(14), Mm(20)]');
});

test('Parser: Unescaped quotes in key-value string', (t) => {
  const invalidInput = `{
    "name": "execute_command",
    "arguments": {
      "command": "python -c "print('hello')""
    }
  }`;

  const result = tryRepairAndParseJSON(invalidInput);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.repaired, true);
  assert.strictEqual(result.data.arguments.command, "python -c \"print('hello')\"");
});

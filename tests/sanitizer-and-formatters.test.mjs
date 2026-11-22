import { test } from 'node:test';
import assert from 'node:assert';
import { sanitizeResponseInput } from '../public/js/sanitizer.js';
import {
  formatCompactPrompt,
  formatFullPrompt,
  formatForWebChat,
  getLatestUserMessage,
  getToolOutput
} from '../public/js/formatters.js';
import { CRITICAL_SYSTEM_DIRECTIVE } from '../public/js/constants.js';

test('Sanitizer: plain text response', () => {
  const result = sanitizeResponseInput('Just a normal answer to a question.');
  assert.strictEqual(result.mode, 'text');
  assert.strictEqual(result.payload, 'Just a normal answer to a question.');
});

test('Sanitizer: strips reasoning blocks <think> and <thought>', () => {
  const input = `<think>Let me ponder this for a while...</think>
{"name": "run_command", "arguments": {"cmd": "ls"}}`;
  const result = sanitizeResponseInput(input);
  assert.strictEqual(result.mode, 'tool');
  assert.strictEqual(result.toolName, 'run_command');
  const parsed = JSON.parse(result.payload);
  assert.strictEqual(parsed.tool_calls[0].function.name, 'run_command');
});

test('Sanitizer: markdown code block with JSON', () => {
  const input = `Here is your tool call:
\`\`\`json
{
  "name": "execute_command",
  "arguments": {
    "command": "dir"
  }
}
\`\`\``;
  const result = sanitizeResponseInput(input);
  assert.strictEqual(result.mode, 'tool');
  assert.strictEqual(result.toolName, 'execute_command');
  const parsed = JSON.parse(result.payload);
  assert.strictEqual(parsed.tool_calls[0].function.name, 'execute_command');
});

test('Sanitizer: shorthand commands array', () => {
  const input = `{"commands": ["echo 1", "echo 2"]}`;
  const result = sanitizeResponseInput(input);
  assert.strictEqual(result.mode, 'tool');
  assert.strictEqual(result.toolName, 'execute_command');
  const parsed = JSON.parse(result.payload);
  const args = JSON.parse(parsed.tool_calls[0].function.arguments);
  assert.deepStrictEqual(args.commands, ["echo 1", "echo 2"]);
});

test('Sanitizer: detects malformed JSON attempt', () => {
  const input = `{"name": "execute_command", "arguments": { broken json syntax `;
  const result = sanitizeResponseInput(input);
  assert.strictEqual(result.mode, 'malformed');
  assert.ok(result.error);
});

test('Sanitizer: conversational text with non-JSON code blocks (python, bash) stays in text mode', () => {
  const input = `Here is an explanation of TDD:
\`\`\`python
def test_add():
    assert add(2, 3) == 5
\`\`\`
And you can run it using:
\`\`\`bash
pytest
\`\`\`
Hope this helps!`;
  const result = sanitizeResponseInput(input);
  assert.strictEqual(result.mode, 'text');
  assert.strictEqual(result.payload, input);
});

test('Sanitizer: multilingual text with python code blocks stays in text mode', () => {
  const input = `## TDD چیست؟
توسعه تستمحور:
\`\`\`python
def add(a, b):
    return a + b
\`\`\`
تست را دوباره اجرا کن.`;
  const result = sanitizeResponseInput(input);
  assert.strictEqual(result.mode, 'text');
  assert.strictEqual(result.payload, input);
});

test('Sanitizer: mixed response with python snippet and json tool call extracts tool call', () => {
  const input = `Here is how the python function looks:
\`\`\`python
def test_foo(): pass
\`\`\`
Now let me execute it for you:
\`\`\`json
{
  "name": "execute_command",
  "arguments": {
    "command": "python test.py"
  }
}
\`\`\``;
  const result = sanitizeResponseInput(input);
  assert.strictEqual(result.mode, 'tool');
  assert.strictEqual(result.toolName, 'execute_command');
  const parsed = JSON.parse(result.payload);
  assert.strictEqual(parsed.tool_calls[0].function.name, 'execute_command');
});

test('Formatters: getLatestUserMessage', () => {
  const messages = [
    { role: 'system', content: 'You are helpful' },
    { role: 'user', content: 'First user prompt' },
    { role: 'assistant', content: 'Hello' },
    { role: 'user', content: 'Second user prompt' },
    { role: 'tool', content: 'command output' }
  ];
  assert.strictEqual(getLatestUserMessage(messages), 'Second user prompt');
});

test('Formatters: formatCompactPrompt with tool output', () => {
  const req = {
    messages: [
      { role: 'user', content: 'Run test' },
      { role: 'tool', tool_call_id: 'call_123', content: 'Passed 5 tests' }
    ]
  };
  const formatted = formatCompactPrompt(req);
  assert.ok(formatted.includes('Tool execution output for call_123:'));
  assert.ok(formatted.includes('Passed 5 tests'));
  assert.ok(formatted.includes(CRITICAL_SYSTEM_DIRECTIVE));
});

test('Formatters: formatFullPrompt with tools and history', () => {
  const req = {
    tools: [{ type: 'function', function: { name: 'read_files' } }],
    messages: [
      { role: 'user', content: 'What is this file?' },
      { role: 'tool', tool_call_id: 'call_999', content: 'file content here' }
    ]
  };
  const formatted = formatFullPrompt(req);
  assert.ok(formatted.includes('AVAILABLE TOOLS:'));
  assert.ok(formatted.includes('read_files'));
  assert.ok(formatted.includes('LATEST TERMINAL / TOOL OUTPUT:'));
  assert.ok(formatted.includes('file content here'));
  assert.ok(formatted.includes('CONVERSATION HISTORY:'));
});

import { extractOuterJSON, tryRepairAndParseJSON } from './parser.js';
import { validationBadge, validationText, responseInput } from './dom.js';

/**
 * Intelligent JSON & Markdown Extraction and Normalization
 * Handles:
 * - Stripping conversational wrapper text
 * - Removing markdown code block wrappers (```json, ```xml, etc.)
 * - Removing <thought>...</thought> and <think>...</think> blocks
 * - Extracting outermost valid JSON object/array
 * - Resilient auto-repair of malformed quotes and chatbot syntax errors
 * - Normalizing shorthand tool calls to standard OpenAI tool_calls schema
 * - Validating broken/malformed JSON attempts
 */
export function sanitizeResponseInput(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      mode: 'text',
      payload: '',
      repaired: false
    };
  }

  // 1. Strip reasoning blocks (<think>...</think> and <thought>...</thought>)
  let cleaned = rawText
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<thought[\s\S]*?<\/thought>/gi, '')
    .trim();

  // Helper to find balanced JSON object {...} or array [...]
  function findBalancedJson(str) {
    let startIndex = -1;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '{' || str[i] === '[') {
        startIndex = i;
        break;
      }
    }
    if (startIndex === -1) return null;

    const opener = str[startIndex];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < str.length; i++) {
      const c = str[i];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (c === '\\' && inString) {
        escapeNext = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (c === opener || c === '{' || c === '[') {
          depth++;
        } else if (c === closer || c === '}' || c === ']') {
          depth--;
          if (depth === 0) {
            return str.substring(startIndex, i + 1);
          }
        }
      }
    }
    return null; // Unbalanced
  }

  // 2. Scan markdown code blocks for candidate JSON / tool calls
  const jsonCompatibleLangs = new Set(['json', 'jsonc', 'json5', 'javascript', 'js']);
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let codeBlockMatch;
  let candidateJson = null;
  let codeBlockContent = null;
  let hasExplicitJsonCodeBlock = false;

  while ((codeBlockMatch = codeBlockRegex.exec(cleaned)) !== null) {
    const lang = codeBlockMatch[1].toLowerCase().trim();
    const content = codeBlockMatch[2].trim();

    if (jsonCompatibleLangs.has(lang)) {
      hasExplicitJsonCodeBlock = true;
      codeBlockContent = content;
      candidateJson = extractOuterJSON(content) || findBalancedJson(content) || content;
      break;
    } else if (lang === '') {
      // Bare code block: only candidate if it contains a JSON object or array structure
      const extracted = extractOuterJSON(content) || findBalancedJson(content);
      if (extracted) {
        codeBlockContent = content;
        candidateJson = extracted;
        break;
      }
    }
  }

  // 3. If no candidate from code blocks, try extracting from cleaned text (ignoring non-JSON code blocks)
  if (!candidateJson) {
    const textWithoutNonJsonBlocks = cleaned.replace(/```([a-zA-Z0-9_-]+)[ \t]*\r?\n?([\s\S]*?)```/g, (m, lang) => {
      return jsonCompatibleLangs.has(lang.toLowerCase().trim()) ? m : '';
    }).trim();

    if (textWithoutNonJsonBlocks.startsWith('{') || textWithoutNonJsonBlocks.startsWith('[')) {
      candidateJson = extractOuterJSON(textWithoutNonJsonBlocks) || findBalancedJson(textWithoutNonJsonBlocks) || textWithoutNonJsonBlocks;
    } else {
      const balanced = findBalancedJson(textWithoutNonJsonBlocks);
      if (balanced) {
        candidateJson = balanced;
      } else {
        const firstBrace = textWithoutNonJsonBlocks.search(/[{\[]/);
        const lastBrace = Math.max(textWithoutNonJsonBlocks.lastIndexOf('}'), textWithoutNonJsonBlocks.lastIndexOf(']'));
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          candidateJson = textWithoutNonJsonBlocks.slice(firstBrace, lastBrace + 1);
        }
      }
    }
  }

  // Primary and secondary auto-repair parsing using tryRepairAndParseJSON
  let parseResult = candidateJson ? tryRepairAndParseJSON(candidateJson) : null;

  // If candidate failed, also try running tryRepairAndParseJSON on codeBlockContent if it contained JSON markers
  if ((!parseResult || !parseResult.success) && codeBlockContent && candidateJson !== codeBlockContent) {
    if (codeBlockContent.includes('{') || codeBlockContent.includes('[')) {
      const cbResult = tryRepairAndParseJSON(codeBlockContent);
      if (cbResult.success) {
        parseResult = cbResult;
      }
    }
  }

  let parsedJson = (parseResult && parseResult.success) ? parseResult.data : null;
  const isRepaired = Boolean(parseResult?.repaired);
  const repairReason = parseResult?.repairReason || '';

  // Check if text (excluding non-JSON code blocks) strongly appears to be intended as a JSON tool call
  const textForIntentCheck = cleaned.replace(/```([a-zA-Z0-9_-]+)[ \t]*\r?\n?([\s\S]*?)```/g, (m, lang) => {
    return jsonCompatibleLangs.has(lang.toLowerCase().trim()) ? m : '';
  }).trim();

  const hasToolKeywords = textForIntentCheck.includes('{') && (
    textForIntentCheck.includes('"name"') ||
    textForIntentCheck.includes('"arguments"') ||
    textForIntentCheck.includes('"tool_calls"') ||
    textForIntentCheck.includes('"function"') ||
    textForIntentCheck.includes('"command"') ||
    textForIntentCheck.includes('"commands"')
  );

  const looksLikeJson =
    hasExplicitJsonCodeBlock ||
    (textForIntentCheck.startsWith('{') && (hasToolKeywords || textForIntentCheck.includes(':'))) ||
    (textForIntentCheck.startsWith('[') && textForIntentCheck.includes('{')) ||
    hasToolKeywords;

  if (!parsedJson && looksLikeJson) {
    const errMsg = parseResult?.error || 'Syntax error in JSON';
    return {
      mode: 'malformed',
      error: errMsg,
      payload: cleaned,
      repaired: false
    };
  }

  // If valid JSON was detected and parsed
  if (parsedJson && typeof parsedJson === 'object') {
    let toolCalls = [];

    // Format A: Standard tool_calls object
    if (Array.isArray(parsedJson.tool_calls) && parsedJson.tool_calls.length > 0) {
      toolCalls = parsedJson.tool_calls;
    } else if (parsedJson.tool_calls && typeof parsedJson.tool_calls === 'object') {
      toolCalls = [parsedJson.tool_calls];
    } else if (parsedJson.name && (parsedJson.arguments !== undefined || parsedJson.parameters !== undefined)) {
      // Format B: Shorthand { name: '...', arguments: {...} }
      toolCalls = [parsedJson];
    } else if (parsedJson.function && parsedJson.function.name) {
      // Format C: { function: { name: '...', arguments: {...} } }
      toolCalls = [parsedJson];
    } else if (Array.isArray(parsedJson) && parsedJson.length > 0 && (parsedJson[0].name || parsedJson[0].function)) {
      // Format D: Array of tool calls
      toolCalls = parsedJson;
    } else if (Array.isArray(parsedJson.commands) && parsedJson.commands.length > 0) {
      // Format E: { commands: ["..."] } shorthand
      toolCalls = [{
        name: 'execute_command',
        arguments: { commands: parsedJson.commands }
      }];
    }

    if (toolCalls.length > 0) {
      // Normalize into standard OpenAI tool_calls structure
      const timestamp = Date.now();
      const normalizedToolCalls = toolCalls.map((tc, idx) => {
        const id = tc.id || `call_${timestamp}_${idx}`;
        const name = tc.function?.name || tc.name || 'custom_tool';
        const rawArgs = tc.function?.arguments !== undefined
          ? tc.function.arguments
          : (tc.arguments !== undefined ? tc.arguments : (tc.parameters !== undefined ? tc.parameters : {}));
        const argumentsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);

        return {
          id,
          type: 'function',
          function: {
            name,
            arguments: argumentsStr
          }
        };
      });

      const normalizedPayload = {
        tool_calls: normalizedToolCalls
      };

      const toolNames = normalizedToolCalls.map(tc => tc.function.name).join(', ');

      return {
        mode: 'tool',
        toolName: toolNames,
        payload: JSON.stringify(normalizedPayload, null, 2),
        repaired: isRepaired,
        repairReason: repairReason
      };
    }
  }

  // Plain natural text mode
  let textPayload = cleaned;
  if (textPayload.startsWith('```') && textPayload.endsWith('```')) {
    textPayload = textPayload.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim();
  }

  return {
    mode: 'text',
    payload: textPayload,
    repaired: false
  };
}

/**
 * Live validation badge updater
 * Shows:
 * - 🟢 Tool Call Detected: [name] (standard parse)
 * - 🟡 Auto-Repaired Tool Call: [name] (with subtle sanitized badge)
 * - 🔴 Malformed JSON: [syntax error hint] (unrecoverable)
 * - 🔵 Text Response Mode (plain text)
 */
export function updateValidationIndicator() {
  if (!validationBadge || !validationText) return;

  const rawText = responseInput.value.trim();
  const existingPill = validationBadge.querySelector('.sanitized-pill');
  if (existingPill) existingPill.remove();

  if (!rawText) {
    validationBadge.className = 'validation-badge text-mode';
    validationText.textContent = 'Text Response Mode';
    return;
  }

  const analysis = sanitizeResponseInput(rawText);

  if (analysis.mode === 'tool') {
    if (analysis.repaired) {
      validationBadge.className = 'validation-badge repaired-mode';
      validationText.textContent = `Auto-Repaired Tool Call: ${analysis.toolName}`;

      const pill = document.createElement('span');
      pill.className = 'sanitized-pill';
      pill.title = analysis.repairReason || 'Inner quotes and syntax sanitized';
      pill.textContent = 'Quotes Sanitized';
      validationBadge.appendChild(pill);
    } else {
      validationBadge.className = 'validation-badge tool-mode';
      validationText.textContent = `Tool Call Detected: ${analysis.toolName}`;
    }
  } else if (analysis.mode === 'malformed') {
    validationBadge.className = 'validation-badge malformed-mode';
    const shortErr = analysis.error && analysis.error.length > 35
      ? analysis.error.slice(0, 32) + '...'
      : (analysis.error || 'Syntax Error');
    validationText.textContent = `Malformed JSON: ${shortErr}`;
  } else {
    validationBadge.className = 'validation-badge text-mode';
    validationText.textContent = 'Text Response Mode';
  }
}

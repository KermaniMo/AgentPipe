// State
let pendingRequests = [];
let selectedRequestId = null;
let toastTimer = null;

// System Prompt Constant for New Web Chat
const SYSTEM_PROMPT = `You are acting EXCLUSIVELY as the autonomous backend execution engine for an AI coding agent.
I will forward environment context, user instructions, file states, and tool execution outputs to you step-by-step.

### YOUR BEHAVIOR CONTRACT:
1. NEVER write any conversational intro or outro (No "Sure", "I will do that", "Here is the command", "Let me check").
2. NEVER wrap JSON in markdown code blocks like \`\`\`json ... \`\`\`. Start directly with the character { on line 1.
3. If an action requires using a tool, output ONLY a single valid JSON object matching this exact schema:
{
  "name": "exact_tool_name_from_context",
  "arguments": {
    "key": "value"
  }
}
4. CRITICAL JSON ESCAPING: Any inner double quotes inside shell commands, PowerShell scripts, or file paths MUST be escaped with a backslash (\\") or replaced with single quotes (') to guarantee valid JSON syntax.
   - WRONG: "commands": ["for %F in ("file.docx") ..."]
   - CORRECT: "commands": ["for %F in ('file.docx') ..."]
   - CORRECT: "commands": ["for %F in (\\"file.docx\\") ..."]
5. If the entire task is 100% finished, or if you only need to answer a conceptual question with no tool required, reply in clean, direct plain text (NO JSON).

### FEW-SHOT EXAMPLES:

User Input: Task: Inspect package.json
Your Output:
{"name": "read_files", "arguments": {"files": [{"path": "package.json"}]}}

User Input: Task: Check word document size in Windows terminal
Your Output:
{"name": "run_commands", "arguments": {"commands": ["for %F in ('doc.docx') do @echo %~zF"]}}

User Input: Tool output for run_commands: 25400 bytes
Your Output:
The document file size is 25,400 bytes. Inspection is complete.

Acknowledge this contract by replying with ONLY the word: READY`;

const BASE_URL = 'http://localhost:4747/v1';

// DOM Elements
const pendingList = document.getElementById('pending-list');
const emptyState = document.getElementById('empty-state');
const pendingCount = document.getElementById('pending-count');
const serverStatus = document.getElementById('server-status');
const pulseIndicator = document.getElementById('pulse-indicator');
const selectedReqDisplay = document.getElementById('selected-req-display');
const selectedReqMeta = document.getElementById('selected-req-meta');
const cancelActiveBtn = document.getElementById('cancel-active-btn');
const responseInput = document.getElementById('response-input');
const sendBtn = document.getElementById('send-btn');
const dispatchStatus = document.getElementById('dispatch-status');
const refreshBtn = document.getElementById('refresh-btn');
const validationBadge = document.getElementById('validation-badge');
const validationText = document.getElementById('validation-text');

// Quick Connection Bar Controls
const copyBaseUrlBtn = document.getElementById('copy-base-url-btn');
const baseUrlBadge = document.getElementById('base-url-badge');
const copySystemPromptBtn = document.getElementById('copy-system-prompt-btn');

// Prompt Formatter Controls
const btnCopyCompact = document.getElementById('btn-copy-compact');
const btnCopyFull = document.getElementById('btn-copy-full');
const promptModeHint = document.getElementById('prompt-mode-hint');

// Chips
const chipSampleTool = document.getElementById('chip-sample-tool');
const chipSampleText = document.getElementById('chip-sample-text');
const chipClear = document.getElementById('chip-clear');

/**
 * Toast feedback
 */
function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.borderColor = isError ? 'var(--accent-rose)' : 'var(--accent-emerald)';
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2400);
}

/**
 * Status message in dispatch footer
 */
function setStatus(message, type = '') {
  dispatchStatus.className = `status-msg ${type}`;
  dispatchStatus.textContent = message;
}

/**
 * Accurately extracts the outermost JSON object substring from raw text.
 * Finds the first '{', traverses character-by-character tracking curly brace depth
 * (depth++ on '{', depth-- on '}'). When depth === 0, slices the string exactly
 * at that index and discards any trailing conversational text/notes below it.
 */
function extractOuterJSON(str) {
  if (!str || typeof str !== 'string') return null;

  const startIndex = str.indexOf('{');
  if (startIndex === -1) {
    const arrayStart = str.indexOf('[');
    if (arrayStart === -1) return null;
    let depth = 0;
    for (let i = arrayStart; i < str.length; i++) {
      if (str[i] === '[') depth++;
      else if (str[i] === ']') {
        depth--;
        if (depth === 0) {
          return str.slice(arrayStart, i + 1);
        }
      }
    }
    return str.slice(arrayStart);
  }

  let depth = 0;
  for (let i = startIndex; i < str.length; i++) {
    const c = str[i];
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return str.slice(startIndex, i + 1);
      }
    }
  }

  return str.slice(startIndex);
}

/**
 * Resilient JSON Parser with Auto-Repair Engine
 * Primary Attempt: Standard JSON.parse(cleanedText)
 * Secondary Repair Attempt (if standard parse fails):
 * - Extract outermost JSON to discard any trailing conversational notes after }}
 * - Strip single-line comments
 * - Handle unescaped backslashes in strings (e.g. Windows paths, invalid regex escapes)
 * - Remove trailing commas in objects and arrays
 * - Target array payload areas like "commands":\s*[(.*?)] or common command keys and escape inner quotes
 * - Target key-value string payload areas like "command": "..." and escape interior unescaped double quotes
 * - Escape raw newlines in strings
 * - Balance unmatched delimiters (unclosed quotes, braces, brackets)
 * - Fallback to normalize single-quoted strings or unquoted object keys
 *
 * @param {string} text
 * @returns {{ success: boolean, data: any, repaired: boolean, repairReason?: string, error?: string, repairedText?: string }}
 */
function tryRepairAndParseJSON(text) {
  if (!text || typeof text !== 'string') {
    return { success: false, data: null, repaired: false, error: 'Empty or invalid input' };
  }

  const cleaned = text.trim();

  // Primary Attempt: Run standard JSON.parse(cleanedText)
  try {
    const data = JSON.parse(cleaned);
    return { success: true, data, repaired: false, raw: cleaned };
  } catch (primaryErr) {
    // Secondary Repair Attempt:
    // Extract outer JSON to discard any trailing conversational notes after }}
    const outerJson = extractOuterJSON(cleaned) || cleaned;

    // Check if outerJson parses directly without further repair
    if (outerJson !== cleaned) {
      try {
        const data = JSON.parse(outerJson);
        return {
          success: true,
          data,
          repaired: true,
          repairReason: 'discarded trailing notes outside JSON',
          repairedText: outerJson
        };
      } catch {
        // Continue to auto-repair pipeline on outerJson
      }
    }

    try {
      const { repairedText, reasons } = autoRepairJSON(outerJson);
      const data = JSON.parse(repairedText);
      return {
        success: true,
        data,
        repaired: true,
        repairReason: reasons.join(', ') || 'Inner quotes and syntax sanitized',
        repairedText
      };
    } catch (secondaryErr) {
      return {
        success: false,
        data: null,
        repaired: false,
        error: secondaryErr.message || primaryErr.message
      };
    }
  }
}

/**
 * Helper to validate backslash escape characters in JSON strings
 */
function repairBackslashChar(nextChar, nextFourChars) {
  if (nextChar === undefined) return '\\\\';
  if (['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(nextChar)) {
    return null; // valid escape sequence
  }
  if (nextChar === 'u' && /^[0-9a-fA-F]{4}$/.test(nextFourChars)) {
    return null; // valid unicode escape sequence
  }
  return '\\\\'; // illegal JSON escape, double the backslash
}

/**
 * Executes a multi-stage auto-repair pipeline on malformed JSON strings
 */
function autoRepairJSON(str) {
  let text = str;
  const reasons = [];

  // 1. Strip dedicated single-line JS comments (// ...) outside strings
  if (/^\s*\/\/.*$/m.test(text)) {
    text = text.replace(/^\s*\/\/.*$/gm, '');
    reasons.push('stripped comments');
  }

  // 2. Trailing commas in objects or arrays
  if (/,(\s*[}\]])/.test(text)) {
    text = text.replace(/,(\s*[}\]])/g, '$1');
    reasons.push('removed trailing commas');
  }

  // 3. Target array payload areas to neutralize interior quotes and normalize backslashes
  const beforeArray = text;
  text = repairArrayStrings(text);
  if (text !== beforeArray) {
    reasons.push('sanitized array quotes');
  }

  // 4. Target key-value string payload areas like "command": "..."
  const beforeKV = text;
  text = repairKeyValueStrings(text);
  if (text !== beforeKV) {
    reasons.push('sanitized interior quotes');
  }

  // 5. Fix unescaped backslashes in any remaining string values
  const beforeBackslash = text;
  text = repairBackslashes(text);
  if (text !== beforeBackslash) {
    reasons.push('sanitized backslashes');
  }

  // 6. Handle raw unescaped newlines inside strings
  const beforeNL = text;
  text = repairRawNewlinesInStrings(text);
  if (text !== beforeNL) {
    reasons.push('escaped raw newlines');
  }

  // 7. Balance unmatched delimiters (unclosed quotes, braces, brackets)
  const beforeBalance = text;
  text = balanceDelimiters(text);
  if (text !== beforeBalance) {
    reasons.push('balanced unmatched quotes/delimiters');
  }

  // Test parse attempt
  try {
    JSON.parse(text);
    return { repairedText: text, reasons };
  } catch (err) {
    // Secondary pass: normalize single-quoted strings or unquoted object keys
    const alt = repairSingleQuotesAndKeys(text);
    try {
      JSON.parse(alt);
      reasons.push('normalized quotes and object keys');
      return { repairedText: alt, reasons };
    } catch {
      return { repairedText: text, reasons };
    }
  }
}

/**
 * Sanitizes stray backslashes inside JSON strings (e.g. Windows paths C:\Users, regex escapes)
 * Replaces single backslashes (\) that are NOT followed by valid JSON escape characters
 * (", \, /, b, f, n, r, t, u) with double backslashes (\\).
 */
function repairBackslashes(str) {
  let result = '';
  let inStr = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '"' && (i === 0 || str[i - 1] !== '\\')) {
      inStr = !inStr;
      result += c;
      continue;
    }
    if (inStr && c === '\\') {
      const next = str[i + 1];
      if (next === undefined) {
        result += '\\\\';
        continue;
      }
      if (['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(next)) {
        result += c + next;
        i++;
        continue;
      }
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(str.substr(i + 2, 4))) {
        result += str.substr(i, 6);
        i += 5;
        continue;
      }
      result += '\\\\';
      continue;
    }
    result += c;
  }
  return result;
}

/**
 * Bracket-aware array string sanitizer
 * Counts square bracket depth properly so interior Python list brackets (e.g. widths=[...], ['top','left'])
 * do not break array boundaries. Safely escapes unescaped interior double quotes (e.g. python -c "...") into \".
 */
function repairArrayStrings(str) {
  const arrayHeaderPattern = /(["']?(?:commands|command|args|scripts|code|steps|queries)["']?\s*:\s*\[)/gi;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = arrayHeaderPattern.exec(str)) !== null) {
    const arrayStart = arrayHeaderPattern.lastIndex; // index right after '['
    result += str.slice(lastIndex, arrayStart);

    // Track square bracket depth to find true outer closing bracket ]
    let bracketDepth = 1;
    let closingBracketIdx = -1;

    for (let j = arrayStart; j < str.length; j++) {
      const char = str[j];
      if (char === '[') {
        bracketDepth++;
      } else if (char === ']') {
        bracketDepth--;
        if (bracketDepth === 0) {
          closingBracketIdx = j;
          break;
        }
      }
    }

    if (closingBracketIdx === -1) {
      // Fallback: search for last ']' before '}'
      const lastClose = str.lastIndexOf(']');
      closingBracketIdx = lastClose > arrayStart ? lastClose : str.length - 1;
    }

    const arrayBody = str.slice(arrayStart, closingBracketIdx);

    // Repair each string element inside arrayBody
    let repairedBody = '';
    let i = 0;
    while (i < arrayBody.length) {
      const quoteIdx = arrayBody.indexOf('"', i);
      if (quoteIdx === -1) {
        repairedBody += arrayBody.slice(i);
        break;
      }

      repairedBody += arrayBody.slice(i, quoteIdx + 1);
      let scan = quoteIdx + 1;
      let innerContent = '';
      let closingQuoteIdx = -1;

      while (scan < arrayBody.length) {
        if (arrayBody[scan] === '\\') {
          const next = arrayBody[scan + 1];
          if (next === '"') {
            innerContent += '\\"';
            scan += 2;
            continue;
          }
          const invalid = repairBackslashChar(next, arrayBody.substr(scan + 2, 4));
          if (invalid) {
            innerContent += '\\\\';
            scan++;
            continue;
          } else {
            innerContent += arrayBody[scan] + next;
            scan += (next === 'u' ? 6 : 2);
            continue;
          }
        }

        if (arrayBody[scan] === '"') {
          const remainder = arrayBody.slice(scan + 1);
          // Check if followed by comma and next item quote, or trailing whitespace to end of arrayBody
          if (/^\s*(?:,\s*"|\s*$)/.test(remainder)) {
            closingQuoteIdx = scan;
            break;
          } else {
            // Interior unescaped quote! Safely convert to escaped quote \"
            innerContent += '\\"';
            scan++;
            continue;
          }
        }

        innerContent += arrayBody[scan];
        scan++;
      }

      if (closingQuoteIdx !== -1) {
        repairedBody += innerContent + '"';
        i = closingQuoteIdx + 1;
      } else {
        repairedBody += innerContent + '"';
        i = scan;
      }
    }

    result += repairedBody;
    lastIndex = closingBracketIdx;
    arrayHeaderPattern.lastIndex = closingBracketIdx;
  }

  result += str.slice(lastIndex);
  return result;
}

/**
 * Repairs unescaped inner quotes and single backslashes in object property strings: "key": "value with "inner" quotes"
 */
function repairKeyValueStrings(str) {
  const propStartPattern = /(["']?[a-zA-Z0-9_-]+["']?\s*:\s*")/g;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = propStartPattern.exec(str)) !== null) {
    const matchEnd = propStartPattern.lastIndex;
    result += str.slice(lastIndex, matchEnd);

    let scan = matchEnd;
    let innerContent = '';
    let closingQuoteIdx = -1;

    while (scan < str.length) {
      if (str[scan] === '\\') {
        const next = str[scan + 1];
        if (next === '"') {
          innerContent += '\\"';
          scan += 2;
          continue;
        }
        const invalid = repairBackslashChar(next, str.substr(scan + 2, 4));
        if (invalid) {
          innerContent += '\\\\';
          scan++;
          continue;
        } else {
          innerContent += str[scan] + next;
          scan += (next === 'u' ? 6 : 2);
          continue;
        }
      }

      if (str[scan] === '"') {
        const remainder = str.slice(scan + 1);
        // Is it followed by comma then next property key or object/array close?
        if (/^\s*(?:,\s*["']?[a-zA-Z0-9_-]+["']?\s*:|\s*[}\]])/.test(remainder)) {
          closingQuoteIdx = scan;
          break;
        } else {
          // Interior unescaped quote! Safely convert to escaped quote \"
          innerContent += '\\"';
          scan++;
          continue;
        }
      }

      // Check if line ended without closing quote before newline + next property/brace
      if (str[scan] === '\n') {
        const remainder = str.slice(scan);
        if (/^\s*\n\s*(?:["']?[a-zA-Z0-9_-]+["']?\s*:|[}\]])/.test(remainder)) {
          closingQuoteIdx = scan;
          break;
        }
      }

      innerContent += str[scan];
      scan++;
    }

    if (closingQuoteIdx !== -1) {
      result += innerContent + '"';
      lastIndex = closingQuoteIdx + (str[closingQuoteIdx] === '"' ? 1 : 0);
      propStartPattern.lastIndex = lastIndex;
    } else {
      result += innerContent;
      lastIndex = scan;
    }
  }

  result += str.slice(lastIndex);
  return result;
}

/**
 * Replaces unescaped raw newlines inside string literals with \n
 */
function repairRawNewlinesInStrings(str) {
  let result = '';
  let inStr = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '"' && (i === 0 || str[i - 1] !== '\\')) {
      inStr = !inStr;
      result += c;
      continue;
    }
    if (inStr && c === '\n') {
      result += '\\n';
      continue;
    }
    if (inStr && c === '\r') {
      continue;
    }
    result += c;
  }
  return result;
}

/**
 * Balances unclosed quotes, braces, and brackets
 */
function balanceDelimiters(str) {
  let openBraces = 0;
  let openBrackets = 0;
  let inStr = false;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && inStr) {
      i++;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr) {
      if (c === '{') openBraces++;
      else if (c === '}') openBraces = Math.max(0, openBraces - 1);
      else if (c === '[') openBrackets++;
      else if (c === ']') openBrackets = Math.max(0, openBrackets - 1);
    }
  }

  let balanced = str;
  if (inStr) {
    balanced += '"';
  }
  while (openBrackets > 0) {
    balanced += ']';
    openBrackets--;
  }
  while (openBraces > 0) {
    balanced += '}';
    openBraces--;
  }
  return balanced;
}

/**
 * Converts single-quoted JSON or unquoted keys to valid double-quoted JSON
 */
function repairSingleQuotesAndKeys(str) {
  let s = str.replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":');
  s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, inner) => {
    const escaped = inner.replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
  return s;
}

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
function sanitizeResponseInput(rawText) {
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

  // 2. Extract markdown code blocks if present
  let codeBlockContent = null;
  const codeBlockMatch = cleaned.match(/```(?:json|javascript|js|xml)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    codeBlockContent = codeBlockMatch[1].trim();
  }

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

  // Determine candidate JSON string using accurate outer JSON extractor first to discard trailing text
  let candidateJson = null;
  if (codeBlockContent) {
    candidateJson = extractOuterJSON(codeBlockContent) || findBalancedJson(codeBlockContent) || codeBlockContent;
  } else {
    candidateJson = extractOuterJSON(cleaned) || findBalancedJson(cleaned);
  }

  // Fallback: extract substring between first { or [ and last } or ] if balanced scan didn't find one
  if (!candidateJson) {
    const firstBrace = cleaned.search(/[{\[]/);
    const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidateJson = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }

  // Primary and secondary auto-repair parsing using tryRepairAndParseJSON
  let parseResult = candidateJson ? tryRepairAndParseJSON(candidateJson) : null;

  // If candidate failed, also try running tryRepairAndParseJSON on codeBlockContent or cleaned
  if ((!parseResult || !parseResult.success) && codeBlockContent && candidateJson !== codeBlockContent) {
    const cbResult = tryRepairAndParseJSON(codeBlockContent);
    if (cbResult.success) {
      parseResult = cbResult;
    }
  }
  if ((!parseResult || !parseResult.success) && candidateJson !== cleaned) {
    const clResult = tryRepairAndParseJSON(cleaned);
    if (clResult.success) {
      parseResult = clResult;
    }
  }

  let parsedJson = (parseResult && parseResult.success) ? parseResult.data : null;
  const isRepaired = Boolean(parseResult?.repaired);
  const repairReason = parseResult?.repairReason || '';

  // Detect whether the input strongly appears to be intended as JSON
  const looksLikeJson =
    codeBlockMatch !== null ||
    cleaned.startsWith('{') ||
    cleaned.startsWith('[') ||
    cleaned.includes('```json') ||
    (cleaned.includes('{') && (
      cleaned.includes('"name"') ||
      cleaned.includes('"arguments"') ||
      cleaned.includes('"tool_calls"') ||
      cleaned.includes('"function"') ||
      cleaned.includes('"command"') ||
      cleaned.includes('"commands"')
    ));

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
function updateValidationIndicator() {
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

/**
 * Extract latest user message (role === 'user')
 */
function getLatestUserMessage(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content.map(c => c.text || JSON.stringify(c)).join('\n');
      }
      return JSON.stringify(msg.content, null, 2);
    }
  }

  return null;
}

/**
 * Helper to safely extract content from a message (string, array of parts, or object)
 */
function getMessageContent(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map(c => {
        if (typeof c === 'string') return c;
        if (c && typeof c.text === 'string') return c.text;
        return JSON.stringify(c);
      })
      .join('\n');
  }
  if (typeof msg.content === 'object' && msg.content !== null) {
    return JSON.stringify(msg.content, null, 2);
  }
  return String(msg.content ?? '');
}

/**
 * Format tool output content safely
 */
function getToolOutput(msg) {
  return getMessageContent(msg);
}

const JSON_INSTRUCTION = 'Respond strictly with an OpenAI-compatible JSON tool call object (e.g. {"name": "...", "arguments": {...}}) or plain text.';

const CRITICAL_SYSTEM_DIRECTIVE = `---
[CRITICAL SYSTEM DIRECTIVE: Output ONLY a single raw JSON tool call starting directly with { on line 1, OR concise plain text if the task is completely finished. Absolutely ZERO markdown code blocks (no \`\`\`), conversational filler, or commentary.]`;

/**
 * Format prompt in Compact Mode (Default for Auto-Copy & Quick Copy):
 * - Extract only the last message from the messages array (messages[messages.length - 1]).
 * - If it's a tool output (role: "tool"): format cleanly with tool output block.
 * - If it's a regular user message: format just that message.
 * - Appends the unambiguous CRITICAL SYSTEM DIRECTIVE as the absolute last line.
 */
function formatCompactPrompt(req) {
  const messages = Array.isArray(req.messages) ? req.messages : [];
  if (messages.length === 0) {
    return `${JSON_INSTRUCTION}\n\n${CRITICAL_SYSTEM_DIRECTIVE}`;
  }

  const lastMsg = messages[messages.length - 1];
  const content = getMessageContent(lastMsg).trim();

  let formatted = '';
  if (lastMsg && lastMsg.role === 'tool') {
    const toolId = lastMsg.tool_call_id ? ` for ${lastMsg.tool_call_id}` : '';
    formatted = `Tool execution output${toolId}:
---
${content}
---
Based on this output, proceed with the next step. ${JSON_INSTRUCTION}`;
  } else {
    // Regular user message (or other role)
    formatted = `${content}

---
${JSON_INSTRUCTION}`;
  }

  return `${formatted}\n\n${CRITICAL_SYSTEM_DIRECTIVE}`;
}

/**
 * Format prompt in Full Mode:
 * Copies the full message history and available tools (for the very first turn of a task or starting a fresh web chat).
 */
function formatFullPrompt(req) {
  let formatted = `INSTRUCTION:\n${JSON_INSTRUCTION} Do not add markdown backticks.\n\n`;

  const messages = Array.isArray(req.messages) ? req.messages : [];
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;

  // If the last message is a tool output, prominently highlight it at the top
  if (lastMsg && lastMsg.role === 'tool') {
    const toolOutput = getMessageContent(lastMsg);
    formatted += `==================================================\n`;
    formatted += `LATEST TERMINAL / TOOL OUTPUT:\n`;
    if (lastMsg.tool_call_id) {
      formatted += `Tool Call ID: ${lastMsg.tool_call_id}\n`;
    }
    formatted += `Result / Output:\n${toolOutput}\n`;
    formatted += `==================================================\n`;
    formatted += `NOTE FOR LLM: The command or tool above has finished execution in the environment. Analyze its output and provide the next tool call or final response.\n\n`;
  }

  if (req.tools && Array.isArray(req.tools) && req.tools.length > 0) {
    formatted += `AVAILABLE TOOLS:\n${JSON.stringify(req.tools, null, 2)}\n\n`;
  }

  formatted += `CONVERSATION HISTORY:\n`;
  if (messages.length > 0) {
    messages.forEach(m => {
      const role = (m.role || 'user').toUpperCase();
      let content = m.content;
      if (typeof content !== 'string') {
        content = JSON.stringify(content, null, 2);
      }

      if (m.role === 'tool') {
        formatted += `--- [TERMINAL / TOOL OUTPUT${m.tool_call_id ? ` (${m.tool_call_id})` : ''}] ---\n${content}\n\n`;
      } else if (m.role === 'assistant' && m.tool_calls) {
        formatted += `--- [ASSISTANT (REQUESTED TOOL CALLS)] ---\n${JSON.stringify(m.tool_calls, null, 2)}\n`;
        if (content) formatted += `Commentary: ${content}\n`;
        formatted += `\n`;
      } else {
        formatted += `--- [${role}] ---\n${content}\n\n`;
      }
    });
  }

  return `${formatted.trim()}\n\n${CRITICAL_SYSTEM_DIRECTIVE}`;
}

/**
 * Universal formatter supporting 'compact' or 'full' modes
 */
function formatForWebChat(req, mode = 'compact') {
  return mode === 'full' ? formatFullPrompt(req) : formatCompactPrompt(req);
}

/**
 * Copy text to clipboard with optional custom toast message
 */
async function copyToClipboard(text, btnElement, toastMsg = 'Copied to clipboard!') {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    if (btnElement) {
      const originalHtml = btnElement.innerHTML;
      btnElement.innerHTML = `✓ Copied!`;
      setTimeout(() => {
        btnElement.innerHTML = originalHtml;
      }, 1800);
    }

    showToast(toastMsg);
  } catch (err) {
    console.error('Failed to copy:', err);
    showToast('Failed to copy to clipboard', true);
  }
}

/**
 * Update selection state UI
 */
function updateSelectionUI() {
  const req = pendingRequests.find(r => r.id === selectedRequestId);
  if (selectedRequestId && req) {
    selectedReqDisplay.textContent = selectedRequestId;
    const msgCount = (req.messages || []).length;
    const toolCount = (req.tools || []).length;
    selectedReqMeta.textContent = `${msgCount} msgs • ${toolCount} tools`;
    sendBtn.disabled = false;
    if (cancelActiveBtn) cancelActiveBtn.disabled = false;

    if (btnCopyCompact) btnCopyCompact.disabled = false;
    if (btnCopyFull) btnCopyFull.disabled = false;

    if (promptModeHint) {
      if (msgCount <= 2) {
        promptModeHint.textContent = 'First turn: Full Context recommended';
        promptModeHint.className = 'prompt-mode-hint first-turn';
      } else {
        promptModeHint.textContent = 'Compact mode active';
        promptModeHint.className = 'prompt-mode-hint';
      }
    }
  } else {
    selectedReqDisplay.textContent = 'None selected';
    selectedReqMeta.textContent = '';
    sendBtn.disabled = true;
    if (cancelActiveBtn) cancelActiveBtn.disabled = true;

    if (btnCopyCompact) btnCopyCompact.disabled = true;
    if (btnCopyFull) btnCopyFull.disabled = true;

    if (promptModeHint) {
      promptModeHint.textContent = 'No request selected';
      promptModeHint.className = 'prompt-mode-hint';
    }
  }

  // Update card highlights
  const cards = pendingList.querySelectorAll('.request-card');
  cards.forEach(card => {
    if (card.dataset.id === selectedRequestId) {
      card.classList.add('selected');
      const selectBtn = card.querySelector('.btn-select');
      if (selectBtn) selectBtn.textContent = 'Selected';
    } else {
      card.classList.remove('selected');
      const selectBtn = card.querySelector('.btn-select');
      if (selectBtn) selectBtn.textContent = 'Select';
    }
  });
}

/**
 * Render list of pending requests
 */
function renderPendingList() {
  pendingCount.textContent = pendingRequests.length;

  if (pendingRequests.length === 0) {
    pendingList.innerHTML = '';
    pendingList.appendChild(emptyState);
    emptyState.style.display = 'flex';

    serverStatus.textContent = 'AgentPipe Dashboard - Waiting for Requests...';
    pulseIndicator.className = 'pulse-dot idle';

    selectedRequestId = null;
    updateSelectionUI();
    return;
  }

  emptyState.style.display = 'none';
  serverStatus.textContent = `AgentPipe Dashboard - ${pendingRequests.length} Active Request${pendingRequests.length > 1 ? 's' : ''}`;
  pulseIndicator.className = 'pulse-dot';

  // If currently selected request is no longer present, select the first available
  if (!selectedRequestId || !pendingRequests.some(r => r.id === selectedRequestId)) {
    selectedRequestId = pendingRequests[0].id;
  }

  pendingList.innerHTML = '';

  pendingRequests.forEach(req => {
    const card = document.createElement('div');
    card.className = `request-card ${req.id === selectedRequestId ? 'selected' : ''}`;
    card.dataset.id = req.id;

    const messages = Array.isArray(req.messages) ? req.messages : [];
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const isToolResult = lastMsg && lastMsg.role === 'tool';
    const latestUserMsg = getLatestUserMessage(messages);

    const fullJson = JSON.stringify({ messages: req.messages, tools: req.tools }, null, 2);

    const timeAgo = req.createdAt ? Math.max(0, Math.floor((Date.now() - req.createdAt) / 1000)) : 0;
    const timeDisplay = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.floor(timeAgo / 60)}m ago`;

    // 1. User Message HTML (if any user message exists)
    let userMsgHtml = '';
    if (latestUserMsg) {
      userMsgHtml = `
        <div class="user-msg-container">
          <div class="user-msg-label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
            Latest User Message
          </div>
          <div class="user-msg-content">${escapeHtml(latestUserMsg)}</div>
        </div>
      `;
    }

    // 2. Dedicated Terminal / Tool Output Box (if last message has role === 'tool')
    let toolOutputHtml = '';
    if (isToolResult) {
      const toolText = getToolOutput(lastMsg);
      toolOutputHtml = `
        <div class="terminal-output-container">
          <div class="terminal-header">
            <div class="terminal-header-left">
              <div class="terminal-dots">
                <span class="terminal-dot red"></span>
                <span class="terminal-dot yellow"></span>
                <span class="terminal-dot green"></span>
              </div>
              <div class="terminal-title">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="4 17 10 11 4 5"></polyline>
                  <line x1="12" y1="19" x2="20" y2="19"></line>
                </svg>
                Terminal / Tool Output:
              </div>
            </div>
            ${lastMsg.tool_call_id ? `<span class="tool-id-tag">${escapeHtml(lastMsg.tool_call_id)}</span>` : ''}
          </div>
          <div class="terminal-body">
            <div class="terminal-prompt-line">
              <span>$ [execution result]</span>
            </div>
            <div class="terminal-content">${escapeHtml(toolText)}</div>
          </div>
        </div>
      `;
    }

    // Fallback if neither user message nor tool output exists
    if (!userMsgHtml && !toolOutputHtml) {
      userMsgHtml = `
        <div class="user-msg-container">
          <div class="user-msg-label">Message</div>
          <div class="user-msg-content">(No user or tool message found)</div>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="card-top">
        <span class="req-id-badge">${req.id}</span>
        <span class="req-time">${timeDisplay}</span>
      </div>

      ${userMsgHtml}
      ${toolOutputHtml}

      <details>
        <summary>View Messages & Tools JSON (${messages.length} msgs, ${(req.tools || []).length} tools)</summary>
        <pre class="json-preview"><code>${escapeHtml(fullJson)}</code></pre>
      </details>

      <div class="card-actions">
        <div class="card-copy-group">
          <button class="btn btn-secondary btn-compact-card copy-compact-btn" title="Copy last message/tool output (Compact Mode)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy (Compact)
          </button>
          <button class="btn btn-secondary copy-full-btn" title="Copy full context and tools (Full Mode)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            Full
          </button>
        </div>
        <div class="card-btn-group">
          <button class="btn btn-cancel cancel-req-btn" title="Cancel this request">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            Cancel
          </button>
          <button class="btn btn-select">${req.id === selectedRequestId ? 'Selected' : 'Select'}</button>
        </div>
      </div>
    `;

    // Click anywhere on card (except buttons & details) to select
    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('details')) return;
      selectedRequestId = req.id;
      updateSelectionUI();
    });

    const selectBtn = card.querySelector('.btn-select');
    selectBtn.addEventListener('click', () => {
      selectedRequestId = req.id;
      updateSelectionUI();
    });

    const cancelBtn = card.querySelector('.cancel-req-btn');
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelRequest(req.id);
    });

    const copyCompactBtn = card.querySelector('.copy-compact-btn');
    copyCompactBtn.addEventListener('click', () => {
      const formattedText = formatCompactPrompt(req);
      copyToClipboard(formattedText, copyCompactBtn, 'Copied Last Message (Compact Mode)!');
    });

    const copyFullBtn = card.querySelector('.copy-full-btn');
    copyFullBtn.addEventListener('click', () => {
      const formattedText = formatFullPrompt(req);
      copyToClipboard(formattedText, copyFullBtn, 'Copied Full Context!');
    });

    pendingList.appendChild(card);
  });

  updateSelectionUI();
}

/**
 * Simple HTML escape
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const ORIGINAL_TITLE = 'AgentPipe - Human-in-the-Loop LLM Proxy';
let lastAutoCopiedRequestId = null;
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Unlock audio context on first user gesture
function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}
window.addEventListener('click', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });
window.addEventListener('touchstart', unlockAudio, { once: true });

/**
 * Play a short, subtle, pleasant chime using Web Audio API oscillator
 */
function playNotificationChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    // Primary tone (E5 -> A5)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    osc1.frequency.exponentialRampToValueAtTime(880.0, now + 0.12);

    gain1.gain.setValueAtTime(0.12, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.35);

    // Harmonic overtone (E6)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1318.5, now + 0.08);
    gain2.gain.setValueAtTime(0.05, now + 0.08);
    gain2.gain.exponentialRampToValueAtTime(0.0005, now + 0.4);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);

    osc2.start(now + 0.08);
    osc2.stop(now + 0.4);
  } catch (err) {
    console.debug('[AgentPipe] Audio chime blocked or unavailable:', err);
  }
}

function setNewRequestTitle() {
  document.title = '(🔴 New Request) AgentPipe';
}

function restoreTitle() {
  document.title = ORIGINAL_TITLE;
}

/**
 * Automatically format and copy prompt when tab gains focus with a pending request
 * - Uses Compact Mode by default
 * - Automatically uses Full Mode if it's the first turn in the session (messages.length <= 2)
 */
async function handleAutoCopyOnFocus() {
  restoreTitle();

  if (pendingRequests.length === 0) return;

  const targetReq = pendingRequests.find(r => r.id === selectedRequestId) || pendingRequests[0];
  if (!targetReq) return;

  // Avoid duplicate auto-copying for the same request
  if (lastAutoCopiedRequestId === targetReq.id) return;

  try {
    const messages = Array.isArray(targetReq.messages) ? targetReq.messages : [];
    const isFirstTurn = messages.length <= 2;
    const mode = isFirstTurn ? 'full' : 'compact';
    const formatted = mode === 'full' ? formatFullPrompt(targetReq) : formatCompactPrompt(targetReq);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(formatted);
      lastAutoCopiedRequestId = targetReq.id;

      // Update active state on segmented buttons
      if (btnCopyCompact && btnCopyFull) {
        if (mode === 'full') {
          btnCopyFull.classList.add('active');
          btnCopyCompact.classList.remove('active');
        } else {
          btnCopyCompact.classList.add('active');
          btnCopyFull.classList.remove('active');
        }
      }

      showToast(`⚡ Prompt Auto-copied (${isFirstTurn ? 'Full Context' : 'Compact Mode'})!`);
    }
  } catch (err) {
    console.debug('[AgentPipe] Auto-copy on focus blocked or failed:', err);
  }
}

window.addEventListener('focus', handleAutoCopyOnFocus);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    handleAutoCopyOnFocus();
  }
});

/**
 * Native Server-Sent Events (SSE) Connection for Real-Time Updates
 */
const eventSource = new EventSource('/api/events');

eventSource.onopen = () => {
  console.log('[AgentPipe] SSE connection established');
  if (pendingRequests.length === 0) {
    serverStatus.textContent = 'AgentPipe Dashboard - Waiting for Requests...';
    pulseIndicator.className = 'pulse-dot idle';
  } else {
    serverStatus.textContent = `AgentPipe Dashboard - ${pendingRequests.length} Active Request${pendingRequests.length > 1 ? 's' : ''}`;
    pulseIndicator.className = 'pulse-dot';
  }
};

eventSource.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    const newRequests = Array.isArray(data) ? data : [];

    // Check if new requests arrived
    const previousIds = new Set(pendingRequests.map(r => r.id));
    const hasNewArrivals = newRequests.some(r => !previousIds.has(r.id));

    pendingRequests = newRequests;
    renderPendingList();

    if (hasNewArrivals && pendingRequests.length > 0) {
      playNotificationChime();
      setNewRequestTitle();

      // If document is already focused and visible, auto-copy immediately
      if (document.hasFocus() && !document.hidden) {
        handleAutoCopyOnFocus();
      }
    }
  } catch (err) {
    console.error('[AgentPipe] Error parsing SSE event data:', err);
  }
};

eventSource.onerror = (err) => {
  console.warn('[AgentPipe] SSE connection error / reconnecting...', err);
  serverStatus.textContent = 'AgentPipe Server Disconnected - Reconnecting...';
  pulseIndicator.className = 'pulse-dot idle';
};

/**
 * Dispatch response to Cline
 */
async function handleSend() {
  if (!selectedRequestId) {
    setStatus('Please select an incoming request first.', 'error');
    showToast('No request selected', true);
    return;
  }

  const raw = responseInput.value.trim();
  if (!raw) {
    setStatus('Response body is empty. Please enter or paste output.', 'error');
    showToast('Response cannot be empty', true);
    responseInput.focus();
    return;
  }

  const sanitized = sanitizeResponseInput(raw);

  if (sanitized.mode === 'malformed') {
    setStatus(`Cannot send: Malformed JSON (${sanitized.error}). Fix syntax or remove JSON brackets.`, 'error');
    showToast(`Malformed JSON: ${sanitized.error}`, true);
    responseInput.focus();
    return;
  }

  const payloadToSend = sanitized.payload;

  const modeLabel = sanitized.mode === 'tool'
    ? (sanitized.repaired ? `auto-repaired tool (${sanitized.toolName})` : `tool (${sanitized.toolName})`)
    : 'text response';

  setStatus(`Dispatching ${modeLabel} to ${selectedRequestId}...`, 'sending');
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: selectedRequestId,
        payload: payloadToSend
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to resolve request');
    }

    const resolvedId = selectedRequestId;
    setStatus(`✓ Successfully resolved ${resolvedId}!`, 'success');
    showToast(sanitized.repaired
      ? `Auto-repaired response dispatched to agent (${resolvedId})`
      : `Response dispatched to agent (${resolvedId})`);

    restoreTitle();
    lastAutoCopiedRequestId = null;

    responseInput.value = '';
    selectedRequestId = null;
    updateSelectionUI();
    updateValidationIndicator();
  } catch (err) {
    console.error('Send error:', err);
    setStatus(`Dispatch failed: ${err.message}`, 'error');
    showToast(`Failed: ${err.message}`, true);
  } finally {
    sendBtn.disabled = !selectedRequestId;
  }
}

// Event Listeners
sendBtn.addEventListener('click', handleSend);

// Keyboard shortcut: Ctrl + Enter / Cmd + Enter
responseInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!sendBtn.disabled) {
      handleSend();
    } else if (!selectedRequestId) {
      showToast('Select an incoming request first', true);
    } else if (!responseInput.value.trim()) {
      showToast('Response input cannot be empty', true);
    }
  }
});

// Live validation on typing / pasting
responseInput.addEventListener('input', updateValidationIndicator);

// Smart Auto-Paste on textarea focus
responseInput.addEventListener('focus', async () => {
  // Only trigger if textarea is currently empty
  if (responseInput.value.trim().length > 0) return;

  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const clipText = await navigator.clipboard.readText();
      if (clipText && clipText.trim()) {
        const trimmed = clipText.trim();

        // Guard: Do not paste outgoing prompt if clipboard hasn't changed
        if (
          trimmed.startsWith('INSTRUCTION:') ||
          trimmed.startsWith('Tool execution output') ||
          trimmed.includes('Respond strictly with an OpenAI-compatible') ||
          trimmed.includes('CRITICAL SYSTEM DIRECTIVE') ||
          trimmed.includes('[CRITICAL SYSTEM DIRECTIVE:')
        ) {
          return;
        }

        if (responseInput.value.trim().length === 0) {
          responseInput.value = trimmed;
          updateValidationIndicator();
          showToast('📋 Auto-pasted response from clipboard!');
        }
      }
    }
  } catch (err) {
    // Graceful catch for permission rejections or non-gesture focus
    console.debug('[AgentPipe] Auto-paste readText not permitted:', err);
  }
});

refreshBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/pending');
    if (res.ok) {
      const data = await res.json();
      pendingRequests = Array.isArray(data) ? data : [];
      renderPendingList();
    }
    showToast('Refreshed requests list');
  } catch (err) {
    console.error('Manual refresh failed:', err);
    showToast('Failed to refresh', true);
  }
});

chipSampleTool.addEventListener('click', () => {
  responseInput.value = JSON.stringify({
    name: 'execute_command',
    arguments: {
      command: 'echo "Hello from AgentPipe"'
    }
  }, null, 2);
  updateValidationIndicator();
  responseInput.focus();
});

chipSampleText.addEventListener('click', () => {
  responseInput.value = 'I have analyzed the project structure and everything is set up correctly. Ready for the next instruction!';
  updateValidationIndicator();
  responseInput.focus();
});

chipClear.addEventListener('click', () => {
  responseInput.value = '';
  setStatus('');
  updateValidationIndicator();
  responseInput.focus();
});

// Smart Prompt Formatter Segmented Button Click Handlers
if (btnCopyCompact) {
  btnCopyCompact.addEventListener('click', () => {
    if (!selectedRequestId) {
      showToast('Select an incoming request first', true);
      return;
    }
    const req = pendingRequests.find(r => r.id === selectedRequestId);
    if (!req) return;

    btnCopyCompact.classList.add('active');
    btnCopyFull?.classList.remove('active');

    const formatted = formatCompactPrompt(req);
    copyToClipboard(formatted, btnCopyCompact, 'Copied Last Message (Compact Mode)!');
  });
}

if (btnCopyFull) {
  btnCopyFull.addEventListener('click', () => {
    if (!selectedRequestId) {
      showToast('Select an incoming request first', true);
      return;
    }
    const req = pendingRequests.find(r => r.id === selectedRequestId);
    if (!req) return;

    btnCopyFull.classList.add('active');
    btnCopyCompact?.classList.remove('active');

    const formatted = formatFullPrompt(req);
    copyToClipboard(formatted, btnCopyFull, 'Copied Full Context!');
  });
}

/**
 * Cancel / Abort a request
 */
async function cancelRequest(id) {
  if (!id) return;

  try {
    const res = await fetch('/api/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to cancel request');
    }

    // Clear response textarea and update UI immediately
    responseInput.value = '';
    updateValidationIndicator();

    // Optimistically remove request from local state
    pendingRequests = pendingRequests.filter(r => r.id !== id);

    if (selectedRequestId === id) {
      selectedRequestId = pendingRequests.length > 0 ? pendingRequests[0].id : null;
    }

    renderPendingList();
    setStatus(`Request ${id} canceled`, '');
    showToast('Request canceled');
  } catch (err) {
    console.error('Cancel error:', err);
    setStatus(`Failed to cancel: ${err.message}`, 'error');
    showToast(`Failed to cancel: ${err.message}`, true);
  }
}

// Active Request Cancel Button Listener
if (cancelActiveBtn) {
  cancelActiveBtn.addEventListener('click', () => {
    if (selectedRequestId) {
      cancelRequest(selectedRequestId);
    } else {
      showToast('No request selected to cancel', true);
    }
  });
}

// Quick Connection Bar Listeners
if (copyBaseUrlBtn) {
  copyBaseUrlBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyToClipboard(BASE_URL, copyBaseUrlBtn, 'Copied Base URL (http://localhost:4747/v1)!');
  });
}

if (baseUrlBadge) {
  baseUrlBadge.addEventListener('click', (e) => {
    if (e.target.closest('#copy-base-url-btn')) return;
    copyToClipboard(BASE_URL, copyBaseUrlBtn, 'Copied Base URL (http://localhost:4747/v1)!');
  });
}

if (copySystemPromptBtn) {
  copySystemPromptBtn.addEventListener('click', () => {
    copyToClipboard(SYSTEM_PROMPT, copySystemPromptBtn, 'Copied System Prompt to clipboard!');
  });
}

// Initialize live validation state
updateValidationIndicator();


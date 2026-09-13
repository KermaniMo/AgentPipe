/**
 * Accurately extracts the outermost JSON object substring from raw text.
 * Finds the first '{', traverses character-by-character tracking curly brace depth
 * (depth++ on '{', depth-- on '}'). When depth === 0, slices the string exactly
 * at that index and discards any trailing conversational text/notes below it.
 */
export function extractOuterJSON(str) {
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
export function tryRepairAndParseJSON(text) {
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
 * Sanitizes stray backslashes inside JSON strings (e.g. Windows paths C:\\Users, regex escapes)
 * Replaces single backslashes (\\) that are NOT followed by valid JSON escape characters
 * (", \\, /, b, f, n, r, t, u) with double backslashes (\\\\).
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
 * do not break array boundaries. Safely escapes unescaped interior double quotes (e.g. python -c "...") into \\".
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
            // Interior unescaped quote! Safely convert to escaped quote \\"
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
          // Interior unescaped quote! Safely convert to escaped quote \\"
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
 * Replaces unescaped raw newlines inside string literals with \\n
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

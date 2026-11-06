/**
 * Comment- and string-aware scanner.
 *
 * Rules must never match text inside a comment (real plugins document the very
 * patterns we look for, e.g. "this listener returns next()"). Two views:
 *
 *   masked     comments blanked, string literals INTACT — for matching quoted
 *              event names and reading literal values with exact line numbers.
 *   structural masked AND string interiors blanked — for brace-depth analysis.
 */

const BACKTICK = '\u0060';

/** @returns {{ masked: string, structural: string, strings: Array<{value:string,start:number,end:number,line:number}>, lineStarts: number[] }} */
export function maskSource(text) {
  const maskedChars = text.split('');
  const structuralChars = text.slice().split('');
  const strings = [];
  const lineStarts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1);

  const NL = '\n';
  const SP = ' ';
  const blank = (from, to, chars) => {
    for (let k = from; k < to; k++) if (chars[k] !== NL) chars[k] = SP;
  };
  // A '/' starts a regex only where a value may begin; otherwise it is division.
  // Two cases the naive "previous character" test gets wrong:
  //   a++ / b   - the first slash is division, and treating it as a regex would
  //               swallow the following "//" comment into the masked view.
  //   return /re/ - the previous character is a letter, but a keyword allows a
  //               regex here.
  const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|case|delete|void|throw|new|in|of|do|else|yield|await)$/;
  const regexAllowed = (idx) => {
    let k = idx - 1;
    while (k >= 0 && (maskedChars[k] === SP || maskedChars[k] === NL || maskedChars[k] === '\t')) k -= 1;
    if (k < 0) return true;
    const prev = maskedChars[k];
    if ('(,=:[!&|?{};+-*%<>~^'.indexOf(prev) >= 0) {
      if ((prev === '+' || prev === '-') && maskedChars[k - 1] === prev) return false;
      return true;
    }
    if (!/[\w$]/.test(prev)) return false;
    let wordStart = k;
    while (wordStart >= 0 && /[\w$]/.test(maskedChars[wordStart])) wordStart -= 1;
    return REGEX_KEYWORDS.test(maskedChars.slice(wordStart + 1, k + 1).join(''));
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '/' && next === '/') {
      const from = i;
      while (i < n && text[i] !== NL) i++;
      blank(from, i, maskedChars);
      blank(from, i, structuralChars);
      continue;
    }
    if (c === '/' && next === '*') {
      const from = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      blank(from, i, maskedChars);
      blank(from, i, structuralChars);
      continue;
    }

    // The literal delimiter itself, not a boolean: the closing delimiter must
    // compare equal to it.
    const quote = c === '"' ? '"' : c === "'" ? "'" : c === BACKTICK ? BACKTICK : undefined;
    if (quote !== undefined) {
      const from = i;
      i += 1;
      const contentFrom = i;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) break;
        if (text[i] === NL && quote !== BACKTICK) break; // unterminated literal
        i += 1;
      }
      const contentTo = Math.min(i, n);
      const end = Math.min(i + 1, n);
      strings.push({ value: text.slice(contentFrom, contentTo), start: from, end, line: lineOfIndex(lineStarts, from) });
      blank(contentFrom, contentTo, structuralChars);
      i = end;
      continue;
    }

    if (c === '/' && regexAllowed(i)) {
      const from = i;
      i += 1;
      let inClass = false;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) { i += 1; break; }
        else if (text[i] === NL) break;
        i += 1;
      }
      // A regex body is data, not code: braces and quotes inside it must not
      // reach the structural view, and a literal "session.append(" inside it
      // must not look like a call site.
      blank(from, i, maskedChars);
      blank(from, i, structuralChars);
      continue;
    }
    i += 1;
  }
  return { masked: maskedChars.join(''), structural: structuralChars.join(''), strings, lineStarts };
}

export function lineOfIndex(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The first string literal starting at or after \`from\` within \`window\` characters. */
export function stringAfter(strings, from, window) {
  for (const s of strings) {
    if (s.start >= from) return s.start - from <= window ? s : undefined;
  }
  return undefined;
}

/** Literal types passed to Session.append(type, data). */
export function appendCallSites(masked, strings) {
  const out = [];
  // Session receivers the host exposes: bare `session`, ctx.session,
  // agent.session and this.session. A property named `session` on an unrelated
  // object (formData.session) is not a Session, so only these names count.
  const re = /(?<![\w$.])(?:(?:ctx|agent|this)\s*\.\s*)?session\s*\.\s*append\s*\(\s*/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    if (insideString(strings, m.index)) continue;
    const s = stringAt(strings, m.index + m[0].length);
    if (!s) continue;
    if (s.value.includes('${')) continue;
    out.push({ type: s.value, index: s.start, line: s.line });
  }
  return out;
}

/** True when `index` falls inside a string literal (where the text is data). */
function insideString(strings, index) {
  let lo = 0;
  let hi = strings.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = strings[mid];
    if (index < s.start) hi = mid - 1;
    else if (index >= s.end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** The string literal whose opening quote is exactly at `index`, if any. */
function stringAt(strings, index) {
  let lo = 0;
  let hi = strings.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = strings[mid];
    if (s.start < index) lo = mid + 1;
    else if (s.start > index) hi = mid - 1;
    else return s;
  }
  return undefined;
}

/** The balanced brace block that starts at or after `index`, on the structural view. */
export function blockAfter(structural, index) {
  const open = structural.indexOf('{', index);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < structural.length; i++) {
    const c = structural[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { start: open, end: i + 1, body: structural.slice(open + 1, i) };
    }
  }
  return undefined;
}

/** Brace depth at a character index, computed on the structural view. */
export function braceDepthAt(structural, index) {
  let depth = 0;
  for (let k = 0; k < index && k < structural.length; k++) {
    const c = structural[k];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
  }
  return depth;
}

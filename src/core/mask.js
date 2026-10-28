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
  const regexAllowed = (prev) => prev === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(prev) >= 0;
  const lastMeaningful = (idx) => {
    for (let k = idx - 1; k >= 0; k--) {
      const c = maskedChars[k];
      if (c === SP || c === NL || c === '\t') continue;
      return c;
    }
    return '';
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

    if (c === '/' && regexAllowed(lastMeaningful(i))) {
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

/** Literal types passed to session.append("type", data) call sites. */
export function appendCallSites(masked, strings) {
  const out = [];
  const re = /\.append\(\s*/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const s = stringAfter(strings, m.index + m[0].length, 32);
    if (s) out.push({ type: s.value, index: s.start, line: s.line });
  }
  return out;
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

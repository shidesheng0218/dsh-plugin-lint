/**
 * Security deep analysis rules — EXPERIMENTAL.
 *
 * These heuristics go beyond capability disclosure and look at how a capability
 * appears to be used. They are static pattern matches over source text, not
 * runtime observation: every rule caps at warning level, a finding is a review
 * hint rather than a verdict, and a clean run says nothing about safety.
 *
 * @module security
 */

/**
 * Security-focused rule definitions for the lint engine.
 * These extend the base RULES with deeper (experimental) analysis.
 */
export const SECURITY_RULES = [
  {
    id: 'S1',
    level: 'warn',
    title: 'session data sent to external domains',
    category: 'data-exfiltration',
    check(ctx, options, push) {
      for (const file of ctx.jsFiles) {
        const exfiltrations = detectDataExfiltration(file, ['session', 'agent', 'messages']);
        for (const ex of exfiltrations) {
          push({
            file: file.path,
            line: ex.line,
            message: `Potentially sending ${ex.dataType} to external URL: ${ex.url}`,
            evidence: ex.snippet,
            hint: 'Review whether sensitive session data should be transmitted externally. Ensure proper user consent and encryption.',
          });
        }
      }
    },
  },

  {
    id: 'S2',
    level: 'warn',
    title: 'credentials stored in localStorage or sessionStorage',
    category: 'credential-handling',
    check(ctx, options, push) {
      for (const file of ctx.jsFiles) {
        const storagePattern = /(localStorage|sessionStorage)\s*\.\s*setItem\s*\(\s*['"]([^'"]*(?:token|key|secret|password|auth|credential)[^'"]*)['"]/gi;
        let m;
        while ((m = storagePattern.exec(file.masked)) !== null) {
          push({
            file: file.path,
            line: lineOfIndex(file.masked, m.index),
            message: `Storing sensitive data (${m[2]}) in ${m[1]}`,
            evidence: m[0],
            hint: 'Browser storage is not encrypted and accessible to all scripts. Use secure credential storage APIs or context-provided auth mechanisms.',
          });
        }
      }
    },
  },

  {
    id: 'S3',
    level: 'warn',
    title: 'eval() or Function() constructor used',
    category: 'code-injection',
    check(ctx, options, push) {
      for (const file of ctx.jsFiles) {
        // The structural view blanks string interiors, so a documented "eval(" in
        // a string literal is not mistaken for a call site.
        const source = file.structural ?? file.masked ?? file.text;
        const evalPattern = /\beval\s*\(/g;
        const functionPattern = /\bnew\s+Function\s*\(/g;
        
        let m;
        while ((m = evalPattern.exec(source)) !== null) {
          push({
            file: file.path,
            line: lineOfIndex(file.masked, m.index),
            message: 'Use of eval() detected',
            evidence: extractContext(file.text, m.index, 50),
            hint: 'eval() executes arbitrary code and can be a security risk. Consider safer alternatives like JSON.parse() or structured data processing.',
          });
        }

        while ((m = functionPattern.exec(source)) !== null) {
          push({
            file: file.path,
            line: lineOfIndex(file.masked, m.index),
            message: 'Use of Function() constructor detected',
            evidence: extractContext(file.text, m.index, 50),
            hint: 'Dynamic function construction can execute arbitrary code. Consider structured alternatives.',
          });
        }
      }
    },
  },

  {
    id: 'S4',
    level: 'warn',
    title: 'innerHTML used with unsanitized data',
    category: 'xss',
    check(ctx, options, push) {
      const clientFile = ctx.jsFiles.find((f) => f.path === ctx.entries?.client);
      if (!clientFile) return;

      // The masked view keeps string literals intact but blanks comments, so a
      // documented example in a comment is not a finding.
      const source = clientFile.masked ?? clientFile.text;
      const innerHTMLPattern = /\.innerHTML\s*=\s*([^;]+)/g;
      let m;

      while ((m = innerHTMLPattern.exec(source)) !== null) {
        const assignment = m[1].trim();
        const isSanitized = /\b(?:DOMPurify|sanitize|escapeHtml)\b/.test(assignment);
        if (isSanitized) continue;
        // A plain string literal is safe; a template literal is safe only when it
        // has no interpolation. Everything else is dynamic and worth a look.
        const plainString = /^(?:'[^']*'|"[^"]*")\s*$/.test(assignment);
        if (plainString) continue;
        const template = /^`([\s\S]*)`\s*$/.exec(assignment);
        if (template && !/\$\{/.test(template[1])) continue;
        push({
          file: clientFile.path,
          line: lineOfIndex(clientFile.text, m.index),
          message: 'innerHTML assigned a value that is not a static string',
          evidence: m[0],
          hint: 'Use textContent for plain text, or sanitize HTML with a library like DOMPurify before assigning to innerHTML.',
        });
      }
    },
  },

  {
    id: 'S5',
    level: 'info',
    title: 'makes network requests to external domains',
    category: 'network-integrity',
    check(ctx, options, push) {
      // The DSH manifest has no declared-capability field, so this rule cannot
      // compare against a declaration. It reports what the code does, as an
      // inventory entry, and says nothing about whether that use is appropriate.
      const seen = new Map();
      const domainPattern = /(?:fetch|axios)\s*(?:\.\s*(?:get|post|put|delete))?\s*\(\s*['"`](https?:\/\/[^'"`]+)['"`]/g;

      for (const file of ctx.jsFiles) {
        let m;
        while ((m = domainPattern.exec(file.masked ?? file.text)) !== null) {
          try {
            const url = new URL(m[1]);
            if (!seen.has(url.hostname)) {
              seen.set(url.hostname, { file: file.path, line: lineOfIndex(file.text, m.index), url: m[1] });
            }
          } catch {
            // Invalid URL
          }
        }
      }

      for (const [domain, site] of [...seen.entries()].slice(0, 10)) {
        push({
          file: site.file,
          line: site.line,
          message: 'calls ' + site.url,
          evidence: domain,
          hint: 'Observed literal URL in the code. This is an inventory entry, not a declaration check: the DSH manifest has no dsh.capabilities field.',
        });
      }
    },
  },

  {
    id: 'S6',
    level: 'warn',
    title: 'shell command injection risk',
    category: 'command-injection',
    check(ctx, options, push) {
      for (const file of ctx.jsFiles) {
        // Check for exec/spawn with string interpolation
        const execPatterns = [
          /exec\s*\(\s*`[^`]*\$\{/g,
          /spawn\s*\(\s*`[^`]*\$\{/g,
          /exec\s*\(\s*['"][^'"]*\+/g,
        ];

        for (const pattern of execPatterns) {
          let m;
          while ((m = pattern.exec(file.masked)) !== null) {
            push({
              file: file.path,
              line: lineOfIndex(file.masked, m.index),
              message: 'Potential command injection: shell command built with string concatenation',
              evidence: extractContext(file.text, m.index, 60),
              hint: 'Use spawn() with array arguments instead of exec() with strings. Validate and sanitize all user input.',
            });
          }
        }
      }
    },
  },

  {
    id: 'S7',
    level: 'warn',
    title: 'file system operations outside workspace',
    category: 'fs-access',
    check(ctx, options, push) {
      for (const file of ctx.jsFiles) {
        // Look for fs operations with hardcoded absolute paths
        const fsWithAbsPath = /(?:readFile|writeFile|unlink|rmdir|rm)\s*\(\s*['"`](\/[^'"`]+|[A-Z]:\\[^'"`]+)['"`]/g;
        let m;

        while ((m = fsWithAbsPath.exec(file.masked ?? file.text)) !== null) {
          // Exclude common safe paths
          const path = m[1];
          if (path.startsWith('/tmp') || path.startsWith('/var/tmp')) continue;

          push({
            file: file.path,
            line: lineOfIndex(file.masked, m.index),
            message: `File system access to hardcoded absolute path: ${path}`,
            evidence: extractContext(file.text, m.index, 60),
            hint: 'Plugins should operate within the workspace. Use ctx.workspace.root or relative paths.',
          });
        }
      }
    },
  },

  {
    id: 'S8',
    level: 'info',
    title: 'uses cryptographic functions',
    category: 'crypto-usage',
    check(ctx, options, push) {
      for (const file of ctx.jsFiles) {
        const cryptoPattern = /\bcrypto\s*\.\s*(createHash|createHmac|createCipher|randomBytes|pbkdf2|scrypt)/g;
        const findings = new Map();

        let m;
        while ((m = cryptoPattern.exec(file.masked ?? file.text)) !== null) {
          const fn = m[1];
          if (!findings.has(fn)) findings.set(fn, []);
          findings.get(fn).push(lineOfIndex(file.masked, m.index));
        }

        for (const [fn, lines] of findings) {
          push({
            file: file.path,
            line: lines[0],
            message: `Uses crypto.${fn}() (${lines.length} occurrence(s))`,
            evidence: `Lines: ${lines.slice(0, 5).join(', ')}`,
            hint: 'Ensure cryptographic operations use secure parameters (e.g., sufficient iterations for pbkdf2, secure algorithm for createCipher).',
          });
        }
      }
    },
  },

  {
    id: 'S9',
    level: 'warn',
    title: 'accesses process.env without validation',
    category: 'environment-access',
    check(ctx, options, push) {
      for (const file of ctx.jsFiles) {
        // The structural view blanks string interiors: a documented variable name
        // inside a string is not an access.
        const source = file.structural ?? file.masked ?? file.text;
        const envPattern = /process\s*\.\s*env\s*\.\s*([A-Z_][A-Z0-9_]*)/g;
        const accessed = new Set();

        let m;
        while ((m = envPattern.exec(source)) !== null) {
          accessed.add(m[1]);
        }

        if (accessed.size > 5) {
          push({
            file: file.path,
            line: 1,
            message: `Accesses ${accessed.size} environment variables`,
            evidence: `Variables: ${Array.from(accessed).slice(0, 10).join(', ')}`,
            hint: 'Validate and provide defaults for environment variables. Document required environment variables in README.',
          });
        }
      }
    },
  },

  {
    id: 'S10',
    level: 'warn',
    title: 'uses insecure HTTP in production code',
    category: 'transport-security',
    check(ctx, options, push) {
      // Only a URL used as a request target counts: an XML namespace such as
      // "http://www.w3.org/2000/svg" is a string literal, not a network call.
      const requestPattern = /(?:fetch|axios|https?\s*\.\s*request|new\s+URL)\s*(?:\.\s*\w+\s*)?\(\s*['"`](http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^'"`]+)['"`]/g;
      for (const file of ctx.jsFiles) {
        const source = file.masked ?? file.text;
        let m;

        while ((m = requestPattern.exec(source)) !== null) {
          push({
            file: file.path,
            line: lineOfIndex(file.text, m.index),
            message: `Insecure HTTP request target: ${m[1]}`,
            evidence: extractContext(file.text, m.index, 50),
            hint: 'Use HTTPS for network requests to keep data integrity and confidentiality.',
          });
        }
      }
    },
  },
];

export const SECURITY_LIMITS = [
  'Experimental static heuristics over source text: a finding describes a pattern, not observed behaviour, and is not a security verdict.',
  'Rules read the masked source: comments are blanked; string literals stay intact where a URL or storage key is itself the evidence.',
  'No rule in this module is error-level, and a clean run does not mean the plugin is safe.',
];

/**
 * Detect potential data exfiltration patterns.
 */
function detectDataExfiltration(file, sensitiveDataTypes) {
  const results = [];
  
  // Look for fetch/axios calls that reference sensitive data
  const fetchPattern = /(?:fetch|axios\s*\.\s*(?:post|put))\s*\(\s*['"`]([^'"`]+)['"`][^)]*\{[^}]*body[^}]*:/g;
  
  let m;
  while ((m = fetchPattern.exec(file.masked)) !== null) {
    const url = m[1];
    const callSite = m.index;
    const contextEnd = Math.min(callSite + 300, file.masked.length);
    const context = file.masked.slice(callSite, contextEnd);

    // Check if sensitive data types appear in the context
    for (const dataType of sensitiveDataTypes) {
      const dataPattern = new RegExp(`\\b${dataType}\\b`, 'i');
      if (dataPattern.test(context)) {
        // Check if URL is external
        if (url.startsWith('http://') || url.startsWith('https://')) {
          results.push({
            line: lineOfIndex(file.masked, callSite),
            url,
            dataType,
            snippet: extractContext(file.text, callSite, 100)
          });
        }
      }
    }
  }

  return results;
}

/**
 * Extract context around a position for evidence display.
 */
function extractContext(text, index, maxLen) {
  const start = Math.max(0, index - Math.floor(maxLen / 2));
  const end = Math.min(text.length, index + Math.ceil(maxLen / 2));
  let snippet = text.slice(start, end);
  
  // Clean up for display
  snippet = snippet.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  
  return snippet;
}

/**
 * Find line number from character index.
 */
function lineOfIndex(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Run security analysis on a loaded package.
 */
export function analyzeSecurityDeep(pkg) {
  const findings = [];
  
  const ctx = {
    ...pkg,
    byPath: (rel) => pkg.jsFiles.find((f) => f.path === rel),
  };

  for (const rule of SECURITY_RULES) {
    const push = (finding) => {
      findings.push({
        rule: rule.id,
        level: rule.level,
        title: rule.title,
        category: rule.category,
        experimental: true,
        ...finding
      });
    };

    try {
      rule.check(ctx, {}, push);
    } catch (error) {
      findings.push({
        rule: rule.id,
        level: 'info',
        title: rule.title,
        category: rule.category,
        experimental: true,
        file: 'package.json',
        line: 1,
        message: 'Security rule did not complete: ' + error.message,
        evidence: '',
        hint: 'This may be a bug in dsh-plugin-lint.',
      });
    }
  }

  // Categorize findings
  const byCategory = {};
  for (const finding of findings) {
    const cat = finding.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(finding);
  }

  const summary = {
    total: findings.length,
    error: findings.filter(f => f.level === 'error').length,
    warn: findings.filter(f => f.level === 'warn').length,
    info: findings.filter(f => f.level === 'info').length,
  };

  return {
    experimental: true,
    findings,
    byCategory,
    summary,
    riskLevel: assessOverallRisk(summary, byCategory),
    limits: SECURITY_LIMITS,
  };
}

/**
 * Assess overall security risk level.
 */
function assessOverallRisk(summary, byCategory) {
  // Security findings are heuristic, so none of them is error-level; the risk
  // level is a summary of how many warnings a package carries, not a verdict.
  if (summary.warn >= 10) return 'high';
  if (summary.warn >= 4) return 'medium';
  if (summary.warn >= 1) return 'low';
  return 'minimal';
}

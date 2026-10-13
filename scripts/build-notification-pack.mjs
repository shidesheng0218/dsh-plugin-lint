#!/usr/bin/env node
/**
 * Build the notification pack.
 *
 *   node scripts/build-notification-pack.mjs [--report reports/<date>] [--cells matrix/cells] [--out notify]
 *
 * Project policy (ADR D-001): name the package, state only what was detected,
 * cite the source, and contact the maintainer before publishing. This collects
 * every package we would name — linter error and warn findings, plus plugins
 * whose matrix verdict is worse on the newest pinned DSH version — and writes one
 * ready-to-send message per package, grouped by maintainer.
 *
 * Info-level findings are deliberately excluded: a missing icon or compatibility
 * range is ecosystem-wide context, not a maintainer's problem.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FENCE = String.fromCharCode(96).repeat(3);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const reportDir = argOf('--report', join(ROOT, 'reports/2026-10-13'));
const cellsDir = argOf('--cells', join(ROOT, 'matrix/cells'));
const outDir = argOf('--out', join(ROOT, 'notify'));
const RANK = { active: 0, 'awaiting-service': 1, 'rejected-by-host': 2, 'inactive-error': 3, 'boot-failed': 4, 'install-failed': 5, 'template-failed': 6 };
const best = (list) => list.slice().sort((a, b) => (RANK[a.result.status] ?? 9) - (RANK[b.result.status] ?? 9))[0];
const safe = (name) => name.replace(/[^a-z0-9.-]/gi, '_');

const subjects = new Map();
const add = (name, reason) => {
  if (!subjects.has(name)) subjects.set(name, { name, reasons: [] });
  subjects.get(name).reasons.push(reason);
};

// 1. linter findings at error or warn level
const raw = JSON.parse(readFileSync(join(reportDir, 'raw.json'), 'utf8'));
for (const r of raw.results) {
  if (!r.version) continue;
  const serious = (r.findings || []).filter((f) => f.level !== 'info');
  if (serious.length === 0) continue;
  add(r.name, {
    kind: 'linter',
    headline: serious.length + ' static finding(s) at error or warn level',
    lines: serious.map((f) => ({
      label: f.rule + ' (' + f.level + ') ' + f.title,
      where: f.file + ':' + f.line,
      detected: f.message,
      evidence: f.evidence,
      doc: f.doc,
    })),
    reproduce: 'npx dsh-plugin-lint .',
  });
}

// 2. matrix verdicts that are worse on the newest pinned version
if (existsSync(cellsDir)) {
  const cells = [];
  for (const dir of readdirSync(cellsDir)) {
    const abs = join(cellsDir, dir);
    if (!statSync(abs).isDirectory()) continue;
    for (const file of readdirSync(abs)) {
      if (file.endsWith('.json')) cells.push(JSON.parse(readFileSync(join(abs, file), 'utf8')));
    }
  }
  const versions = [...new Set(cells.map((c) => c.dsh.version))].sort();
  const mainline = versions[0];
  const newest = versions[versions.length - 1];
  const byPlugin = new Map();
  for (const c of cells) {
    if (!byPlugin.has(c.plugin.name)) byPlugin.set(c.plugin.name, []);
    byPlugin.get(c.plugin.name).push(c);
  }
  for (const [name, own] of byPlugin) {
    const a = best(own.filter((c) => c.dsh.version === mainline));
    const b = best(own.filter((c) => c.dsh.version === newest));
    if (!a || !b) continue;
    if ((RANK[b.result.status] ?? 9) <= (RANK[a.result.status] ?? 9)) continue;
    add(name, {
      kind: 'matrix',
      headline: 'verdict is worse on DSH ' + newest + ' than on ' + mainline,
      lines: [{
        label: mainline + ': ' + a.result.status + '  ->  ' + newest + ': ' + b.result.status,
        where: (b.result.composition || 'headless') + ' composition',
        detected: b.result.rejection || (b.result.entries || []).map((e) => e.id + ': ' + e.reason).join(' | ') || b.result.status,
        evidence: b.reproduce.command,
        doc: 'docs/11-m4-capability-probe.md',
      }],
      reproduce: b.reproduce.command,
    });
  }
}

// 3. contact details, grouped by maintainer
const cache = new Map();
async function contactOf(name) {
  if (cache.has(name)) return cache.get(name);
  let out = { maintainers: [], repo: '', homepage: '' };
  try {
    const meta = await (await fetch('https://registry.npmjs.org/' + encodeURIComponent(name))).json();
    out = {
      maintainers: (meta.maintainers || []).map((m) => ({ name: m.name, email: m.email })),
      repo: meta.repository?.url || '',
      homepage: meta.homepage || '',
    };
  } catch { /* unlisted contact stays empty */ }
  cache.set(name, out);
  return out;
}

mkdirSync(join(outDir, 'packages'), { recursive: true });
const byMaintainer = new Map();
const index = [];
for (const subject of subjects.values()) {
  const contact = await contactOf(subject.name);
  index.push({ name: subject.name, maintainers: contact.maintainers, repo: contact.repo, reasons: subject.reasons });
  for (const m of contact.maintainers) {
    if (!byMaintainer.has(m.name)) byMaintainer.set(m.name, { email: m.email, packages: [] });
    byMaintainer.get(m.name).packages.push(subject.name);
  }
  const lines = ['# ' + subject.name, ''];
  for (const reason of subject.reasons) {
    lines.push('## ' + reason.headline, '');
    for (const l of reason.lines) {
      lines.push('- **' + l.label + '**');
      if (l.where) lines.push('  - where: ' + l.where);
      if (l.detected) lines.push('  - detected: ' + l.detected);
      if (l.evidence) lines.push('  - evidence: ' + l.evidence);
      if (l.doc) lines.push('  - source: ' + l.doc);
    }
    lines.push('', 'Reproduce: ' + reason.reproduce, '');
  }
  writeFileSync(join(outDir, 'packages', safe(subject.name) + '.md'), lines.join('\n'));
}

const L = [];
const p = (s) => L.push(s === undefined ? '' : s);
p('# Notification pack');
p();
p('Generated ' + new Date().toISOString() + ' from ' + raw.provenance.tool.name + '@' + raw.provenance.tool.version + '.');
p();
p('**Status: unpublished.** Nothing here may be published before every maintainer below has been contacted and given at least 14 days to respond.');
p();
p('Policy (ADR D-001): name the package, state only what was detected, cite the source document, never score or rank. Info-level findings are excluded by design.');
p();
p('Packages to notify: **' + index.length + '** · maintainers: **' + byMaintainer.size + '**');
p();
p('## By maintainer');
p();
for (const [name, info] of [...byMaintainer.entries()].sort((a, b) => b[1].packages.length - a[1].packages.length)) {
  p('- **' + name + '**' + (info.email ? ' <' + info.email + '>' : '') + ' — ' + info.packages.length + ' package(s): ' + info.packages.join(', '));
}
p();
p('## By package');
p();
for (const entry of index.slice().sort((a, b) => a.name.localeCompare(b.name))) {
  p('### ' + entry.name);
  p();
  p('- maintainers: ' + (entry.maintainers.map((m) => m.name + ' <' + m.email + '>').join(', ') || 'not listed'));
  p('- repository: ' + (entry.repo || 'not listed'));
  for (const reason of entry.reasons) {
    p('- ' + reason.headline + ' (' + reason.kind + ')');
    p('  - reproduce: ' + reason.reproduce);
    p('  - message: notify/packages/' + safe(entry.name) + '.md');
  }
  p();
}
p('## Message template (中文)');
p();
p(FENCE + 'text');
p('主题：[dsh-plugin-lint] 关于 <包名>@<版本> 的检查结果（发布前告知）');
p();
p('你好 <维护者>：');
p();
p('我们在维护 dsh-plugin-lint（DeepSeek Harness 插件的静态合规检查 + 兼容性矩阵）。');
p('对 npm 上按下载量排序的插件做了一轮检查，其中涉及你的 <包名>@<版本>。');
p('以下是**检测到的事实**，不是评价，也不构成安全结论：');
p();
p('<粘贴 notify/packages/<包名>.md 的内容>');
p();
p('复现方式：见上文每条结论附带的命令。');
p();
p('报告计划在 <日期> 公开发布，会点名列出上述事实。在此之前：');
p('- 如果判断有误，请直接回复，我们会先修规则再重跑，并在变更记录里注明；');
p('- 如果有我们没考虑到的上下文，也欢迎说明，我们会写进报告的"限制"一节。');
p(FENCE);
p();
p('## Message template (English)');
p();
p(FENCE + 'text');
p('Subject: [dsh-plugin-lint] check result for <package>@<version>');
p();
p('Hello <maintainer>,');
p();
p('We maintain dsh-plugin-lint, a static conformance checker and compatibility matrix for');
p('DeepSeek Harness plugins. We ran it over plugins ranked by downloads, and it reported the');
p('following for <package>@<version>. These are detected facts, not a judgement and not a');
p('security conclusion:');
p();
p('<paste notify/packages/<package>.md>');
p();
p('Reproduce: see the command attached to each line above.');
p();
p('We plan to publish the report on <date>, naming the packages and these facts. Before then:');
p('if a finding is wrong, tell us and we will fix the rule and re-run before publishing. If we');
p('are missing context, we will add it to the report limitations.');
p(FENCE);
p();
writeFileSync(join(outDir, 'NOTIFICATIONS.md'), L.join('\n'));
writeFileSync(join(outDir, 'index.json'), JSON.stringify({
  schemaVersion: 1,
  at: new Date().toISOString(),
  status: 'unpublished',
  policy: 'ADR D-001: notify before publishing',
  packages: index.length,
  maintainers: byMaintainer.size,
  byMaintainer: Object.fromEntries([...byMaintainer.entries()].map(([k, v]) => [k, v.packages])),
  byPackage: Object.fromEntries(index.map((e) => [e.name, { maintainers: e.maintainers, reasons: e.reasons.map((r) => r.headline) }])),
}, null, 2) + '\n');

console.log('notification pack written to ' + outDir);
console.log('  packages   : ' + index.length);
console.log('  maintainers: ' + byMaintainer.size);
console.log('  messages   : ' + readdirSync(join(outDir, 'packages')).length);

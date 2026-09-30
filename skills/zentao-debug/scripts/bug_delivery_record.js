#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function nowIso() {
  return new Date().toISOString();
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`;
  return JSON.stringify(String(value));
}

function safePart(value, fallback = 'bug') {
  return String(value || fallback)
    .replace(/<[^>]+>/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || fallback;
}

function objectId(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return String(value.id || value.ID || value.value || '');
  return String(value);
}

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return String(value.name || value.title || value.realname || value.id || '');
  return String(value);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    repositories: [], branches: [], baseCommits: [], headCommits: [], changedFiles: [],
    sessionIds: process.env.CODEX_SESSION_ID ? [process.env.CODEX_SESSION_ID] : [],
    vault: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') { options.apply = true; continue; }
    if (argument === '--json') { options.json = true; continue; }
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} 缺少参数值`);
    const repeated = {
      '--repository': 'repositories', '--branch': 'branches', '--base-commit': 'baseCommits',
      '--head-commit': 'headCommits', '--changed-file': 'changedFiles', '--session-id': 'sessionIds',
    };
    const singles = {
      '--bug': 'bugId', '--summary': 'summary', '--phase': 'phase', '--vault': 'vault',
      '--root-cause': 'rootCause', '--resolution': 'resolution', '--validation': 'validation',
      '--risk': 'risk', '--event-at': 'eventAt',
    };
    if (repeated[argument]) options[repeated[argument]].push(value);
    else if (singles[argument]) options[singles[argument]] = value;
    else throw new Error(`不支持的参数：${argument}`);
    index += 1;
  }
  if (options.help) return options;
  if (!options.bugId || !/^\d+$/.test(options.bugId)) throw new Error('--bug 必须是纯数字 ID');
  if (!['fix-authorized', 'local-fixed', 'committed', 'documented'].includes(options.phase)) throw new Error('--phase 无效');
  options.vault = path.resolve(options.vault);
  return options;
}

function help() {
  return [
    '用法：bug_delivery_record.js --bug <ID> --phase <阶段> --vault <目录> [选项]',
    '',
    '阶段：fix-authorized、local-fixed、committed、documented',
    '首次创建必须提供 --summary <bug-<id>-summary.json>。',
    'Git 关联可重复提供 --repository、--branch、--base-commit、--head-commit、--changed-file。',
    '不传 --apply 时仅预览。',
  ].join('\n');
}

function walkMarkdown(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkMarkdown(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(fullPath);
  }
  return result;
}

function findExisting(vault, bugId) {
  const root = path.join(vault, '04.项目');
  const pattern = new RegExp(`^zentaoBugId:\\s*["']?${bugId}["']?\\s*$`, 'm');
  const matches = walkMarkdown(root).filter((filePath) => {
    const prefix = fs.readFileSync(filePath, 'utf8').slice(0, 10000);
    return /^type:\s*["']?zentao-bug-delivery["']?\s*$/m.test(prefix) && pattern.test(prefix);
  });
  if (matches.length > 1) throw new Error(`发现多个 Bug #${bugId} 交付记录，拒绝自动选择`);
  return matches[0] || '';
}

function findProjectRoot(vault, executionId) {
  if (!executionId) return '';
  const root = path.join(vault, '04.项目');
  const marker = new RegExp(`^id:\\s*["']?zentao-execution-${executionId}["']?\\s*$`, 'm');
  for (const filePath of walkMarkdown(root).filter((item) => path.basename(item) === '00.迭代总览.md')) {
    if (marker.test(fs.readFileSync(filePath, 'utf8').slice(0, 12000))) return path.dirname(filePath);
  }
  return '';
}

function readBug(options, existing) {
  if (options.summary) {
    const summaryPath = path.resolve(options.summary);
    if (!fs.existsSync(summaryPath)) throw new Error(`Bug 摘要不存在：${summaryPath}`);
    const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const bug = data.bug || data.data || data;
    return {
      id: String(bug.id || options.bugId),
      title: scalar(bug.title || bug.name) || `Bug #${options.bugId}`,
      executionId: objectId(bug.execution),
      storyId: objectId(bug.story),
      status: scalar(bug.status),
      severity: scalar(bug.severity),
      assignedTo: scalar(bug.assignedToRealName || bug.assignedTo),
      resolvedBy: scalar(bug.resolvedByRealName || bug.resolvedBy),
    };
  }
  if (!existing) throw new Error('首次创建 Bug交付记录必须提供 --summary');
  const content = fs.readFileSync(existing, 'utf8');
  const value = (key) => content.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)`, 'm'))?.[1]?.trim() || '';
  return {
    id: options.bugId,
    title: content.match(/^#\s+禅道 Bug\s+#\d+\s+·\s+(.+)$/m)?.[1]?.trim() || `Bug #${options.bugId}`,
    executionId: value('zentaoExecutionId'),
    storyId: value('zentaoStoryId'),
    status: value('zentaoStatus'),
    severity: value('severity'),
    assignedTo: value('assignedTo'),
    resolvedBy: value('resolvedBy'),
  };
}

function splitFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: '', body: content };
  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

function upsertField(lines, key, value) {
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  const rendered = `${key}: ${yamlScalar(value)}`;
  if (index >= 0) lines[index] = rendered;
  else lines.push(rendered);
}

function existingArray(lines, key) {
  const line = lines.find((item) => item.startsWith(`${key}:`));
  if (!line) return [];
  const raw = line.slice(line.indexOf(':') + 1).trim();
  if (!raw || raw === '[]') return [];
  try {
    const parsed = JSON.parse(raw.replace(/'/g, '"'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_error) {
    return [];
  }
}

function replaceSection(content, heading, value) {
  if (!value) return content;
  const pattern = new RegExp(`(^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$)([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm');
  if (pattern.test(content)) return content.replace(pattern, `$1\n\n${value.trim()}\n\n`);
  const manualIndex = content.indexOf('\n## 人工备注');
  const block = `\n\n${heading}\n\n${value.trim()}\n`;
  return manualIndex >= 0 ? `${content.slice(0, manualIndex)}${block}${content.slice(manualIndex)}` : `${content.trimEnd()}${block}`;
}

function renderNewNote(bug, options, projectLink) {
  return [
    '---',
    'type: "zentao-bug-delivery"',
    `zentaoBugId: ${yamlScalar(bug.id)}`,
    `zentaoExecutionId: ${yamlScalar(bug.executionId)}`,
    `zentaoStoryId: ${yamlScalar(bug.storyId)}`,
    `zentaoStatus: ${yamlScalar(bug.status)}`,
    `severity: ${yamlScalar(bug.severity)}`,
    `assignedTo: ${yamlScalar(bug.assignedTo)}`,
    `resolvedBy: ${yamlScalar(bug.resolvedBy)}`,
    `project: ${yamlScalar(projectLink)}`,
    `workflowStatus: ${yamlScalar(options.phase)}`,
    `createdAt: ${yamlScalar(nowIso())}`,
    'updatedAt: ""',
    'repositories: []',
    'branches: []',
    'baseCommits: []',
    'headCommits: []',
    'changedFiles: []',
    `codexSessions: ${yamlScalar([...new Set(options.sessionIds.filter(Boolean))])}`,
    '---',
    '',
    `# 禅道 Bug #${bug.id} · ${bug.title}`,
    '',
    '## 快速入口',
    '',
    `- 所属迭代：${projectLink || '未定位'}`,
    `- 禅道只读状态快照：\`${bug.status || '未知'}\``,
    '',
    '## 根因与证据',
    '',
    options.rootCause || '',
    '',
    '## 修复方案与修改范围',
    '',
    options.resolution || '',
    '',
    '## 验证与验收',
    '',
    options.validation || '',
    '',
    '## 上线风险与回滚',
    '',
    options.risk || '',
    '',
    '## 人工备注',
    '',
  ].join('\n');
}

function updateNote(content, bug, options, projectLink) {
  const split = splitFrontmatter(content);
  if (!split.frontmatter) throw new Error('Bug交付记录缺少 Frontmatter');
  const lines = split.frontmatter.split(/\r?\n/);
  const priorSessions = existingArray(lines, 'codexSessions');
  const fields = {
    zentaoExecutionId: bug.executionId,
    zentaoStoryId: bug.storyId,
    zentaoStatus: bug.status,
    severity: bug.severity,
    assignedTo: bug.assignedTo,
    resolvedBy: bug.resolvedBy,
    project: projectLink,
    workflowStatus: options.phase,
    updatedAt: options.eventAt || nowIso(),
    repositories: options.repositories.length ? options.repositories : undefined,
    branches: options.branches.length ? options.branches : undefined,
    baseCommits: options.baseCommits.length ? options.baseCommits : undefined,
    headCommits: options.headCommits.length ? options.headCommits : undefined,
    changedFiles: options.changedFiles.length ? options.changedFiles : undefined,
    codexSessions: [...new Set([...priorSessions, ...options.sessionIds.filter(Boolean)])],
  };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) upsertField(lines, key, value);
  let body = split.body;
  body = replaceSection(body, '## 根因与证据', options.rootCause);
  body = replaceSection(body, '## 修复方案与修改范围', options.resolution);
  body = replaceSection(body, '## 验证与验收', options.validation);
  body = replaceSection(body, '## 上线风险与回滚', options.risk);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

function buildPlan(options) {
  const existing = findExisting(options.vault, options.bugId);
  const bug = readBug(options, existing);
  if (bug.id !== options.bugId) throw new Error(`摘要中的 Bug ID ${bug.id} 与参数 ${options.bugId} 不一致`);
  const projectRoot = findProjectRoot(options.vault, bug.executionId);
  const directory = projectRoot
    ? path.join(projectRoot, '02.项目管理', 'Bug交付')
    : path.join(options.vault, '04.项目', '00.分支管理', '05.Bug交付');
  const filePath = existing || path.join(directory, `Bug-${bug.id}-${safePart(bug.title)}.md`);
  const projectFile = projectRoot ? path.join(projectRoot, '00.迭代总览.md') : '';
  const projectLink = projectFile ? `[[${path.relative(options.vault, projectFile).replace(/\.md$/i, '').split(path.sep).join('/')}|所属迭代]]` : '';
  const before = existing ? fs.readFileSync(existing, 'utf8') : '';
  const after = existing ? updateNote(before, bug, options, projectLink) : renderNewNote(bug, options, projectLink);
  return {
    mode: options.apply ? 'apply' : 'preview',
    bug,
    filePath,
    relativePath: path.relative(options.vault, filePath).split(path.sep).join('/'),
    projectLink,
    changed: before !== after,
    content: after,
    branchSyncPlanned: options.repositories.length > 0 && options.branches.length > 0,
  };
}

function syncBranch(plan, options) {
  if (!plan.branchSyncPlanned) return null;
  if (options.repositories.length !== options.branches.length) throw new Error('--repository 与 --branch 数量必须一致');
  const script = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'skills', 'git-branch-delivery', 'scripts', 'branch_delivery_core.js');
  const args = [
    script, 'sync-source', '--vault', options.vault,
    '--source-type', 'bug', '--source-id', options.bugId,
    '--title', plan.bug.title, '--note-path', plan.relativePath,
    '--relation', '补充修复', '--source-status', plan.bug.status || options.phase,
  ];
  if (plan.bug.executionId) args.push('--execution-id', plan.bug.executionId);
  if (plan.bug.storyId) args.push('--story-id', plan.bug.storyId);
  for (const value of options.repositories) args.push('--repository', value);
  for (const value of options.branches) args.push('--branch', value);
  for (const value of options.baseCommits) args.push('--base-commit', value);
  for (const value of options.headCommits) args.push('--head-commit', value);
  for (const value of [...new Set(options.sessionIds.filter(Boolean))]) args.push('--session-id', value);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Bug交付记录已更新，但分支联动失败：${String(result.stderr || result.stdout || '').trim()}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function publicPlan(plan) {
  const { content, filePath, ...rest } = plan;
  return rest;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(help());
    return;
  }
  const plan = buildPlan(options);
  let branchSync = null;
  if (options.apply) {
    fs.mkdirSync(path.dirname(plan.filePath), { recursive: true });
    if (plan.changed) fs.writeFileSync(plan.filePath, plan.content, 'utf8');
    branchSync = syncBranch(plan, options);
  }
  const output = { ...publicPlan(plan), branchSync };
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`${options.apply ? '已更新' : 'Bug交付记录预览'}：Bug #${options.bugId}，阶段=${options.phase}`);
    console.log(`交付记录：${plan.relativePath}`);
    console.log(`分支交付联动：${plan.branchSyncPlanned ? (options.apply ? '已执行' : '应用阶段将同步') : '本次未提供完整仓库与分支'}`);
    if (!options.apply) console.log('当前仅为预览，没有写入知识库。');
  }
}

try {
  main();
} catch (error) {
  console.error(`Bug交付记录失败：${error.message}`);
  process.exitCode = 1;
}

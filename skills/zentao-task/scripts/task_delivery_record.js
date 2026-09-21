#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  accountValue,
  defaultOptions,
  getTask,
  normalizeDateTime,
  numericValue,
  objectId,
  readProjectsFolder,
  redactSensitiveText,
} = require('./zentao_cli');

/**
 * 输出命令帮助。
 */
function printHelp() {
  console.log([
    '用法:',
    '  task_delivery_record.js --task <任务ID> --phase <阶段> [选项]',
    '',
    '阶段:',
    '  coding             方案确认后创建交付记录并保存实际编码开始时间',
    '  code-confirmed     代码确认后更新本地 Project Manager 完成事实、时间和工时',
    '  docs-complete      项目管理与上线资料维护完成，并结束本地交付',
    '',
    '选项:',
    '  --vault <目录>              Obsidian vault 根目录，默认当前目录',
    '  --projects-folder <目录>    Project Manager 项目目录，默认读取插件配置',
    '  --real-started <时间>       实际编码开始时间，格式 YYYY-MM-DD HH:mm:ss',
    '  --finished-date <时间>      代码确认时间，格式 YYYY-MM-DD HH:mm:ss',
    '  --event-at <时间>           当前阶段完成时间，格式 YYYY-MM-DD HH:mm:ss',
    '  --repository <路径>         涉及仓库，可重复传入',
    '  --branch <分支>             涉及分支，可重复传入',
    '  --base-commit <提交>        编码前基线提交，可重复传入',
    '  --head-commit <提交>        当前交付提交，可重复传入',
    '  --changed-file <路径>       本次修改文件，可重复传入',
    '  --session-id <会话ID>       关联 Codex 会话，可重复传入；默认读取当前会话环境变量',
    '  --config <文件>             zentao-cli 配置文件',
    '  --cli <文件>                zentao-cli 可执行文件，默认 zentao',
    '  --apply                     实际更新本地知识库；不传时只预览',
    '  --json                      使用 JSON 输出',
    '  -h, --help                  显示帮助',
  ].join('\n'));
}

/**
 * 解析命令参数。
 *
 * @param {string[]} argv 参数数组
 * @returns {object} 选项
 */
function parseArgs(argv) {
  const options = {
    ...defaultOptions(),
    apply: false,
    baseCommits: [],
    branches: [],
    changedFiles: [],
    eventAt: '',
    finishedDate: '',
    headCommits: [],
    phase: '',
    projectsFolder: '',
    realStarted: '',
    repositories: [],
    sessionIds: process.env.CODEX_SESSION_ID ? [process.env.CODEX_SESSION_ID] : [],
    vault: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--task') {
      const value = argv[index + 1];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error('--task 必须提供纯数字 ID');
      }
      options.taskId = value;
      index += 1;
      continue;
    }

    if (['--repository', '--branch', '--base-commit', '--head-commit', '--changed-file', '--session-id'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} 缺少参数值`);
      }
      const keyMap = {
        '--repository': 'repositories',
        '--branch': 'branches',
        '--base-commit': 'baseCommits',
        '--head-commit': 'headCommits',
        '--changed-file': 'changedFiles',
        '--session-id': 'sessionIds',
      };
      options[keyMap[argument]].push(value);
      index += 1;
      continue;
    }

    if (['--phase', '--vault', '--projects-folder', '--real-started', '--finished-date', '--event-at', '--config', '--cli'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} 缺少参数值`);
      }
      const keyMap = {
        '--phase': 'phase',
        '--vault': 'vault',
        '--projects-folder': 'projectsFolder',
        '--real-started': 'realStarted',
        '--finished-date': 'finishedDate',
        '--event-at': 'eventAt',
        '--config': 'config',
        '--cli': 'cli',
      };
      options[keyMap[argument]] = value;
      index += 1;
      continue;
    }

    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`不支持的参数：${argument}`);
  }

  if (options.help) {
    return options;
  }
  if (!options.taskId) {
    throw new Error('必须指定 --task <任务ID>');
  }
  if (!['coding', 'code-confirmed', 'docs-complete'].includes(options.phase)) {
    throw new Error('--phase 不是受支持的交付阶段');
  }
  if (['coding', 'code-confirmed'].includes(options.phase)) {
    options.realStarted = normalizeDateTime(options.realStarted, '--real-started');
  }
  if (options.phase === 'code-confirmed') {
    options.finishedDate = normalizeDateTime(options.finishedDate, '--finished-date');
    if (options.finishedDate < options.realStarted) {
      throw new Error('代码确认时间不能早于实际编码开始时间');
    }
  }
  if (options.phase === 'docs-complete') {
    options.eventAt = normalizeDateTime(options.eventAt, '--event-at');
  }
  return options;
}

/**
 * 递归收集 Markdown 文件。
 *
 * @param {string} directory 目录
 * @returns {string[]} 文件列表
 */
function walkMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * 按禅道任务 ID 唯一定位本地任务文件。
 *
 * @param {string} projectsDirectory 项目目录
 * @param {string} taskId 任务 ID
 * @returns {string} 本地任务文件
 */
function findLocalTaskFile(projectsDirectory, taskId) {
  const pattern = new RegExp(`^  zentaoId:[ \\t]+["']?${taskId}["']?[ \\t]*$`, 'm');
  const matches = walkMarkdownFiles(projectsDirectory).filter((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    return /^pm-task:[ \t]+true$/m.test(content) && pattern.test(content);
  });

  if (matches.length === 0) {
    throw new Error(`知识库中未找到任务 #${taskId}，请先同步所属迭代`);
  }
  if (matches.length > 1) {
    throw new Error(`知识库中发现 ${matches.length} 个任务 #${taskId} 文件，拒绝自动选择`);
  }
  return matches[0];
}

/**
 * 拆分 Markdown Frontmatter。
 *
 * @param {string} content 文件内容
 * @returns {object} Frontmatter 与正文
 */
function splitFrontmatter(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: '', body: String(content || '') };
  }
  return { frontmatter: match[1], body: String(content || '').slice(match[0].length) };
}

/**
 * 渲染 YAML 标量。
 *
 * @param {unknown} value 字段值
 * @returns {string} YAML 文本
 */
function yamlScalar(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`;
  }
  return JSON.stringify(String(value));
}

/**
 * 更新或新增 Frontmatter 顶层字段，保留其他字段排版。
 *
 * @param {string[]} lines Frontmatter 行
 * @param {string} key 字段名
 * @param {unknown} value 字段值
 */
function upsertTopLevel(lines, key, value) {
  const prefix = `${key}:`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  const rendered = `${key}: ${yamlScalar(value)}`;
  if (index >= 0) {
    lines[index] = rendered;
  } else {
    lines.push(rendered);
  }
}

/**
 * 更新或新增 customFields 子字段，保留其他字段排版。
 *
 * @param {string[]} lines Frontmatter 行
 * @param {string} key 字段名
 * @param {unknown} value 字段值
 */
function upsertCustomField(lines, key, value) {
  let sectionIndex = lines.findIndex((line) => line === 'customFields:');
  if (sectionIndex < 0) {
    lines.push('customFields:');
    sectionIndex = lines.length - 1;
  }

  let sectionEnd = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (lines[index] && !/^\s/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const prefix = `  ${key}:`;
  const fieldIndex = lines.findIndex((line, index) => index > sectionIndex && index < sectionEnd && line.startsWith(prefix));
  const rendered = `${prefix} ${yamlScalar(value)}`;
  if (fieldIndex >= 0) {
    lines[fieldIndex] = rendered;
  } else {
    lines.splice(sectionEnd, 0, rendered);
  }
}

/**
 * 按确认结果更新本地 Project Manager 任务。
 *
 * 阶段和状态继续保留禅道当前原始值；代码确认只记录本地完成事实，
 * 禅道任务状态由用户在网页版手工维护。
 *
 * @param {string} content 原文件内容
 * @param {object} values 目标字段
 * @returns {string} 新文件内容
 */
function updateLocalTaskContent(content, values) {
  const split = splitFrontmatter(content);
  if (!split.frontmatter) {
    throw new Error('本地任务文件缺少 Frontmatter');
  }

  const lines = split.frontmatter.split(/\r?\n/);
  upsertTopLevel(lines, 'progress', 100);
  upsertTopLevel(lines, 'completed', values.finishedDate.slice(0, 10));
  upsertCustomField(lines, 'completedBy', values.completedBy);
  upsertCustomField(lines, 'consumedHours', values.consumedHours);
  upsertCustomField(lines, 'remainingHours', 0);
  upsertCustomField(lines, 'actualStartedAt', values.realStarted);
  upsertCustomField(lines, 'actualFinishedAt', values.finishedDate);
  upsertCustomField(lines, 'deliveryStatus', 'manual-zentao');
  return `---\n${lines.join('\n')}\n---\n${split.body}`;
}

/**
 * 生成安全文件名片段。
 *
 * @param {string} value 原始标题
 * @returns {string} 文件名片段
 */
function safeFilePart(value) {
  return String(value || '未命名任务')
    .replace(/<[^>]+>/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || '未命名任务';
}

/**
 * 构造任务交付记录模板。
 *
 * @param {object} context 上下文
 * @returns {string} 文件内容
 */
function renderNewDeliveryNote(context) {
  const frontmatter = [
    '---',
    'type: "zentao-task-delivery"',
    `zentaoTaskId: ${yamlScalar(context.taskId)}`,
    `zentaoExecutionId: ${yamlScalar(context.executionId)}`,
    `zentaoStoryId: ${yamlScalar(context.storyId)}`,
    `task: ${yamlScalar(context.taskLink)}`,
    `project: ${yamlScalar(context.projectLink)}`,
    'workflowStatus: "planned"',
    'codingStartedAt: ""',
    'codeConfirmedAt: ""',
    'documentationCompletedAt: ""',
    'repositories: []',
    'branches: []',
    'baseCommits: []',
    'changedFiles: []',
    '---',
    '',
  ].join('\n');

  const body = [
    `# 禅道任务 #${context.taskId} · ${context.title}`,
    '',
    '## 快速入口',
    '',
    `- 禅道任务：${context.taskLink}`,
    `- Project Manager：${context.projectLink}`,
    `- 本地任务：${context.taskLink}`,
    '',
    '## 需求与验收口径',
    '',
    '## 方案确认记录',
    '',
    '## 实际修改范围',
    '',
    '## 数据流与关键逻辑',
    '',
    '## 操作步骤与注意事项',
    '',
    '## 上线与配置',
    '',
    '### 上线脚本',
    '',
    '### 执行顺序',
    '',
    '### 验证方案',
    '',
    '### 回滚方案',
    '',
    '## 实际交付记录',
    '',
    '## 人工备注',
    '',
  ].join('\n');
  return `${frontmatter}${body}\n`;
}

/**
 * 更新任务交付记录 Frontmatter，正文完全保留。
 *
 * @param {string} content 原文件内容
 * @param {object} fields 目标字段
 * @returns {string} 新文件内容
 */
function updateDeliveryNote(content, fields) {
  const split = splitFrontmatter(content);
  if (!split.frontmatter) {
    throw new Error('任务交付记录缺少 Frontmatter');
  }
  const lines = split.frontmatter.split(/\r?\n/);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      upsertTopLevel(lines, key, value);
    }
  }
  return `---\n${lines.join('\n')}\n---\n${split.body}`;
}

/**
 * 生成文件内容哈希。
 *
 * @param {string} content 内容
 * @returns {string} 哈希
 */
function contentHash(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

/**
 * 构造本地知识库变更计划。
 *
 * @param {object} options 选项
 * @returns {object} 计划
 */
function buildPlan(options) {
  const vault = path.resolve(options.vault);
  const projectsFolder = readProjectsFolder(vault, options.projectsFolder);
  const projectsDirectory = path.resolve(vault, projectsFolder);
  const taskFile = findLocalTaskFile(projectsDirectory, options.taskId);
  const taskFolder = path.dirname(taskFile);
  const isNestedLayout = path.basename(taskFolder) === '01.需求与任务';
  const projectRoot = isNestedLayout ? path.dirname(taskFolder) : taskFolder.slice(0, -'_tasks'.length);
  const projectFile = isNestedLayout
    ? path.join(projectRoot, '00.迭代总览.md')
    : `${projectRoot}.md`;
  if (!fs.existsSync(projectFile)) {
    throw new Error(`未找到任务对应的 Project Manager 项目文件：${projectFile}`);
  }

  const task = getTask(options, options.taskId);
  const deliveryDirectory = isNestedLayout
    ? path.join(projectRoot, '02.项目管理', '任务交付')
    : `${projectRoot}_资料/任务交付`;
  const deliveryFile = path.join(deliveryDirectory, `任务-${options.taskId}-${safeFilePart(task.name)}.md`);
  const taskLink = `[[${path.relative(vault, taskFile).replace(/\.md$/i, '')}|任务 #${options.taskId}]]`;
  const projectLink = `[[${path.relative(vault, projectFile).replace(/\.md$/i, '')}|所属迭代]]`;
  const context = {
    taskId: String(options.taskId),
    executionId: objectId(task.execution),
    storyId: objectId(task.story || task.storyID),
    title: String(task.name || ''),
    taskLink,
    projectLink,
  };

  const existingDelivery = fs.existsSync(deliveryFile)
    ? fs.readFileSync(deliveryFile, 'utf8')
    : renderNewDeliveryNote(context);
  const fields = {
    repositories: options.repositories.length > 0 ? options.repositories : undefined,
    branches: options.branches.length > 0 ? options.branches : undefined,
    baseCommits: options.baseCommits.length > 0 ? options.baseCommits : undefined,
    changedFiles: options.changedFiles.length > 0 ? options.changedFiles : undefined,
  };
  let taskContent = fs.readFileSync(taskFile, 'utf8');

  if (options.phase === 'coding') {
    fields.workflowStatus = 'coding';
    fields.codingStartedAt = options.realStarted;
  } else if (options.phase === 'code-confirmed') {
    const targetConsumed = numericValue(task.consumed) + numericValue(task.left);
    taskContent = updateLocalTaskContent(taskContent, {
      completedBy: String(task.assignedToRealName || accountValue(task.assignedTo)),
      consumedHours: targetConsumed,
      realStarted: options.realStarted,
      finishedDate: options.finishedDate,
    });
    fields.workflowStatus = 'local-completed';
    fields.codingStartedAt = options.realStarted;
    fields.codeConfirmedAt = options.finishedDate;
  } else if (options.phase === 'docs-complete') {
    fields.workflowStatus = 'documented';
    fields.documentationCompletedAt = options.eventAt;
  }

  const deliveryContent = updateDeliveryNote(existingDelivery, fields);
  const changes = [];
  const existingTaskContent = fs.readFileSync(taskFile, 'utf8');
  if (taskContent !== existingTaskContent) {
    changes.push({
      filePath: taskFile,
      relativePath: path.relative(vault, taskFile),
      type: 'update',
      beforeHash: contentHash(existingTaskContent),
      afterHash: contentHash(taskContent),
      content: taskContent,
    });
  }

  const deliveryExists = fs.existsSync(deliveryFile);
  const previousDelivery = deliveryExists ? fs.readFileSync(deliveryFile, 'utf8') : '';
  if (deliveryContent !== previousDelivery) {
    changes.push({
      filePath: deliveryFile,
      relativePath: path.relative(vault, deliveryFile),
      type: deliveryExists ? 'update' : 'create',
      beforeHash: contentHash(previousDelivery),
      afterHash: contentHash(deliveryContent),
      content: deliveryContent,
    });
  }

  return {
    mode: options.apply ? 'apply' : 'preview',
    taskId: String(options.taskId),
    phase: options.phase,
    taskFile: path.relative(vault, taskFile),
    deliveryFile: path.relative(vault, deliveryFile),
    source: {
      title: context.title,
      executionId: context.executionId,
      storyId: context.storyId,
      workflowStatus: fields.workflowStatus || frontmatterValue(existingDelivery, 'workflowStatus') || 'planned',
    },
    branchSyncPlanned: options.repositories.length > 0 && options.branches.length > 0,
    changes,
  };
}

/**
 * 读取简单 Frontmatter 顶层字段。
 *
 * @param {string} content Markdown 内容
 * @param {string} key 字段名
 * @returns {string} 字段值
 */
function frontmatterValue(content, key) {
  const match = String(content || '').match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)`, 'm'));
  return match ? match[1].trim() : '';
}

/**
 * 将任务交付记录投影到独立分支交付中心。
 *
 * 共享脚本只读 Git，并只写 Obsidian 受控区域；同步失败时明确报错，
 * 不回退已经成功写入的任务交付事实。
 *
 * @param {object} plan 已应用的任务交付计划
 * @param {object} options 命令选项
 * @returns {object|null} 分支同步结果
 */
function syncBranchDelivery(plan, options) {
  if (!plan.branchSyncPlanned) {
    return null;
  }
  if (options.repositories.length !== options.branches.length) {
    throw new Error('分支交付同步要求 --repository 与 --branch 数量一致');
  }
  const script = path.join(
    process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'),
    'skills',
    'git-branch-delivery',
    'scripts',
    'branch_delivery_core.js',
  );
  if (!fs.existsSync(script)) {
    throw new Error(`任务交付记录已更新，但缺少分支交付核心脚本：${script}`);
  }
  const args = [
    script,
    'sync-source',
    '--vault', path.resolve(options.vault),
    '--source-type', 'task',
    '--source-id', String(plan.taskId),
    '--title', plan.source.title,
    '--note-path', plan.deliveryFile,
    '--relation', '直接实现',
    '--source-status', plan.source.workflowStatus,
  ];
  if (plan.source.executionId) args.push('--execution-id', plan.source.executionId);
  if (plan.source.storyId) args.push('--story-id', plan.source.storyId);
  for (const repository of options.repositories) args.push('--repository', repository);
  for (const branch of options.branches) args.push('--branch', branch);
  for (const baseCommit of options.baseCommits) args.push('--base-commit', baseCommit);
  for (const headCommit of options.headCommits) args.push('--head-commit', headCommit);
  for (const sessionId of [...new Set(options.sessionIds.filter(Boolean))]) args.push('--session-id', sessionId);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`任务交付记录已更新，但分支交付同步失败：${String(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

/**
 * 应用本地知识库文件变更。
 *
 * @param {object[]} changes 变更
 */
function applyChanges(changes) {
  for (const change of changes) {
    fs.mkdirSync(path.dirname(change.filePath), { recursive: true });
    fs.writeFileSync(change.filePath, change.content, 'utf8');
  }
}

/**
 * 输出变更计划。
 *
 * @param {object} plan 计划
 * @param {boolean} asJson 是否 JSON 输出
 */
function printPlan(plan, asJson) {
  const publicPlan = {
    ...plan,
    changes: plan.changes.map(({ content, filePath, ...change }) => change),
  };
  if (asJson) {
    console.log(JSON.stringify(publicPlan, null, 2));
    return;
  }

  console.log(`${plan.mode === 'apply' ? '已更新' : '本地交付记录预览'}：任务 #${plan.taskId}，阶段=${plan.phase}`);
  console.log(`任务文件：${plan.taskFile}`);
  console.log(`交付记录：${plan.deliveryFile}`);
  console.log(`文件变更：${plan.changes.length}`);
  console.log(`分支交付联动：${plan.branchSyncPlanned ? '应用阶段将同步' : '本次未提供完整仓库与分支'}`);
  for (const change of plan.changes) {
    console.log(`- ${change.type === 'create' ? '新增' : '更新'} ${change.relativePath}`);
  }
  if (plan.mode === 'preview') {
    console.log('当前仅为本地文件预览，没有写入知识库。');
  }
}

/**
 * 程序入口。
 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const plan = buildPlan(options);
  let branchSync = null;
  if (options.apply) {
    applyChanges(plan.changes);
    branchSync = syncBranchDelivery(plan, options);
  }
  plan.branchSync = branchSync;
  printPlan(plan, options.json);
}

try {
  main();
} catch (error) {
  console.error(`任务交付记录失败：${redactSensitiveText(error.message)}`);
  process.exitCode = 1;
}

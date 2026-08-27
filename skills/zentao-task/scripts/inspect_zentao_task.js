#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const {
  accountValue,
  defaultOptions,
  getStory,
  getTask,
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
    '  inspect_zentao_task.js --task <任务ID> [选项]',
    '',
    '选项:',
    '  --vault <目录>              Obsidian vault 根目录，默认当前目录',
    '  --projects-folder <目录>    Project Manager 项目目录，默认读取插件配置',
    '  --config <文件>             zentao-cli 配置文件',
    '  --cli <文件>                zentao-cli 可执行文件，默认 zentao',
    '  --json                      使用 JSON 输出',
    '  -h, --help                  显示帮助',
    '',
    '本脚本只读取禅道和本地文件，不写入任何内容。',
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
    projectsFolder: '',
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

    if (['--vault', '--projects-folder', '--config', '--cli'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} 缺少参数值`);
      }
      const keyMap = {
        '--vault': 'vault',
        '--projects-folder': 'projectsFolder',
        '--config': 'config',
        '--cli': 'cli',
      };
      options[keyMap[argument]] = value;
      index += 1;
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

  if (!options.help && !options.taskId) {
    throw new Error('必须指定 --task <任务ID>');
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
 * 按 customFields.zentaoId 定位本地任务文件。
 *
 * @param {string} projectsDirectory 项目目录
 * @param {string} taskId 任务 ID
 * @returns {string[]} 匹配文件
 */
function findLocalTaskFiles(projectsDirectory, taskId) {
  const pattern = new RegExp(`^  zentaoId:[ \\t]+["']?${taskId}["']?[ \\t]*$`, 'm');
  return walkMarkdownFiles(projectsDirectory).filter((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    return /^pm-task:[ \t]+true$/m.test(content) && pattern.test(content);
  });
}

/**
 * 根据禅道任务标题给出默认代码范围。
 *
 * @param {string} title 任务标题
 * @returns {string} 范围
 */
function inferCodeScope(title) {
  const normalized = String(title || '');
  if (/【\s*前端开发\s*】/.test(normalized)) {
    return 'frontend';
  }
  if (/【\s*后端开发\s*】/.test(normalized)) {
    return 'backend';
  }
  return 'confirm';
}

/**
 * 构造只读检查摘要。
 *
 * @param {object} options 选项
 * @returns {object} 摘要
 */
function inspect(options) {
  const vault = path.resolve(options.vault);
  const projectsFolder = readProjectsFolder(vault, options.projectsFolder);
  const projectsDirectory = path.resolve(vault, projectsFolder);
  const task = getTask(options, options.taskId);
  const storyId = objectId(task.story || task.storyID);
  let story = null;
  let storyWarning = '';

  try {
    story = getStory(options, storyId);
  } catch (error) {
    storyWarning = `关联需求 #${storyId} 读取失败：${redactSensitiveText(error.message)}`;
  }

  const localFiles = findLocalTaskFiles(projectsDirectory, options.taskId);
  const warnings = [];
  if (localFiles.length === 0) {
    warnings.push(`当前知识库尚未找到任务 #${options.taskId}，应先预览同步迭代 #${objectId(task.execution)}`);
  }
  if (localFiles.length > 1) {
    warnings.push(`发现 ${localFiles.length} 个相同禅道 ID 的本地任务文件，必须先处理冲突`);
  }
  if (storyWarning) {
    warnings.push(storyWarning);
  }

  return {
    task: {
      id: String(task.id),
      title: String(task.name || ''),
      status: String(task.status || ''),
      priority: String(task.pri || ''),
      type: String(task.type || ''),
      projectId: objectId(task.project),
      executionId: objectId(task.execution),
      moduleId: objectId(task.module),
      storyId,
      assignedTo: accountValue(task.assignedTo),
      assignedToRealName: String(task.assignedToRealName || ''),
      estimate: numericValue(task.estimate),
      consumed: numericValue(task.consumed),
      remaining: numericValue(task.left),
      estimatedStartedAt: String(task.estStarted || ''),
      actualStartedAt: String(task.realStarted || ''),
      deadline: String(task.deadline || ''),
      actualFinishedAt: String(task.finishedDate || ''),
      lastEditedAt: String(task.lastEditedDate || ''),
    },
    story: story ? {
      id: String(story.id || storyId),
      title: String(story.title || story.name || task.storyTitle || ''),
      status: String(story.status || task.storyStatus || ''),
      stage: String(story.stage || ''),
      specification: String(story.spec || story.storySpec || task.storySpec || ''),
      verification: String(story.verify || story.storyVerify || task.storyVerify || ''),
    } : null,
    local: {
      vault,
      projectsFolder,
      taskFiles: localFiles.map((filePath) => path.relative(vault, filePath)),
    },
    suggestedCodeScope: inferCodeScope(task.name),
    warnings,
  };
}

/**
 * 输出人类可读摘要。
 *
 * @param {object} summary 摘要
 */
function printSummary(summary) {
  const task = summary.task;
  console.log(`禅道任务 #${task.id}：${task.title}`);
  console.log(`状态：${task.status}；指派：${task.assignedToRealName || task.assignedTo || '未指派'}；优先级：${task.priority || '未设置'}`);
  console.log(`项目：#${task.projectId || '未知'}；迭代：#${task.executionId || '未知'}；需求：#${task.storyId || '未关联'}`);
  console.log(`工时：预计 ${task.estimate}h / 已消耗 ${task.consumed}h / 剩余 ${task.remaining}h`);
  console.log(`建议代码范围：${summary.suggestedCodeScope}`);
  if (summary.local.taskFiles.length > 0) {
    console.log(`本地任务文件：${summary.local.taskFiles.join('、')}`);
  }
  for (const warning of summary.warnings) {
    console.log(`警告：${warning}`);
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

  const summary = inspect(options);
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }
}

try {
  main();
} catch (error) {
  console.error(`任务检查失败：${redactSensitiveText(error.message)}`);
  process.exitCode = 1;
}

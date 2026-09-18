#!/usr/bin/env node

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { expandHome, loadRuntimeConfig } = require('./runtime_config');

const RUNTIME_CONFIG = loadRuntimeConfig();
const DEFAULT_CONFIG = expandHome(RUNTIME_CONFIG.zentao?.config)
  || path.join(os.homedir(), '.config', 'zentao', 'zentao.json');
const DEFAULT_CLI = expandHome(RUNTIME_CONFIG.zentao?.cli) || 'zentao';
const DEFAULT_ACCOUNT = String(RUNTIME_CONFIG.zentao?.account || '');
const DEFAULT_SERVER = String(RUNTIME_CONFIG.zentao?.server || '');
const KEYCHAIN_SERVICE = String(RUNTIME_CONFIG.zentao?.keychainService || 'zentao-cli');
const CLI_TIMEOUT_MS = 60000;
const CLI_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 隐去错误文本中可能出现的敏感字段。
 *
 * @param {unknown} value 原始文本
 * @returns {string} 脱敏后的文本
 */
function redactSensitiveText(value) {
  return String(value || '')
    .replace(/("?(?:password|token|secret|session|cookie|zentaosid)"?\s*[:=]\s*)[^,\s}\]]+/gi, '$1***')
    .replace(/([?&](?:password|token|secret|session|zentaosid)=)[^&\s]+/gi, '$1***');
}

/**
 * 从 CLI 输出中提取认证错误码。
 *
 * @param {unknown} value CLI 输出
 * @returns {string} 认证错误码
 */
function findErrorCode(value) {
  const match = String(value || '').match(/"code"\s*:\s*"?(1001|1004)"?/);
  return match ? match[1] : '';
}

/**
 * 以参数数组执行命令，避免经过 shell 展开。
 *
 * @param {string} command 命令
 * @param {string[]} args 参数
 * @param {object} options 进程选项
 * @returns {import('child_process').SpawnSyncReturns<string>} 执行结果
 */
function spawn(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: CLI_MAX_BUFFER,
    ...options,
  });
}

/**
 * 调用禅道 CLI 并解析 JSON，不自动恢复登录。
 *
 * @param {object} options 公共选项
 * @param {string[]} args 禅道 CLI 参数
 * @returns {object} 禅道响应
 */
function rawCliJson(options, args) {
  const cliArgs = [
    '--config', options.config,
    '--machine-readable',
    `--timeout=${CLI_TIMEOUT_MS}`,
    '--format=json',
    ...args,
  ];
  const result = spawn(options.cli, cliArgs);
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;

  if (result.error) {
    throw new Error(`无法执行 zentao-cli：${redactSensitiveText(result.error.message)}`);
  }

  let body;
  try {
    body = JSON.parse(result.stdout || '{}');
  } catch (error) {
    const cliError = new Error(`zentao-cli 返回的不是有效 JSON：${redactSensitiveText(combined.trim() || error.message)}`);
    cliError.authCode = findErrorCode(combined);
    throw cliError;
  }

  if (result.status !== 0 || body.status === 'fail' || body.error) {
    const detail = JSON.stringify(body.error || body.message || body);
    const cliError = new Error(`zentao-cli 调用失败：${redactSensitiveText(detail)}`);
    cliError.authCode = findErrorCode(combined) || findErrorCode(detail);
    throw cliError;
  }

  return body;
}

/**
 * 读取当前 CLI Profile，失败时返回空对象。
 *
 * @param {object} options 公共选项
 * @returns {object} 当前 Profile
 */
function getProfileWithoutRelogin(options) {
  try {
    const body = rawCliJson(options, ['profile']);
    return (body.profiles || []).find((profile) => profile.current) || {};
  } catch (error) {
    return {};
  }
}

/**
 * 通过 macOS 钥匙串恢复禅道 CLI 登录。
 *
 * @param {object} options 公共选项
 */
function restoreLoginFromKeychain(options) {
  const profile = getProfileWithoutRelogin(options);
  const account = profile.account || DEFAULT_ACCOUNT;
  const server = profile.server || DEFAULT_SERVER;

  if (!account || !server) {
    throw new Error('禅道 Profile 和本机 runtime.json 均缺少 server 或 account');
  }
  const securityResult = spawn('security', [
    'find-generic-password',
    '-a', account,
    '-s', KEYCHAIN_SERVICE,
    '-w',
  ]);

  if (securityResult.error || securityResult.status !== 0) {
    throw new Error(`未找到钥匙串服务 ${KEYCHAIN_SERVICE} 中账号 ${account} 的凭据，请先在本机恢复该钥匙串条目`);
  }

  const password = String(securityResult.stdout || '').replace(/[\r\n]+$/, '');
  if (!password) {
    throw new Error(`钥匙串服务 ${KEYCHAIN_SERVICE} 返回了空凭据`);
  }

  const loginResult = spawn(options.cli, [
    '--config', options.config,
    '--machine-readable',
    'login',
    '--useEnv',
  ], {
    env: {
      ...process.env,
      ZENTAO_URL: server,
      ZENTAO_ACCOUNT: account,
      ZENTAO_PASSWORD: password,
    },
  });

  if (loginResult.error || loginResult.status !== 0) {
    throw new Error('禅道自动重新登录失败，请检查服务地址、CLI 配置或本机钥匙串凭据');
  }
}

/**
 * 调用禅道 CLI，认证失效时只允许通过钥匙串恢复一次。
 *
 * @param {object} options 公共选项
 * @param {string[]} args 禅道 CLI 参数
 * @returns {object} 禅道响应
 */
function cliJson(options, args) {
  try {
    return rawCliJson(options, args);
  } catch (error) {
    if (error.authCode !== '1001' && error.authCode !== '1004') {
      throw error;
    }

    restoreLoginFromKeychain(options);
    return rawCliJson(options, args);
  }
}

/**
 * 获取单个禅道任务。
 *
 * @param {object} options 公共选项
 * @param {string} taskId 任务 ID
 * @returns {object} 任务对象
 */
function getTask(options, taskId) {
  const body = cliJson(options, ['task', String(taskId)]);
  if (!body.task || String(body.task.id || '') !== String(taskId)) {
    throw new Error(`未找到禅道任务 #${taskId}`);
  }
  if (!Array.isArray(body.task.actions) && Array.isArray(body.actions)) {
    return { ...body.task, actions: body.actions };
  }
  return body.task;
}

/**
 * 获取单个禅道需求。
 *
 * @param {object} options 公共选项
 * @param {string} storyId 需求 ID
 * @returns {object|null} 需求对象
 */
function getStory(options, storyId) {
  if (!storyId || String(storyId) === '0') {
    return null;
  }

  const body = cliJson(options, ['story', String(storyId)]);
  const story = body.story || body.data || (String(body.id || '') === String(storyId) ? body : null);
  if (story && !Array.isArray(story.actions) && Array.isArray(body.actions)) {
    return { ...story, actions: body.actions };
  }
  return story;
}

/**
 * 从对象或标量中提取禅道对象 ID。
 *
 * @param {unknown} value 原始字段
 * @returns {string} ID
 */
function objectId(value) {
  if (value && typeof value === 'object') {
    return String(value.id || value.value || '');
  }
  return String(value ?? '').trim();
}

/**
 * 从对象或标量中提取禅道账号。
 *
 * @param {unknown} value 原始字段
 * @returns {string} 账号
 */
function accountValue(value) {
  if (value && typeof value === 'object') {
    return String(value.account || '');
  }
  const account = String(value || '');
  return account === 'closed' ? '' : account;
}

/**
 * 转换为有限数值。
 *
 * @param {unknown} value 原始数值
 * @returns {number} 数值
 */
function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * 校验并规范实际时间，保留到秒。
 *
 * @param {unknown} value 时间值
 * @param {string} label 字段名称
 * @returns {string} 规范时间
 */
function normalizeDateTime(value, label) {
  const text = String(value || '').trim().replace('T', ' ').replace(/Z$/, '');
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ \t]+(\d{2}:\d{2})(?::(\d{2}))?)?$/);
  if (!match || !match[2]) {
    throw new Error(`${label} 必须使用 YYYY-MM-DD HH:mm:ss 格式`);
  }
  return `${match[1]} ${match[2]}:${match[3] || '00'}`;
}

/**
 * 构造脚本公共默认选项。
 *
 * @returns {object} 默认选项
 */
function defaultOptions() {
  return {
    cli: DEFAULT_CLI,
    config: DEFAULT_CONFIG,
    json: false,
  };
}

/**
 * 读取 Project Manager 项目目录配置。
 *
 * @param {string} vault Obsidian vault
 * @param {string} explicitFolder 显式目录
 * @returns {string} 项目目录
 */
function readProjectsFolder(vault, explicitFolder) {
  if (explicitFolder) {
    return explicitFolder;
  }

  const dataFile = path.join(vault, '.obsidian', 'plugins', 'project-manager', 'data.json');
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return data.projectsFolder || '04.项目';
  } catch (error) {
    return '04.项目';
  }
}

module.exports = {
  accountValue,
  cliJson,
  defaultOptions,
  getStory,
  getTask,
  normalizeDateTime,
  numericValue,
  objectId,
  readProjectsFolder,
  redactSensitiveText,
};

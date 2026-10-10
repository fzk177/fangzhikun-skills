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

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/("?(?:password|token|secret|session|cookie|zentaosid)"?\s*[:=]\s*)[^,\s}\]]+/gi, '$1***')
    .replace(/([?&](?:password|token|secret|session|zentaosid)=)[^&\s]+/gi, '$1***');
}

function findErrorCode(value) {
  const match = String(value || '').match(/"code"\s*:\s*"?(1001|1004)"?/);
  return match ? match[1] : '';
}

function spawn(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: CLI_MAX_BUFFER,
    ...options,
  });
}

function executableEnvironment(command = '') {
  // GUI 启动的进程可能缺少 Node 的 PATH，保留原客户端的环境补齐行为。
  const currentPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const commandDirectory = path.isAbsolute(command) ? path.dirname(command) : '';
  const executablePath = [...new Set([
    path.dirname(process.execPath),
    commandDirectory,
    ...currentPath,
  ].filter(Boolean))].join(path.delimiter);
  return {
    ...process.env,
    PATH: executablePath,
  };
}

function rawCliJson(options, args, format = 'json') {
  const cliArgs = [
    '--config', options.config,
    '--machine-readable',
    `--timeout=${CLI_TIMEOUT_MS}`,
    `--format=${format}`,
    ...args,
  ];
  const result = spawn(options.cli, cliArgs, { env: executableEnvironment(options.cli) });
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

function getProfileWithoutRelogin(options) {
  try {
    const body = rawCliJson(options, ['profile']);
    return (body.profiles || []).find((profile) => profile.current) || {};
  } catch (error) {
    return {};
  }
}

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
      ...executableEnvironment(options.cli),
      ZENTAO_URL: server,
      ZENTAO_ACCOUNT: account,
      ZENTAO_PASSWORD: password,
    },
  });

  if (loginResult.error || loginResult.status !== 0) {
    throw new Error('禅道自动重新登录失败，请检查服务地址、CLI 配置或本机钥匙串凭据');
  }
}

function readCurrentConfigProfile(options) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(options.config, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取禅道 CLI 配置：${redactSensitiveText(error.message)}`);
  }

  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const configuredProfile = profiles.find((profile) => profile.key === config.currentProfile
    || `${profile.account}@${profile.server}` === config.currentProfile);
  const profile = configuredProfile || profiles.find((item) => item.current) || profiles[0];
  if (!profile || !profile.server || !profile.token) {
    const profileError = new Error('禅道 CLI 当前 Profile 缺少服务地址或认证信息，请先恢复登录');
    profileError.authCode = '1001';
    throw profileError;
  }
  return profile;
}

async function rawApiJson(options, route, data) {
  const profile = readCurrentConfigProfile(options);
  const server = String(profile.server).replace(/\/+$/, '');
  const url = `${server}/api.php/v1/${String(route).replace(/^\/+/, '')}`;
  let response;
  let responseText = '';

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Token: profile.token,
      },
      body: JSON.stringify(data),
      redirect: 'error',
      signal: AbortSignal.timeout(CLI_TIMEOUT_MS),
    });
    responseText = await response.text();
  } catch (error) {
    throw new Error(`禅道 REST API 请求失败：${redactSensitiveText(error.message)}`);
  }

  let body;
  try {
    body = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    const apiError = new Error(`禅道 REST API 返回的不是有效 JSON：${redactSensitiveText(error.message)}`);
    apiError.authCode = response.status === 401 || response.status === 403
      ? '1001'
      : findErrorCode(responseText);
    throw apiError;
  }

  if (!response.ok || body.status === 'fail' || body.error) {
    const detail = JSON.stringify(body.error || body.message || body);
    const apiError = new Error(`禅道 REST API 调用失败：${redactSensitiveText(detail)}`);
    apiError.authCode = response.status === 401 || response.status === 403
      ? '1001'
      : findErrorCode(detail);
    throw apiError;
  }
  return body;
}

module.exports = {
  DEFAULT_CONFIG, DEFAULT_CLI, rawCliJson, rawApiJson, restoreLoginFromKeychain,
  readCurrentConfigProfile, redactSensitiveText, spawn, executableEnvironment, CLI_TIMEOUT_MS,
};

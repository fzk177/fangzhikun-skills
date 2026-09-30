#!/usr/bin/env node
'use strict';

const { fs, path, emit, redact, resolveEnvironment, locateCli, configPath } = require('./common.js');
const { storeCredential, ensureSession } = require('./authentication.js');
const { runControlled, pending, decide } = require('./guard.js');

// 官方 CLI 的输出仍可能包含业务对象；凭证字段及本进程已知秘密始终脱敏。
for (const name of ['log', 'error', 'warn', 'info']) {
  const original = console[name].bind(console);
  console[name] = (...values) => original(...values.map(value => {
    if (typeof value === 'string') {
      try { return JSON.stringify(redact(JSON.parse(value)), null, 2); }
      catch { return redact(value); }
    }
    return redact(value);
  }));
}

function parse(argumentsList) {
  const separator = argumentsList.indexOf('--');
  const wrapper = separator < 0 ? argumentsList : argumentsList.slice(0, separator);
  const args = separator < 0 ? [] : argumentsList.slice(separator + 1);
  const command = wrapper.shift();
  const options = {};
  for (let index = 0; index < wrapper.length; index++) {
    const flag = wrapper[index];
    if (flag === '--replace') { options.replace = true; continue; }
    if (!['--env', '--purpose', '--impact', '--job', '--hash', '--decision'].includes(flag) || !wrapper[index + 1] || wrapper[index + 1].startsWith('--')) throw new Error('入口参数不合法');
    const name = flag.slice(2);
    if (options[name] !== undefined) throw new Error('入口参数不能重复');
    options[name] = wrapper[++index];
  }
  return { command, options, args };
}

async function stdinRecord() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16384) throw new Error('凭证录入过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('需要 Node.js 18 或以上');
  const { command, options, args } = parse(process.argv.slice(2));
  if (!command || ['help', '--help', '-h'].includes(command)) {
    emit({ commands: ['info', 'auth --env dev|pre|prod', 'run --env dev|pre|prod [--purpose 内容 --impact 范围] -- 官方CLI参数', 'pending --job 任务ID', 'approve --job 任务ID --hash 完整哈希 --decision allow|deny'], credentialEnrollment: '由用户在本机运行 python3 scripts/enroll.py --env pre|prod' });
    return;
  }
  if (command === 'pending') return pending(options.job);
  if (command === 'approve') return decide(options.job, options.hash, options.decision);
  if (command === 'info') {
    const environments = ['pre', 'prod'].map(alias => resolveEnvironment(alias));
    const cli = locateCli(environments[0]);
    emit({ configured: true, configFile: configPath, cliVersion: cli.version, environments: environments.map(environment => ({ environment: environment.alias, physicalEnvironment: environment.physical, baseUrl: environment.baseUrl, passportUrl: environment.passportUrl })), authentication: '仅检查非秘密配置；未读取钥匙串或登录' });
    return;
  }
  const environment = resolveEnvironment(options.env);
  const cli = locateCli(environment);
  if (command === 'credential-store') {
    await storeCredential(environment, cli, await stdinRecord(), Boolean(options.replace));
    emit({ event: 'credential_saved', environment: environment.alias, physicalEnvironment: environment.physical, storage: 'macOS Keychain', oldSessionInvalidated: true });
    return;
  }
  if (command === 'auth') {
    await ensureSession(environment, cli, { loginAttempted: false });
    emit({ event: 'authenticated', environment: environment.alias, physicalEnvironment: environment.physical, cliVersion: cli.version });
    return;
  }
  if (command === 'run') {
    if (!args.length) throw new Error('run 的 -- 后必须提供官方 CLI 命令');
    return runControlled(environment, cli, args, options.purpose, options.impact);
  }
  throw new Error('未知的 Weaver 入口操作');
}

main().catch(error => {
  // 不回显堆栈、原始 HTTP 响应或钥匙串数据。
  emit({ event: 'stopped', reason: redact(error instanceof Error ? error.message : '操作未完成') });
  process.exitCode = 1;
});

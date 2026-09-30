'use strict';

const { pathToFileURL } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const { fs, path, crypto, digest, losslessJson, emit, readJson, writeJson, privateDirectory, resolveEnvironment, cliFingerprint, wrapperFingerprint, jobDirectory, loadPolicy, matchesReadOnlyRule, redact } = require('./common.js');
const { dependencies, ensureSession, checkSession } = require('./authentication.js');
const { parseReadCommand, runWorkflowRead } = require('./workflow-read.js');
const nativeFetch = globalThis.fetch.bind(globalThis);

function assertUnchanged(context) {
  if (resolveEnvironment(context.environment.alias).configDigest !== context.environment.configDigest) throw new Error('环境配置已变化，原审核失效');
  if (loadPolicy().fingerprint !== context.policy.fingerprint) throw new Error('请求策略已变化，原审核失效');
  if (cliFingerprint(context.cli) !== context.cliDigest) throw new Error('官方 CLI 代码已变化，原审核失效');
  if (wrapperFingerprint() !== context.wrapperDigest) throw new Error('Weaver 执行源码已变化，原审核失效');
}

function prepareApproval(context, detail, bodyHash) {
  assertUnchanged(context);
  context.sequence += 1;
  const plan = {
    schemaVersion: 1, jobId: context.jobId, sequence: context.sequence,
    environment: context.environment.alias, physicalEnvironment: context.environment.physical,
    configDigest: context.environment.configDigest, cliDigest: context.cliDigest, wrapperDigest: context.wrapperDigest,
    policyDigest: context.policy.fingerprint, cliVersion: context.cli.version,
    actor: context.sessionData.userId,
    command: context.args,
    purpose: context.purpose?.trim() || '当前命令包含待用户判定的请求：' + context.args.join(' '),
    impact: context.impact?.trim() || (detail.kind === 'oa-request' ? '接口 ' + detail.path + '；对象与参数见审核单，实际副作用待用户判断' : '本机目标 ' + detail.target + '；写入内容与摘要见审核单'),
    detail, bodyHash,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + context.environment.approvalTimeoutSeconds * 1000).toISOString(),
  };
  plan.requestHash = digest(JSON.stringify(plan));
  const pendingFile = path.join(context.directory, 'pending.json');
  // 只把脱敏预览写入磁盘，真实 body 仍冻结在运行进程的内存中。
  writeJson(pendingFile, { ...redact(plan), status: 'pending' });
  emit({ event: 'approval_required', ...plan, previouslySentWrites: context.sentWrites, pendingFile });
  return { plan, pendingFile, decisionFile: path.join(context.directory, plan.requestHash + '.decision.json') };
}

function consumeDecision(context, prepared) {
  const { plan, pendingFile, decisionFile } = prepared;
  if (!fs.existsSync(decisionFile)) return false;
  const decision = readJson(decisionFile);
  if (decision.jobId !== context.jobId || decision.requestHash !== plan.requestHash || !['allow', 'deny'].includes(decision.decision)) throw new Error('审核决定与当前请求不一致');
  if (decision.decision === 'deny') {
    writeJson(pendingFile, { ...redact(plan), status: 'denied' });
    throw new Error('用户拒绝当前操作；未发送当前请求，不回滚之前写入');
  }
  assertUnchanged(context);
  writeJson(pendingFile, { ...redact(plan), status: 'consumed', consumedAt: new Date().toISOString() });
  return true;
}

async function approval(context, detail, bodyHash) {
  const prepared = prepareApproval(context, detail, bodyHash);
  const { plan, pendingFile } = prepared;
  while (Date.now() < Date.parse(plan.expiresAt)) {
    if (consumeDecision(context, prepared)) return plan;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  writeJson(pendingFile, { ...redact(plan), status: 'expired' });
  throw new Error('逐项审核超时，当前请求未发送');
}

function approvalSync(context, detail, bodyHash) {
  const prepared = prepareApproval(context, detail, bodyHash);
  const { plan, pendingFile } = prepared;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < Date.parse(plan.expiresAt)) {
    if (consumeDecision(context, prepared)) return plan;
    Atomics.wait(sleeper, 0, 0, 500);
  }
  writeJson(pendingFile, { ...redact(plan), status: 'expired' });
  throw new Error('本机写入审核超时，未执行当前文件操作');
}

function guardLocalWrites(context) {
  const nodeFs = require('node:fs');
  let authorizedDepth = 0;
  const methods = ['writeFileSync', 'appendFileSync', 'copyFileSync', 'cpSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'chmodSync', 'truncateSync', 'symlinkSync', 'linkSync', 'createWriteStream'];
  for (const name of methods) {
    const original = nodeFs[name];
    nodeFs[name] = (...args) => {
      const targetIndex = ['copyFileSync', 'cpSync', 'symlinkSync', 'linkSync'].includes(name) ? 1 : 0;
      if (typeof args[targetIndex] === 'number') throw new Error('无法核实文件描述符的写入目标，已阻止');
      const target = path.resolve(String(args[targetIndex]));
      // 不允许官方 CLI 接触本 Skill 的审核文件。
      if (target === context.directory || target.startsWith(context.directory + path.sep)) throw new Error('官方 CLI 不得写入 Weaver 审核状态目录');
      const content = ['writeFileSync', 'appendFileSync'].includes(name) && (typeof args[1] === 'string' || Buffer.isBuffer(args[1])) ? args[1] : JSON.stringify(args.map(value => typeof value === 'function' ? '[callback]' : value));
      approvalSync(context, { kind: 'local-write', operation: name, target, source: targetIndex ? String(args[0]) : null, contentSha256: digest(content || '') }, digest(content || ''));
      authorizedDepth += 1;
      try { return original(...args); }
      finally { authorizedDepth -= 1; }
    };
  }
  const unsupported = () => { throw new Error('发现未登记的异步本机写入，已阻止；需先受控扩展文件审核入口'); };
  for (const name of ['writeFile', 'appendFile', 'copyFile', 'cp', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'chmod', 'truncate', 'symlink', 'link', 'write', 'writeSync', 'ftruncate', 'ftruncateSync', 'fchmod', 'fchmodSync', 'open']) {
    if (!nodeFs[name]) continue;
    const original = nodeFs[name];
    nodeFs[name] = (...args) => authorizedDepth > 0 ? original(...args) : unsupported();
  }
  const originalOpen = nodeFs.openSync;
  nodeFs.openSync = (file, flags, ...rest) => {
    const writes = typeof flags === 'string' ? /[wa+]/.test(flags) : (flags & (nodeFs.constants.O_WRONLY | nodeFs.constants.O_RDWR | nodeFs.constants.O_CREAT | nodeFs.constants.O_TRUNC | nodeFs.constants.O_APPEND)) !== 0;
    if (writes && authorizedDepth === 0) unsupported();
    return originalOpen(file, flags, ...rest);
  };
  for (const name of ['writeFile', 'appendFile', 'copyFile', 'cp', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'chmod', 'truncate', 'symlink', 'link', 'open']) if (nodeFs.promises[name]) nodeFs.promises[name] = unsupported;
  syncBuiltinESMExports();
}

async function summarizeBody(request) {
  const raw = Buffer.from(await request.clone().arrayBuffer());
  const contentType = request.headers.get('content-type') || '';
  if (!raw.length) return { preview: null, bodyHash: digest(raw) };
  if (contentType.includes('multipart/form-data')) {
    const form = await request.clone().formData();
    const parts = [];
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') parts.push({ name, value });
      else parts.push({ name, fileName: value.name, size: value.size, sha256: digest(Buffer.from(await value.arrayBuffer())) });
    }
    return { preview: parts, bodyHash: digest(raw) };
  }
  const text = raw.toString('utf8');
  if (raw.length > 256000) return { preview: { size: raw.length, sha256: digest(raw), note: '大正文需在批准前检查原业务输入材料' }, bodyHash: digest(raw) };
  let preview;
  try { preview = JSON.parse(text); }
  catch { preview = contentType.includes('application/x-www-form-urlencoded') ? Array.from(new URLSearchParams(text).entries()) : text; }
  return { preview, bodyHash: digest(raw) };
}

function blockAlternativeTransports() {
  const stop = () => { throw new Error('拒绝未受控的 HTTP 通道或子进程；请通过已登记的官方原生请求入口操作'); };
  for (const moduleName of ['node:http', 'node:https']) {
    const module = require(moduleName); module.request = stop; module.get = stop;
  }
  const childProcess = require('node:child_process');
  for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) childProcess[name] = stop;
  syncBuiltinESMExports();
}

function rejectCredentialsInArguments(args) {
  const forbidden = ['--auth', '--profile', '--base-url', '--passport-url', '--eteamsid', '--password', '--account', '--token'];
  if (args.some(arg => forbidden.some(flag => arg === flag || arg.startsWith(flag + '=')))) throw new Error('禁止覆盖环境或从 CLI 参数传入认证凭证');
}

async function runControlled(environment, cli, args, purpose, impact) {
  rejectCredentialsInArguments(args);
  const readCommand = parseReadCommand(args);
  const commandGroup = args[0] === '--json' ? args[1] : args[0];
  if (!['form', 'wf-form', 'workflow', 'app', 'menu', 'page', 'designer', 'role', 'user', 'matrix', 'actionflow', 'interface', 'project', 'icon'].includes(commandGroup)) throw new Error('此入口仅运行官方原生 OA 命令；本机编码、编译和管理动作需按 Skill 规则另行批准');
  const authentication = { loginAttempted: false };
  const sessionData = await ensureSession(environment, cli, authentication);
  const policy = loadPolicy();
  const context = {
    jobId: crypto.randomUUID(), sequence: 0, sentWrites: 0, environment, cli, args,
    purpose, impact, policy, cliDigest: cliFingerprint(cli), wrapperDigest: wrapperFingerprint(), sessionData, authentication,
  };
  context.directory = jobDirectory(context.jobId);
  privateDirectory(context.directory);
  writeJson(path.join(context.directory, 'job.json'), { jobId: context.jobId, pid: process.pid, environment: environment.alias, status: 'running', startedAt: new Date().toISOString() });
  process.once('exit', code => {
    writeJson(path.join(context.directory, 'job.json'), { jobId: context.jobId, pid: process.pid, environment: environment.alias, status: 'process-ended', exitCode: code, sentWrites: context.sentWrites, endedAt: new Date().toISOString() });
  });
  emit({ event: 'connected', jobId: context.jobId, environment: environment.alias, physicalEnvironment: environment.physical, cliVersion: cli.version });

  // 这类命令由官方实现同步写本机文件，不能仅靠 OA 请求守卫判定已授权。
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--out' || args[index].startsWith('--out=')) {
      const target = args[index].includes('=') ? args[index].slice(6) : args[index + 1];
      if (!target) throw new Error('--out 缺少输出文件');
    }
  }
  // 文件写入仍在实际 writeFileSync 时审核，不能用 --out 提前一次性放行内容未知的文件。

  const { AuthSession } = await dependencies(cli);
  const session = new AuthSession(context.sessionData);
  AuthSession.fromOptions = async () => session;
  session.fetchEmployeeId = async () => {};
  session.save = () => { throw new Error('禁止官方 CLI 把本次内存会话写入磁盘'); };
  session.rsaLogin = async () => { throw new Error('业务执行阶段禁止绕过钥匙串认证器'); };
  session.ensureValid = async () => false;
  const { ApiClient } = await import(pathToFileURL(path.join(cli.root, 'dist', 'core', 'client.js')).href);
  const originalRequestRaw = ApiClient.prototype.requestRaw;
  ApiClient.prototype.requestRaw = async function (...parameters) {
    this.retries = 1;
    if (readCommand) {
      const response = await globalThis.fetch(...parameters);
      if (!response.ok) throw new Error('流程查询返回 HTTP ' + response.status);
      return losslessJson(await response.text());
    }
    return originalRequestRaw.apply(this, parameters);
  };
  delete process.env.E10_ACCOUNT; delete process.env.E10_PASSWORD; delete process.env.E10_AUTH_PATH;

  globalThis.fetch = async (input, init = {}) => {
    const request = new Request(input, { ...init, redirect: 'manual' });
    const url = new URL(request.url);
    if (url.origin !== environment.baseUrl || url.username || url.password) throw new Error('拒绝访问当前 OA 环境之外的业务地址');
    const body = await summarizeBody(request);
    const matchedRule = policy.rules.find(rule => matchesReadOnlyRule(rule, request.method, url, body.preview));
    const operationName = url.pathname.split('/').filter(Boolean).at(-1) || '';
    const queryNamed = Boolean(policy.queryName?.match.test(operationName));
    const readonly = Boolean(matchedRule) || queryNamed;
    const allowReason = matchedRule ? 'registered-read-rule' : queryNamed ? 'query-name' : 'user-decision-required';
    const extraHeaders = Object.fromEntries(Array.from(request.headers).filter(([key]) => !/cookie|eteamsid|authorization/i.test(key)));
    const detail = { kind: 'oa-request', method: request.method, path: url.pathname, operationName, query: Array.from(url.searchParams.entries()), headers: extraHeaders, body: body.preview, readonly, allowReason };
    let plan = null;
    if (!readonly) {
      plan = await approval(context, detail, body.bodyHash);
    }
    // 审批等待期间会话可能失效。先只读校验；失效重登后禁止复用不同身份的批准。
    if (plan) {
      const renewed = await ensureSession(environment, cli, authentication);
      if (renewed.userId !== plan.actor) throw new Error('认证身份变化，当前批准失效且请求未发送');
      context.sessionData = renewed; session.data = renewed;
    }
    const headers = new Headers(request.headers);
    headers.delete('cookie'); headers.delete('authorization');
    headers.set('eteamsid', context.sessionData.cookies.ETEAMSID);
    const bytes = Buffer.from(await request.clone().arrayBuffer());
    const frozenInit = { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : bytes, redirect: 'manual', signal: AbortSignal.timeout(30000) };
    const observation = matchedRule?.observe || (queryNamed && !matchedRule && policy.queryName.observe) ? {
      observationId: crypto.randomUUID(), environment: environment.alias, method: request.method,
      path: url.pathname, operationName, allowReason, query: detail.query, body: body.preview, bodyHash: body.bodyHash,
      basis: '用户明确允许查询名称直接放行及指定接口先放行并观察；服务端副作用尚未独立验证', startedAt: new Date().toISOString(),
    } : null;
    const observationFile = observation ? path.join(context.directory, observation.observationId + '.observation.json') : null;
    if (observation) writeJson(observationFile, { ...redact(observation), status: 'sending' });
    let response;
    try {
      if (plan) {
        assertUnchanged(context);
        context.sentWrites += 1;
        writeJson(path.join(context.directory, plan.requestHash + '.result.json'), { requestHash: plan.requestHash, status: 'sending', startedAt: new Date().toISOString() }, true);
      }
      response = await nativeFetch(request.url, frozenInit);
    } catch {
      if (observation) writeJson(observationFile, { ...redact(observation), status: 'connection-failed', note: '连接失败不能判断是否存在服务端副作用' });
      if (plan) writeJson(path.join(context.directory, plan.requestHash + '.result.json'), { requestHash: plan.requestHash, status: 'unknown', note: '请求可能已生效；先只读核对，禁止自动重放' });
      throw new Error(readonly ? '只读请求连接失败' : '写请求结果不明，未自动重试；先只读核对远端状态');
    }
    if (plan) writeJson(path.join(context.directory, plan.requestHash + '.result.json'), { requestHash: plan.requestHash, status: 'response-received', httpStatus: response.status, note: '收到响应不代表业务成功，需按具体接口回读核对' });
    let expired = [401, 302, 303, 307, 308].includes(response.status);
    if (readonly && !expired && response.status === 200) {
      const preview = await response.clone().json().catch(() => null);
      if (!preview || preview.code === -1 || preview.code === 401 || preview.errcode === 'SESSION_EXPIRED') expired = !(await checkSession(environment, context.sessionData));
    }
    if (expired) {
      if (observation) writeJson(observationFile, { ...redact(observation), status: 'authentication-expired', httpStatus: response.status, note: '会话续期前收到认证异常；不能据此判断副作用' });
      if (!readonly) throw new Error('写请求返回认证或跳转响应，未自动重放；需要重新认证并核对远端状态');
      const renewed = await ensureSession(environment, cli, authentication, true);
      if (renewed.userId !== context.sessionData.userId) throw new Error('续期后身份变化，停止当前读取');
      context.sessionData = renewed; session.data = renewed;
      headers.set('eteamsid', renewed.cookies.ETEAMSID);
      try {
        response = await nativeFetch(request.url, { ...frozenInit, headers, signal: AbortSignal.timeout(30000) });
      } catch {
        if (observation) writeJson(observationFile, { ...redact(observation), status: 'renewed-read-failed', note: '会话续期后的读取连接失败；不能据此判断副作用' });
        throw new Error('续期后的读取连接失败；未继续重试');
      }
      if (response.status !== 200) throw new Error('续期后的读取仍未成功；未继续重试');
    }
    if (observation) {
      const responseBytes = Buffer.from(await response.clone().arrayBuffer());
      let observedResponse;
      try { observedResponse = losslessJson(responseBytes.toString('utf8')); } catch { observedResponse = null; }
      const identifiers = {};
      for (const key of ['mapBaseId', 'conditionKey', 'reserveGroupId']) {
        const value = observedResponse?.data?.[key];
        if (['string', 'number'].includes(typeof value)) identifiers[key] = String(value);
      }
      const result = { ...redact(observation), status: 'response-received', httpStatus: response.status,
        businessCode: observedResponse?.code, businessStatus: observedResponse?.status,
        identifiers, responseHash: digest(responseBytes), completedAt: new Date().toISOString(),
        note: '响应正常不证明无副作用；返回 ID 也不单独证明产生了持久写入' };
      writeJson(observationFile, result);
      emit({ event: 'readonly_observation', observationId: observation.observationId, environment: environment.alias,
        path: url.pathname, operationName, allowReason, httpStatus: response.status, businessCode: result.businessCode, identifiers, observationFile });
    }
    return response;
  };
  blockAlternativeTransports();
  guardLocalWrites(context);
  if (readCommand) {
    return runWorkflowRead(readCommand, new ApiClient(session, 1), environment.baseUrl);
  }
  process.argv = [process.execPath, path.join(cli.root, 'dist', 'index.js'), ...args];
  await import(pathToFileURL(path.join(cli.root, 'dist', 'index.js')).href);
}

function pending(jobId) {
  const file = path.join(jobDirectory(jobId), 'pending.json');
  const plan = readJson(file);
  emit(plan);
}

function decide(jobId, requestHash, decision) {
  if (!/^[a-f0-9]{64}$/.test(requestHash) || !['allow', 'deny'].includes(decision)) throw new Error('必须指定完整计划哈希及 allow/deny 决定');
  const directory = jobDirectory(jobId);
  const plan = readJson(path.join(directory, 'pending.json'));
  const job = readJson(path.join(directory, 'job.json'));
  if (job.status !== 'running') throw new Error('执行进程已结束，不能批准旧请求');
  try { process.kill(job.pid, 0); } catch { throw new Error('执行进程已不存在，不能批准旧请求'); }
  if (plan.status !== 'pending' || plan.jobId !== jobId || plan.requestHash !== requestHash || Date.now() >= Date.parse(plan.expiresAt)) throw new Error('当前请求不存在、已处理或已过期，未放行');
  if (resolveEnvironment(plan.environment).configDigest !== plan.configDigest || loadPolicy().fingerprint !== plan.policyDigest) throw new Error('配置或请求策略已变化，未放行');
  const cli = locateCli(resolveEnvironment(plan.environment));
  if (cliFingerprint(cli) !== plan.cliDigest || wrapperFingerprint() !== plan.wrapperDigest) throw new Error('执行源码已变化，未放行');
  writeJson(path.join(directory, requestHash + '.decision.json'), { jobId, requestHash, decision, decidedAt: new Date().toISOString() }, true);
  emit({ event: 'decision_recorded', jobId, requestHash, decision });
}

module.exports = { runControlled, pending, decide };

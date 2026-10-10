'use strict';

const {
  DEFAULT_CONFIG, DEFAULT_CLI, rawCliJson, restoreLoginFromKeychain,
  readCurrentConfigProfile, redactSensitiveText, spawn, CLI_TIMEOUT_MS,
} = require('./zentao_transport');

// 只读入口不接受任意子命令或写入参数。
function assertReadArgs(args) {
  const profile = args.length === 1 && args[0] === 'profile';
  const detail = args.length === 2 && ['task', 'story', 'bug'].includes(args[0])
    && /^\d+$/.test(String(args[1]));
  if (!profile && !detail) throw new Error('禅道只读客户端拒绝当前命令');
}

function readJson(options, args, format = 'json') {
  assertReadArgs(args);
  try {
    return rawCliJson(options, args, format);
  } catch (error) {
    if (!['1001', '1004'].includes(error.authCode)) throw error;
    restoreLoginFromKeychain(options);
    return rawCliJson(options, args, format);
  }
}

function cliJson(options, args) {
  return readJson(options, args);
}

function normalizeBugEnvelope(body, bugId) {
  const bug = body?.bug || body?.data || (String(body?.id || '') === String(bugId) ? body : null);
  if (!bug || String(bug.id || '') !== String(bugId)) throw new Error(`未找到禅道 Bug #${bugId}`);
  return { bug, actions: Array.isArray(body.actions) ? body.actions : (Array.isArray(bug.actions) ? bug.actions : []) };
}

function getBugEnvelope(options, bugId) {
  const body = readJson(options, ['bug', String(bugId)], 'raw');
  normalizeBugEnvelope(body, bugId);
  return body;
}

function getBug(options, bugId) {
  const { bug, actions } = normalizeBugEnvelope(getBugEnvelope(options, bugId), bugId);
  return { ...bug, actions };
}

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

function getStory(options, storyId) {
  if (storyId && String(storyId) !== '0' && !/^\d+$/.test(String(storyId))) {
    throw new Error('需求 ID 必须为纯数字');
  }
  if (!storyId || String(storyId) === '0') {
    return null;
  }

  const body = cliJson(options, ['story', String(storyId)]);
  const story = body.story || body.data || (String(body.id || '') === String(storyId) ? body : null);
  if (story && String(story.id || '') !== String(storyId)) {
    throw new Error(`需求查询返回的 ID 与 #${storyId} 不一致`);
  }
  if (story && !Array.isArray(story.actions) && Array.isArray(body.actions)) {
    return { ...story, actions: body.actions };
  }
  if (story && Array.isArray(story.actions)) return story;

  // CLI 的对象输出会丢弃顶层 actions，直接回读已核实的 v2 详情入口。
  try {
    return readStoryWithActions(options, storyId);
  } catch (error) {
    if (error.authCode !== '1001' && error.authCode !== '1004') throw error;
    restoreLoginFromKeychain(options);
    return readStoryWithActions(options, storyId);
  }
}

function readStoryWithActions(options, storyId) {
  const profile = readCurrentConfigProfile(options);
  const url = `${String(profile.server).replace(/\/+$/, '')}/api.php/v2/stories/${encodeURIComponent(storyId)}`;
  const result = spawn('curl', [
    '--silent', '--show-error', '--max-time', String(Math.ceil(CLI_TIMEOUT_MS / 1000)),
    '--request', 'GET', '--header', '@-', '--write-out', '\n%{http_code}', url,
  ], { input: `Token: ${profile.token}\nContent-Type: application/json\n` });
  if (result.error || result.status !== 0) {
    throw new Error(`需求详情查询失败：${redactSensitiveText(result.stderr || result.error?.message || '')}`);
  }
  const output = String(result.stdout || '');
  const separator = output.lastIndexOf('\n');
  const status = Number(output.slice(separator + 1));
  if (status === 401 || status === 403) {
    const error = new Error('需求详情查询认证失效');
    error.authCode = '1004';
    throw error;
  }
  if (status < 200 || status >= 300) throw new Error(`需求详情查询失败（HTTP ${status}）`);
  let body;
  try { body = JSON.parse(output.slice(0, separator)); }
  catch (error) { throw new Error('需求详情未返回有效 JSON'); }
  if (body.status === 'fail' || body.error || String(body.story?.id || '') !== String(storyId)) {
    throw new Error(`需求 #${storyId} 详情回读失败`);
  }
  if (!Array.isArray(body.actions)) throw new Error(`需求 #${storyId} 未返回操作记录，不能进入完成写入`);
  return { ...body.story, actions: body.actions };
}

function objectId(value) {
  if (value && typeof value === 'object') {
    return String(value.id || value.value || '');
  }
  return String(value ?? '').trim();
}

function accountValue(value) {
  if (value && typeof value === 'object') {
    return String(value.account || '');
  }
  const account = String(value || '');
  return account === 'closed' ? '' : account;
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function defaultOptions() {
  return {
    cli: DEFAULT_CLI,
    config: DEFAULT_CONFIG,
    json: false,
  };
}

module.exports = {
  accountValue, cliJson, defaultOptions, getBug, getBugEnvelope, normalizeBugEnvelope,
  getStory, getTask, numericValue, objectId, redactSensitiveText,
};

'use strict';

// 仅供调用方的已确认计划使用；此模块不提供独立写入命令。
const { rawCliJson, rawApiJson, restoreLoginFromKeychain } = require('./zentao_transport');

function assertWriteArgs(args) {
  const [type, action, id, dataArg] = args;
  const allowed = type === 'task' && ['start', 'finish', 'update'].includes(action)
    || type === 'story' && action === 'update';
  if (!allowed || args.length !== 4 || !/^\d+$/.test(String(id))
    || typeof dataArg !== 'string' || !dataArg.startsWith('--data=')) {
    throw new Error('禅道写入适配器拒绝当前命令');
  }
  const data = JSON.parse(dataArg.slice('--data='.length));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('写入参数必须为对象');
  if (type === 'story' && (Object.keys(data).length !== 1 || typeof data.comment !== 'string')) {
    throw new Error('需求写入仅允许新增备注');
  }
}

function authFailure(options, error) {
  if (['1001', '1004'].includes(error.authCode)) {
    restoreLoginFromKeychain(options);
    throw new Error('写入遇到认证失效，已恢复登录但未重新发送写请求；必须只读回读并重新预览确认');
  }
  throw error;
}

function writeCliJson(options, args) {
  assertWriteArgs(args);
  try {
    return rawCliJson(options, args);
  } catch (error) {
    return authFailure(options, error);
  }
}

async function assignTask(options, taskId, data) {
  if (!/^\d+$/.test(String(taskId)) || !data || typeof data.assignedTo !== 'string'
    || !data.assignedTo || ('comment' in data && typeof data.comment !== 'string')
    || Object.keys(data).some(key => !['assignedTo', 'comment'].includes(key))) {
    throw new Error('任务指派参数不合法');
  }
  try {
    return await rawApiJson(options, `tasks/${taskId}/assignto`, data);
  } catch (error) {
    return authFailure(options, error);
  }
}

module.exports = { assignTask, writeCliJson };

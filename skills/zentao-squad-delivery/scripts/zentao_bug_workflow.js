#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  accountValue, cliJson, defaultOptions, getBugEnvelope, normalizeBugEnvelope, objectId,
} = require('../../zentao-base/scripts/zentao_client');
const { resolveBug } = require('../../zentao-base/scripts/zentao_write');

const CALLER = 'zentao-squad-delivery';
const PLAN_DIRECTORY = path.join(os.tmpdir(), `zentao-squad-bug-${process.getuid()}`);
const HEADINGS = ['问题原因', '修改内容', '验收口径', '其他影响'];

// 排序对象键，避免响应键序变化产生不同的计划；数组顺序仍参与校验。
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function serialized(value) { return JSON.stringify(canonical(value)); }
function digest(value) { return crypto.createHash('sha256').update(serialized(value)).digest('hex'); }

function validateComment(comment) {
  const matches = [...comment.matchAll(/^(问题原因|修改内容|验收口径|其他影响)[：:]\s*/gm)];
  if (matches.length !== 4 || matches.some((match, index) => match[1] !== HEADINGS[index])
    || comment.slice(0, matches[0].index).trim()) {
    throw new Error('备注必须依次包含问题原因、修改内容、验收口径、其他影响四段');
  }
  matches.forEach((match, index) => {
    const section = comment.slice(match.index + match[0].length, matches[index + 1]?.index).trim();
    const items = section.split('\n').map(line => line.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean);
    const meaningful = items.some(item => index === 3 && /^无其他已知影响[。！!]?$/.test(item)
      || !/^(?:无|暂无|无影响|无其他影响|无已知影响|无其他已知影响|待补充|待确认|同上|功能优化|完成需求)[。；;！!]?$/i.test(item));
    if (!meaningful) throw new Error(`备注“${HEADINGS[index]}”缺少具体内容`);
  });
}

function parseArgs(argv) {
  const options = { ...defaultOptions(), apply: false };
  const names = { '--bug': 'bugId', '--comment-file': 'commentFile', '--plan-hash': 'planHash', '--cli': 'cli', '--config': 'config' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (seen.has(arg)) throw new Error(`重复参数：${arg}`);
    seen.add(arg);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--apply') { options.apply = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (!names[arg] || !argv[index + 1]) throw new Error(`参数无效或缺少值：${arg}`);
    options[names[arg]] = argv[++index];
  }
  if (options.help) return options;
  if (!/^[1-9]\d*$/.test(options.bugId || '')) throw new Error('--bug 必须为正整数 ID');
  if (!options.commentFile) throw new Error('必须提供 --comment-file <UTF-8四段备注文件>');
  options.comment = fs.readFileSync(options.commentFile, 'utf8').replace(/\r\n/g, '\n').trim();
  validateComment(options.comment);
  if (options.apply ? !/^[a-f0-9]{64}$/.test(options.planHash || '') : options.planHash) {
    throw new Error('仅执行时提供 --apply 和完整64位 --plan-hash');
  }
  return options;
}

function readBug(options) {
  const body = getBugEnvelope(options, options.bugId);
  const { bug } = normalizeBugEnvelope(body, options.bugId);
  const actions = Array.isArray(body.actions) ? body.actions : bug.actions;
  if (!Array.isArray(actions)) throw new Error('Bug 未返回操作历史，停止写入');
  const ids = actions.map(action => String(action.id || ''));
  if (ids.some(id => !/^[1-9]\d*$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Bug 历史 ID 缺失或重复，不能校验新增备注');
  }
  return { bug, actions };
}

function snapshot(bug) {
  const fields = ['id', 'title', 'status', 'story', 'openedBy', 'openedDate', 'assignedTo',
    'resolution', 'resolvedBuild', 'resolvedBy', 'resolvedDate', 'lastEditedBy', 'lastEditedDate',
    'deleted', 'product', 'project', 'execution', 'module', 'steps', 'type', 'severity', 'pri'];
  const result = Object.fromEntries(fields.map(field => [field, bug[field] ?? null]));
  for (const field of ['openedBy', 'assignedTo', 'resolvedBy', 'lastEditedBy']) result[field] = accountValue(bug[field]);
  for (const field of ['id', 'story', 'product', 'project', 'execution', 'module']) result[field] = objectId(bug[field]);
  return result;
}

function buildPlan(options) {
  const profiles = cliJson(options, ['profile']).profiles;
  const current = Array.isArray(profiles) ? profiles.filter(profile => profile.current) : [];
  if (current.length !== 1 || !current[0].server || !current[0].account) {
    throw new Error('不能唯一读取当前禅道 Profile 的服务与账号');
  }
  const profile = { server: String(current[0].server).replace(/\/+$/, ''), account: current[0].account };
  const { bug, actions } = readBug(options);
  const source = snapshot(bug);
  const blockers = [];
  if (source.status !== 'active') blockers.push(`Bug 当前状态为 ${source.status || '未知'}，仅 active 可解决`);
  if (!/^[A-Za-z0-9_.@-]+$/.test(source.openedBy) || source.openedBy === 'closed') blockers.push('未取得有效创建人 openedBy');
  if (!/^[1-9]\d*$/.test(source.story)) blockers.push('未取得真实关联需求，万事屋指令禁止提交此 Bug');
  if (bug.deleted === true || String(bug.deleted) === '1') blockers.push('Bug 已删除');
  if (actions.some(action => String(action.comment || '').trim() === options.comment)) blockers.push('历史已存在本次备注，禁止重复解决或备注');
  const data = { resolution: 'fixed', resolvedBuild: 'trunk', assignedTo: source.openedBy, comment: options.comment };
  const plan = {
    version: 1, caller: CALLER, action: 'resolve', bugId: options.bugId,
    transport: { cli: options.cli, config: path.resolve(options.config), profile },
    source, historyHash: digest(actions), historyIds: actions.map(action => String(action.id)),
    target: { status: 'resolved', ...data }, data, blockers,
  };
  return { ...plan, hash: digest(plan) };
}

function privateDirectory() {
  fs.mkdirSync(PLAN_DIRECTORY, { mode: 0o700, recursive: true });
  const stat = fs.lstatSync(PLAN_DIRECTORY);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('临时计划目录必须为本人持有的700普通目录');
  }
}

function planPath(hash) { return path.join(PLAN_DIRECTORY, `${hash}.json`); }
function attemptPath(plan) {
  return path.join(PLAN_DIRECTORY, `${digest([plan.transport.profile.server, plan.bugId])}.attempted`);
}

function savePlan(plan) {
  privateDirectory();
  if (fs.existsSync(attemptPath(plan))) throw new Error('该 Bug 已尝试写入，须交用户只读核对；禁止自动重试');
  const file = planPath(plan.hash);
  try {
    fs.writeFileSync(file, serialized(plan), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assertSavedPlan(plan);
  }
}

function assertSavedPlan(plan) {
  const file = planPath(plan.hash);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)
    || fs.readFileSync(file, 'utf8') !== serialized(plan)) {
    throw new Error('已保存预览缺失、权限或内容不符，拒绝执行');
  }
}

function verify(plan, current) {
  const { bug, actions } = current;
  const state = snapshot(bug);
  if (state.status !== 'resolved' || state.resolution !== plan.data.resolution
    || objectId(bug.resolvedBuild) !== plan.data.resolvedBuild || state.assignedTo !== plan.data.assignedTo) {
    throw new Error('Bug 状态、解决方案、版本或指派回读不符，禁止重试');
  }
  const allowed = ['status', 'resolution', 'resolvedBuild', 'assignedTo', 'resolvedBy', 'resolvedDate', 'lastEditedBy', 'lastEditedDate'];
  const unexpected = Object.keys(plan.source).filter(key => !allowed.includes(key)
    && serialized(plan.source[key]) !== serialized(state[key]));
  if (unexpected.length) throw new Error(`Bug 非计划字段变化：${unexpected.join('、')}`);
  const oldIds = new Set(plan.historyIds);
  const prior = actions.filter(action => oldIds.has(String(action.id)));
  if (digest(prior) !== plan.historyHash) throw new Error('原 Bug 历史变化或缺失，停止');
  const added = actions.filter(action => !oldIds.has(String(action.id)));
  const comments = added.filter(action => String(action.comment || '').trim() === plan.data.comment);
  if (comments.length !== 1 || String(comments[0].action || '').toLowerCase() !== 'resolved'
    || added.some(action => String(action.comment || '').trim() && action !== comments[0])) {
    throw new Error('新增解决记录及备注正文未唯一匹配计划，禁止补写备注或重试解决');
  }
  return { bugId: plan.bugId, status: state.status, resolution: state.resolution,
    resolvedBuild: plan.data.resolvedBuild, assignedTo: state.assignedTo, commentVerified: true };
}

function applyPlan(options, plan) {
  if (plan.hash !== options.planHash) throw new Error('远端、备注、Profile 或计划变化，停止；不得重新生成哈希继续');
  if (plan.blockers.length) throw new Error(`计划阻断：${plan.blockers.join('；')}`);
  privateDirectory();
  assertSavedPlan(plan);
  // 排他留痕先于请求，崩溃、超时、认证恢复及回读失败均不能自动重发。
  fs.writeFileSync(attemptPath(plan), serialized({ hash: plan.hash, attemptedAt: new Date().toISOString() }),
    { flag: 'wx', mode: 0o600 });
  const latest = buildPlan(options);
  if (latest.hash !== plan.hash) throw new Error('写入前最后回读已变化，停止；请求未发送');
  resolveBug(options, plan.bugId, plan.data, CALLER);
  return verify(plan, readBug(options));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('仅供 zentao-squad-delivery 的 Bug 分支使用。\n'
      + '预览：zentao_bug_workflow.js --bug <ID> --comment-file <UTF-8文件> [--cli <文件>] [--config <文件>] --json\n'
      + '执行：相同参数追加 --apply --plan-hash <完整64位哈希>\n'
      + '仅 fixed/trunk/创建人/四段备注；任何写入或回读失败即停，不重试。');
    return;
  }
  const plan = buildPlan(options);
  if (options.apply) {
    const current = applyPlan(options, plan);
    console.log(JSON.stringify({ applied: true, hash: plan.hash, current }, null, 2));
  } else {
    savePlan(plan);
    console.log(JSON.stringify({ applied: false, ...plan }, null, 2));
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    // 不输出 CLI 原始错误或备注，避免将业务材料／认证响应带入日志。
    console.error(`Bug 计划失败：${error.code || '已停止'}；${error.message.startsWith('zentao-cli') ? 'CLI 请求失败，须只读回读实际状态' : error.message}`);
    process.exitCode = 1;
  }
}

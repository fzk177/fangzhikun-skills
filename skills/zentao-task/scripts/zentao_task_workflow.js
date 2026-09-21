#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  accountValue,
  assignTask,
  cliJson,
  defaultOptions,
  editableTaskSnapshot,
  getStory,
  getTask,
  normalizeDateTime,
  numericValue,
  objectId,
  redactSensitiveText,
} = require('./zentao_cli');

const PLAN_DIRECTORY = path.join(os.tmpdir(), 'zentao-task-workflow');
const COMPLETE_REMOTE_STATUSES = new Set(['done', 'closed']);
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * 判断禅道回读时间是否符合计划时间。
 *
 * 禅道部分工作流接口只保留到分钟，因此仅允许远端将秒数截断为 00；
 * 日期、小时、分钟或其他秒数变化仍视为异常。
 *
 * @param {string} expected 计划时间
 * @param {string} actual 禅道回读时间
 * @returns {boolean} 是否可以接受
 */
function matchesDateTimeWithSecondTruncation(expected, actual) {
  if (actual === expected) {
    return true;
  }
  if (!DATE_TIME_PATTERN.test(expected) || !DATE_TIME_PATTERN.test(actual)) {
    return false;
  }
  return expected.slice(0, 16) === actual.slice(0, 16) && actual.endsWith(':00');
}

/**
 * 输出命令帮助。
 */
function printHelp() {
  console.log([
    '用法:',
    '  zentao_task_workflow.js --task <任务ID> --action complete --real-started <时间> --finished-date <时间> [选项]',
    '  zentao_task_workflow.js --task <任务ID> --action assign --assigned-to <账号> [选项]',
    '',
    '两阶段执行:',
    '  1. 不传 --apply：读取禅道，生成字段级预览和计划哈希，不写入禅道。',
    '  2. 用户确认后：追加 --apply --plan-hash <完整哈希>，执行完全一致的计划。',
    '',
    '选项:',
    '  --task <ID>                 禅道任务 ID',
    '  --action <complete|assign>  完成任务或指派已完成任务',
    '  --real-started <时间>       实际开始时间，格式 YYYY-MM-DD HH:mm:ss',
    '  --finished-date <时间>      实际完成时间，格式 YYYY-MM-DD HH:mm:ss',
    '  --assigned-to <账号>        指派目标禅道账号',
    '  --comment <备注>            启动任务或完成后指派时的附加备注，可选',
    '  --delivery-comment <备注>   完成任务时同时新增到任务和归属需求的四段交付备注，必填',
    '  --config <文件>             zentao-cli 配置文件',
    '  --cli <文件>                zentao-cli 可执行文件，默认 zentao',
    '  --apply                     执行用户已经确认的计划',
    '  --plan-hash <哈希>          预览阶段生成的完整计划哈希',
    '  --json                      使用 JSON 输出',
    '  -h, --help                  显示帮助',
    '',
    '工时规则:',
    '  本次消耗 = 当前剩余工时；完成后总消耗 = 原已消耗 + 原剩余；完成后剩余 = 0。',
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
    action: '',
    apply: false,
    assignedTo: '',
    comment: '',
    finishedDate: '',
    planHash: '',
    realStarted: '',
    deliveryComment: '',
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

    if (['--action', '--real-started', '--finished-date', '--assigned-to', '--comment', '--delivery-comment', '--config', '--cli', '--plan-hash'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} 缺少参数值`);
      }
      const keyMap = {
        '--action': 'action',
        '--real-started': 'realStarted',
        '--finished-date': 'finishedDate',
        '--assigned-to': 'assignedTo',
        '--comment': 'comment',
        '--delivery-comment': 'deliveryComment',
        '--config': 'config',
        '--cli': 'cli',
        '--plan-hash': 'planHash',
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
  if (!['complete', 'assign'].includes(options.action)) {
    throw new Error('--action 只允许 complete 或 assign');
  }
  if (options.action === 'complete') {
    options.realStarted = normalizeDateTime(options.realStarted, '--real-started');
    options.finishedDate = normalizeDateTime(options.finishedDate, '--finished-date');
    if (options.finishedDate < options.realStarted) {
      throw new Error('实际完成时间不能早于实际开始时间');
    }
    validateDeliveryComment(options.deliveryComment);
  }
  if (options.action === 'assign' && !/^[A-Za-z0-9_.@-]+$/.test(options.assignedTo)) {
    throw new Error('--assigned-to 必须提供有效的禅道账号');
  }
  if (options.apply && !/^[a-f0-9]{64}$/.test(options.planHash)) {
    throw new Error('--apply 必须同时提供完整的 64 位 --plan-hash');
  }
  if (!options.apply && options.planHash) {
    throw new Error('预览阶段不应传入 --plan-hash');
  }
  return options;
}

/**
 * 提取结构化需求备注的单个分段。
 *
 * @param {string} comment 完整需求备注
 * @param {string} heading 当前分段标题
 * @param {string|null} nextHeading 下一分段标题
 * @returns {string} 分段正文
 */
function deliveryCommentSection(comment, heading, nextHeading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const endPattern = nextHeading
    ? `(?=${nextHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[：:])`
    : '$';
  const match = String(comment || '').match(new RegExp(`${escapedHeading}[：:]([\\s\\S]*?)${endPattern}`));
  return match ? match[1].trim() : '';
}

/**
 * 判断分段中是否存在有意义的条目。
 *
 * @param {string} section 分段正文
 * @param {boolean} allowNoImpact 是否允许明确声明无其他影响
 * @returns {boolean} 是否有效
 */
function hasMeaningfulDeliveryCommentItem(section, allowNoImpact = false) {
  return String(section || '')
    .split(/\r?\n/)
    .some((line) => {
      const item = line.replace(/^\s*[-*]\s*/, '').trim();
      if (!item) return false;
      if (allowNoImpact && /^无其他已知影响[。；;！!]?$/.test(item)) return true;
      return !/^(?:无|无影响|无其他影响|无已知影响|无其他已知影响)[。；;！!]?$/.test(item);
    });
}

/**
 * 校验需求备注的四段交付结构，避免空泛文字替代交付事实。
 *
 * @param {string} comment 需求备注
 */
function validateDeliveryComment(comment) {
  const text = String(comment || '').trim();
  const sections = [
    ['涉及模块', '主要调整', false],
    ['主要调整', '验收口径', false],
    ['验收口径', '其他影响', false],
    ['其他影响', null, true],
  ];

  for (const [heading, nextHeading, allowNoImpact] of sections) {
    const section = deliveryCommentSection(text, heading, nextHeading);
    if (!hasMeaningfulDeliveryCommentItem(section, allowNoImpact)) {
      const suffix = allowNoImpact ? '，经核实没有时可写“无其他已知影响”' : '，不能使用“无”占位';
      throw new Error(`--delivery-comment 的“${heading}：”必须包含具体内容${suffix}`);
    }
  }
}

/**
 * 判断对象操作记录中是否存在与预览完全一致的备注。
 *
 * @param {object|null} object 禅道任务或需求
 * @param {string} comment 预览中的交付备注
 * @returns {boolean} 是否存在
 */
function actionHistoryHasComment(object, comment) {
  const expected = String(comment || '').trim();
  const actions = Array.isArray(object?.actions) ? object.actions : [];
  return actions.some((action) => String(action.comment || '').trim() === expected);
}

/**
 * 兼容禅道任务关联需求字段的不同命名。
 *
 * @param {object} task 禅道任务
 * @returns {string} 需求 ID
 */
function taskStoryId(task) {
  return objectId(task.story || task.storyID || task.storyId);
}

/**
 * 构造远端并发校验快照。
 *
 * @param {object} task 禅道任务
 * @returns {object} 快照
 */
function remoteSnapshot(task) {
  return {
    id: String(task.id),
    status: String(task.status || ''),
    assignedTo: accountValue(task.assignedTo),
    consumed: numericValue(task.consumed),
    left: numericValue(task.left),
    realStarted: String(task.realStarted || ''),
    finishedDate: String(task.finishedDate || ''),
    finishedBy: accountValue(task.finishedBy),
    storyId: taskStoryId(task),
    lastEditedDate: String(task.lastEditedDate || ''),
    editable: editableTaskSnapshot(task),
  };
}

/**
 * 构造完成任务计划。
 *
 * @param {object} options 选项
 * @param {object} task 禅道任务
 * @param {object|null} story 归属需求
 * @returns {object} 未计算哈希的计划
 */
function buildCompletePlan(options, task, story) {
  const status = String(task.status || '').toLowerCase();
  const consumed = numericValue(task.consumed);
  const remaining = numericValue(task.left);
  const targetConsumed = consumed + remaining;
  const remoteRealStarted = String(task.realStarted || '');
  const storyId = taskStoryId(task);
  const blockers = [];
  const operations = [];

  if (COMPLETE_REMOTE_STATUSES.has(status)) {
    blockers.push(`任务当前已经是 ${status} 状态，拒绝重复执行完成工作流`);
  } else if (!['wait', 'doing'].includes(status)) {
    blockers.push(`任务当前状态为 ${status || '未知'}，只允许从 wait 或 doing 完成`);
  }

  if (status === 'doing' && remoteRealStarted
    && !matchesDateTimeWithSecondTruncation(options.realStarted, remoteRealStarted)) {
    blockers.push(`禅道已有实际开始时间 ${remoteRealStarted}，与本地记录 ${options.realStarted} 不一致`);
  }

  const effectiveStartedAt = remoteRealStarted || options.realStarted;
  if (options.finishedDate < effectiveStartedAt) {
    blockers.push('实际完成时间早于禅道已有的实际开始时间');
  }

  if (!storyId) {
    blockers.push('任务未关联需求，无法新增四段交付备注');
  } else if (!story || objectId(story.id) !== storyId) {
    blockers.push(`关联需求 #${storyId} 无法读取，不能核实备注写入路径`);
  } else if (actionHistoryHasComment(story, options.deliveryComment)) {
    blockers.push(`需求 #${storyId} 已存在与本次预览完全一致的交付备注，拒绝重复新增`);
  }

  if (actionHistoryHasComment(task, options.deliveryComment)) {
    blockers.push(`任务 #${task.id} 已存在与本次预览完全一致的交付备注，拒绝重复新增`);
  }

  if (status === 'wait') {
    operations.push({
      type: 'start',
      label: '启动任务',
      fields: [
        { field: '状态', from: status, to: 'doing' },
        { field: '实际开始时间', from: remoteRealStarted, to: effectiveStartedAt },
        { field: '累计消耗工时', from: consumed, to: consumed },
        { field: '剩余工时', from: remaining, to: remaining },
      ],
      data: {
        assignedTo: accountValue(task.assignedTo),
        realStarted: effectiveStartedAt,
        consumed,
        left: remaining,
        comment: options.comment,
      },
    });
  }

  if (!COMPLETE_REMOTE_STATUSES.has(status) && ['wait', 'doing'].includes(status)) {
    operations.push({
      type: 'finish',
      label: '完成任务',
      fields: [
        { field: '状态', from: status === 'wait' ? 'doing' : status, to: 'done' },
        { field: '实际完成时间', from: String(task.finishedDate || ''), to: options.finishedDate },
        { field: '本次消耗工时', from: 0, to: remaining },
        { field: '累计消耗工时', from: consumed, to: targetConsumed },
        { field: '剩余工时', from: remaining, to: 0 },
        { field: '任务备注', from: '（新增）', to: options.deliveryComment },
      ],
      data: {
        currentConsumed: remaining,
        assignedTo: accountValue(task.assignedTo),
        consumed: targetConsumed,
        realStarted: effectiveStartedAt,
        finishedDate: options.finishedDate,
        comment: options.deliveryComment,
      },
    });
  }

  if (storyId && story && objectId(story.id) === storyId) {
    operations.push({
      type: 'story-comment',
      label: `在需求 #${storyId} 新增四段交付备注`,
      fields: [
        { field: '需求备注', from: '（新增）', to: options.deliveryComment },
      ],
      data: {
        comment: options.deliveryComment,
      },
    });
  }

  return {
    version: 3,
    action: 'complete',
    taskId: String(task.id),
    taskName: String(task.name || ''),
    storyId,
    source: remoteSnapshot(task),
    target: {
      status: 'done',
      realStarted: effectiveStartedAt,
      finishedDate: options.finishedDate,
      consumed: targetConsumed,
      left: 0,
      deliveryComment: options.deliveryComment,
    },
    operations,
    blockers,
  };
}

/**
 * 构造完成后指派计划。
 *
 * @param {object} options 选项
 * @param {object} task 禅道任务
 * @returns {object} 未计算哈希的计划
 */
function buildAssignPlan(options, task) {
  const status = String(task.status || '').toLowerCase();
  const currentAccount = accountValue(task.assignedTo);
  const blockers = [];
  const operations = [];

  if (!COMPLETE_REMOTE_STATUSES.has(status)) {
    blockers.push(`任务当前状态为 ${status || '未知'}，只允许指派已经完成或关闭的任务`);
  }

  if (currentAccount !== options.assignedTo && COMPLETE_REMOTE_STATUSES.has(status)) {
    const data = {
      assignedTo: options.assignedTo,
    };
    if (options.comment) data.comment = options.comment;
    operations.push({
      type: 'assign',
      label: '指派已完成任务',
      fields: [
        { field: '指派人', from: currentAccount, to: options.assignedTo },
      ],
      data,
    });
  }

  return {
    version: 1,
    action: 'assign',
    taskId: String(task.id),
    taskName: String(task.name || ''),
    source: remoteSnapshot(task),
    target: {
      assignedTo: options.assignedTo,
    },
    operations,
    blockers,
  };
}

/**
 * 计算完整计划及稳定哈希。
 *
 * @param {object} options 选项
 * @returns {object} 完整计划
 */
function buildPlan(options) {
  const task = getTask(options, options.taskId);
  let plan;
  if (options.action === 'complete') {
    const storyId = taskStoryId(task);
    const story = storyId ? getStory(options, storyId) : null;
    plan = buildCompletePlan(options, task, story);
  } else {
    plan = buildAssignPlan(options, task);
  }
  const hashSource = JSON.stringify(plan);
  return {
    ...plan,
    hash: crypto.createHash('sha256').update(hashSource).digest('hex'),
  };
}

/**
 * 保存权限受限的临时计划。
 *
 * @param {object} plan 计划
 */
function savePlan(plan) {
  fs.mkdirSync(PLAN_DIRECTORY, { recursive: true, mode: 0o700 });
  const filePath = path.join(PLAN_DIRECTORY, `${plan.hash}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
}

/**
 * 校验预览计划确实存在且内容一致。
 *
 * @param {object} plan 当前计划
 */
function assertSavedPlan(plan) {
  const filePath = path.join(PLAN_DIRECTORY, `${plan.hash}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error('没有找到对应的预览计划，必须先执行预览并向用户展示完整差异');
  }

  const savedPlan = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (JSON.stringify(savedPlan) !== JSON.stringify(plan)) {
    throw new Error('临时预览计划内容不一致，拒绝执行');
  }
}

/**
 * 比较任务更新前后的非计划字段。
 *
 * @param {object} before 更新前快照
 * @param {object} after 更新后快照
 * @returns {string[]} 异常字段
 */
function unexpectedAssignmentChanges(before, after) {
  const editableFields = ['name', 'type', 'estStarted', 'deadline', 'pri', 'estimate', 'module', 'story', 'desc'];
  // 专用指派接口只允许改变指派人、指派时间和最后编辑信息，任务工作流字段必须全部保持不变。
  const workflowFields = ['status', 'consumed', 'left', 'finishedBy', 'realStarted', 'finishedDate'];
  const unexpected = [];

  for (const field of editableFields) {
    if (JSON.stringify(before.editable[field]) !== JSON.stringify(after.editable[field])) {
      unexpected.push(field);
    }
  }

  for (const field of workflowFields) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      unexpected.push(field);
    }
  }

  return unexpected;
}

/**
 * 执行完成任务计划并回读验证。
 *
 * @param {object} options 选项
 * @param {object} plan 计划
 * @returns {object} 回读任务
 */
function applyCompletePlan(options, plan) {
  const taskOperations = plan.operations.filter((operation) => operation.type !== 'story-comment');
  try {
    for (const operation of taskOperations) {
      cliJson(options, [
        'task',
        operation.type,
        plan.taskId,
        `--data=${JSON.stringify(operation.data)}`,
      ]);

      // start 成功后立即回读，避免在启动字段异常时继续执行不可逆的 finish。
      if (operation.type === 'start') {
        const startedTask = getTask(options, plan.taskId);
        if (String(startedTask.status || '').toLowerCase() !== 'doing'
          || !matchesDateTimeWithSecondTruncation(plan.target.realStarted, String(startedTask.realStarted || ''))
          || numericValue(startedTask.consumed) !== plan.source.consumed
          || numericValue(startedTask.left) !== plan.source.left) {
          throw new Error(`启动后回读校验失败：状态=${startedTask.status}，实际开始=${startedTask.realStarted || ''}，已消耗=${startedTask.consumed}，剩余=${startedTask.left}`);
        }
      }
    }
  } catch (error) {
    const current = getTask(options, plan.taskId);
    const completed = COMPLETE_REMOTE_STATUSES.has(String(current.status || '').toLowerCase());
    const partialWarning = completed ? '任务可能已经完成，禁止重复执行任务完成操作。' : '';
    throw new Error(`任务完成工作流执行失败，当前远端状态=${current.status}、已消耗=${current.consumed}、剩余=${current.left}。${partialWarning}${error.message}`);
  }

  const current = getTask(options, plan.taskId);
  const actualConsumed = numericValue(current.consumed);
  const actualRemaining = numericValue(current.left);
  if (!COMPLETE_REMOTE_STATUSES.has(String(current.status || '').toLowerCase())
    || actualConsumed !== plan.target.consumed
    || actualRemaining !== 0
    || !matchesDateTimeWithSecondTruncation(plan.target.realStarted, String(current.realStarted || ''))
    || !matchesDateTimeWithSecondTruncation(plan.target.finishedDate, String(current.finishedDate || ''))) {
    throw new Error(`完成后回读校验失败：状态=${current.status}，实际开始=${current.realStarted || ''}，实际完成=${current.finishedDate || ''}，已消耗=${actualConsumed}，剩余=${actualRemaining}`);
  }
  if (!actionHistoryHasComment(current, plan.target.deliveryComment)) {
    throw new Error(`任务 #${plan.taskId} 已完成，但任务备注回读校验失败：未找到与预览完全一致的四段交付备注。禁止重复执行任务完成操作`);
  }

  const storyCommentOperation = plan.operations.find((operation) => operation.type === 'story-comment');
  if (!storyCommentOperation) {
    throw new Error(`任务 #${plan.taskId} 已完成，但计划中缺少需求备注写入动作，禁止重复执行任务完成操作`);
  }

  try {
    cliJson(options, [
      'story',
      'update',
      plan.storyId,
      `--data=${JSON.stringify(storyCommentOperation.data)}`,
    ]);
  } catch (error) {
    let story = null;
    try {
      story = getStory(options, plan.storyId);
    } catch (readError) {
      throw new Error(`任务 #${plan.taskId} 已完成，但需求 #${plan.storyId} 备注写入结果无法核实：${readError.message}。禁止重复执行任务完成操作`);
    }
    if (!actionHistoryHasComment(story, plan.target.deliveryComment)) {
      throw new Error(`任务 #${plan.taskId} 已完成，但需求 #${plan.storyId} 备注写入失败：${error.message}。禁止重复执行任务完成操作`);
    }
  }

  let story;
  try {
    story = getStory(options, plan.storyId);
  } catch (error) {
    throw new Error(`任务 #${plan.taskId} 已完成，但需求 #${plan.storyId} 备注回读失败：${error.message}。禁止重复执行任务完成操作`);
  }
  if (!actionHistoryHasComment(story, plan.target.deliveryComment)) {
    throw new Error(`任务 #${plan.taskId} 已完成，但需求 #${plan.storyId} 备注回读校验失败：未找到与预览完全一致的四段交付备注。禁止重复执行任务完成操作`);
  }
  return current;
}

/**
 * 执行指派计划；出现非计划字段变化时停止并报告真实远端状态。
 *
 * @param {object} options 选项
 * @param {object} plan 计划
 * @returns {object} 回读任务
 */
async function applyAssignPlan(options, plan) {
  if (plan.operations.length === 0) {
    return getTask(options, plan.taskId);
  }

  const operation = plan.operations[0];
  await assignTask(options, plan.taskId, operation.data);

  const current = getTask(options, plan.taskId);
  const currentSnapshot = remoteSnapshot(current);
  const unexpected = unexpectedAssignmentChanges(plan.source, currentSnapshot);
  if (unexpected.length > 0 || accountValue(current.assignedTo) !== plan.target.assignedTo) {
    throw new Error(`指派后校验失败，非计划变化字段：${unexpected.join('、') || '无'}；当前指派=${accountValue(current.assignedTo)}。已停止且未发起第二次指派请求，请按回读后的真实状态处理。`);
  }
  return current;
}

/**
 * 执行已确认计划。
 *
 * @param {object} options 选项
 * @param {object} plan 当前计划
 * @returns {object} 回读任务
 */
async function applyPlan(options, plan) {
  if (plan.hash !== options.planHash) {
    throw new Error(`远端数据或计划已变化，拒绝执行。确认哈希=${options.planHash.slice(0, 12)}，当前哈希=${plan.hash.slice(0, 12)}`);
  }
  if (plan.blockers.length > 0) {
    throw new Error(`计划存在阻断项：${plan.blockers.join('；')}`);
  }

  assertSavedPlan(plan);
  const current = plan.action === 'complete'
    ? applyCompletePlan(options, plan)
    : await applyAssignPlan(options, plan);

  const planFile = path.join(PLAN_DIRECTORY, `${plan.hash}.json`);
  if (fs.existsSync(planFile)) {
    fs.unlinkSync(planFile);
  }
  return current;
}

/**
 * 显示字段值。
 *
 * @param {unknown} value 字段值
 * @returns {string} 展示值
 */
function displayValue(value) {
  if (value === '' || value === null || value === undefined) {
    return '（空）';
  }
  return String(value);
}

/**
 * 输出计划或执行结果。
 *
 * @param {object} plan 计划
 * @param {boolean} applied 是否已执行
 * @param {object|null} current 回读任务
 * @param {boolean} asJson 是否 JSON 输出
 */
function printPlan(plan, applied, current, asJson) {
  if (asJson) {
    console.log(JSON.stringify({
      mode: applied ? 'applied' : 'preview',
      ...plan,
      current: current ? remoteSnapshot(current) : null,
    }, null, 2));
    return;
  }

  console.log(`${applied ? '禅道任务工作流已执行' : '禅道任务工作流预览'}：任务 #${plan.taskId} · ${plan.taskName}`);
  console.log(`动作：${plan.action === 'complete' ? '完成任务' : '指派已完成任务'}；操作数：${plan.operations.length}；阻断项：${plan.blockers.length}`);
  for (const operation of plan.operations) {
    console.log(`- ${operation.label}`);
    for (const field of operation.fields) {
      console.log(`  - ${field.field}：${displayValue(field.from)} → ${displayValue(field.to)}`);
    }
  }
  for (const blocker of plan.blockers) {
    console.log(`- 阻断：${blocker}`);
  }

  if (applied && current) {
    console.log(`回读：状态=${current.status}，指派=${accountValue(current.assignedTo) || '未指派'}，已消耗=${numericValue(current.consumed)}h，剩余=${numericValue(current.left)}h`);
    if (plan.action === 'complete') {
      console.log(`任务备注回读：任务 #${plan.taskId} 已找到与预览完全一致的四段交付备注`);
      console.log(`需求备注回读：需求 #${plan.storyId} 已找到与预览完全一致的四段交付备注`);
    }
  } else {
    console.log(`计划哈希：${plan.hash}`);
    console.log('当前没有更新禅道，等待用户明确确认完整计划哈希。');
  }
}

/**
 * 程序入口。
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const plan = buildPlan(options);
  if (!options.apply) {
    savePlan(plan);
    printPlan(plan, false, null, options.json);
    return;
  }

  const current = await applyPlan(options, plan);
  printPlan(plan, true, current, options.json);
}

main().catch((error) => {
  console.error(`禅道任务工作流失败：${redactSensitiveText(error.message)}`);
  process.exitCode = 1;
});

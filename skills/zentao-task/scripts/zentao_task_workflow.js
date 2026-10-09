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
    '  zentao_task_workflow.js --task <任务ID> --action comment --delivery-comment <四段交付备注> [选项]',
    '  zentao_task_workflow.js --task <任务ID> --action restore-start --real-started <原实际开始时间> [选项]',
    '',
    '两阶段执行:',
    '  1. 不传 --apply：读取禅道，生成字段级预览和计划哈希，不写入禅道。',
    '  2. 用户确认后：追加 --apply --plan-hash <完整哈希>，执行完全一致的计划。',
    '',
    '选项:',
    '  --task <ID>                 禅道任务 ID',
    '  --action <complete|assign|comment|restore-start>  完成任务、指派、新增备注或恢复开始时间',
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
  if (!['complete', 'assign', 'comment', 'restore-start'].includes(options.action)) {
    throw new Error('--action 只允许 complete、assign、comment 或 restore-start');
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
  if (options.action === 'comment') {
    validateDeliveryComment(options.deliveryComment);
    if (options.realStarted || options.finishedDate || options.assignedTo || options.comment) {
      throw new Error('仅新增任务备注不能同时传入时间、指派或其他备注参数');
    }
  }
  if (options.action === 'restore-start') {
    options.realStarted = normalizeDateTime(options.realStarted, '--real-started');
    if (options.finishedDate || options.assignedTo || options.comment || options.deliveryComment) {
      throw new Error('恢复开始时间不能同时传入完成、指派或备注参数');
    }
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

/** 需求业务字段快照，操作记录单独参与计划哈希，备注不允许改写业务字段。 */
function storyBusinessSnapshot(story) {
  const fields = ['id', 'title', 'spec', 'verify', 'status', 'stage', 'assignedTo',
    'product', 'branch', 'module', 'parent', 'plan', 'source', 'sourceNote',
    'pri', 'estimate', 'category', 'keywords', 'type', 'version', 'reviewedBy', 'mailto'];
  return Object.fromEntries(fields.map((field) => [field, story[field] ?? null]));
}

function changedStoryFields(before, after, excluded = []) {
  return Object.keys(before).filter((field) => !excluded.includes(field)
    && JSON.stringify(before[field]) !== JSON.stringify(after[field]));
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
  } else if (!Array.isArray(story.actions)) {
    blockers.push(`需求 #${storyId} 操作记录无法回读，不能进入完成写入`);
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
    source: {
      ...remoteSnapshot(task),
      story: story ? {
        business: storyBusinessSnapshot(story),
        lastEditedDate: String(story.lastEditedDate || ''),
        actionsHash: crypto.createHash('sha256').update(JSON.stringify(story.actions || [])).digest('hex'),
      } : null,
    },
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
function buildCommentPlan(options, task) {
  const source = {
    ...remoteSnapshot(task),
    actionsHash: crypto.createHash('sha256').update(JSON.stringify(task.actions || [])).digest('hex'),
  };
  const blockers = [];
  if (!Array.isArray(task.actions)) {
    blockers.push('任务详情未返回操作记录，无法校验独立备注写入结果');
  }
  if (actionHistoryHasComment(task, options.deliveryComment)) {
    blockers.push(`任务 #${task.id} 已存在完全一致的交付备注，拒绝重复新增`);
  }
  // PUT 入口须回传现有可编辑字段，防止服务端将缺省字段重置。
  // 不传完成、启动或指派参数；所有业务字段在写后逐项回读校验。
  return {
    version: 1,
    action: 'comment',
    taskId: String(task.id),
    taskName: String(task.name || ''),
    storyId: taskStoryId(task),
    source,
    target: { ...source, deliveryComment: options.deliveryComment },
    operations: [{
      type: 'task-comment',
      label: '仅在任务操作记录新增四段交付备注',
      fields: [{ field: '任务备注', from: '（新增）', to: options.deliveryComment }],
      data: {
        ...source.editable,
        realStarted: source.realStarted,
        finishedDate: source.finishedDate,
        comment: options.deliveryComment,
      },
    }],
    blockers,
  };
}

function buildPlan(options) {
  const task = getTask(options, options.taskId);
  let plan;
  if (options.action === 'complete') {
    const storyId = taskStoryId(task);
    const story = storyId ? getStory(options, storyId) : null;
    plan = buildCompletePlan(options, task, story);
  } else if (options.action === 'comment') {
    plan = buildCommentPlan(options, task);
  } else if (options.action === 'restore-start') {
    plan = buildRestoreStartPlan(options, task);
  } else {
    plan = buildAssignPlan(options, task);
  }
  const hashSource = JSON.stringify(plan);
  return {
    ...plan,
    hash: crypto.createHash('sha256').update(hashSource).digest('hex'),
  };
}

/** 仅恢复用户确认的开始时间；不执行启动、完成、指派或新增备注。 */
function buildRestoreStartPlan(options, task) {
  const source = {
    ...remoteSnapshot(task),
    actionsHash: crypto.createHash('sha256').update(JSON.stringify(task.actions || [])).digest('hex'),
  };
  const blockers = [];
  if (source.realStarted) blockers.push('当前实际开始时间已有值，不能使用清空后的恢复入口');
  if (!Array.isArray(task.actions)) blockers.push('任务操作记录无法回读');
  return {
    version: 1,
    action: 'restore-start',
    taskId: String(task.id),
    taskName: String(task.name || ''),
    storyId: taskStoryId(task),
    source,
    target: { ...source, realStarted: options.realStarted },
    operations: [{
      type: 'restore-start',
      label: '恢复被备注更新入口清空的实际开始时间',
      fields: [{ field: '实际开始时间', from: source.realStarted, to: options.realStarted }],
      data: { ...source.editable, realStarted: options.realStarted, finishedDate: source.finishedDate },
    }],
    blockers,
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
  const afterTask = remoteSnapshot(current);
  const changedTaskFields = Object.keys(plan.source.editable).filter((field) =>
    JSON.stringify(plan.source.editable[field]) !== JSON.stringify(afterTask.editable[field]));
  if (changedTaskFields.length) {
    throw new Error(`任务 #${plan.taskId} 已完成，但业务字段发生非计划变化：${changedTaskFields.join('、')}；未继续写需求备注，禁止重复完成`);
  }

  const storyCommentOperation = plan.operations.find((operation) => operation.type === 'story-comment');
  if (!storyCommentOperation) {
    throw new Error(`任务 #${plan.taskId} 已完成，但计划中缺少需求备注写入动作，禁止重复执行任务完成操作`);
  }

  const storyBeforeComment = getStory(options, plan.storyId);
  const beforeStoryFields = storyBusinessSnapshot(storyBeforeComment);
  // 完成任务可能由禅道自动计算需求阶段；备注操作仍须保持其写入前阶段。
  const changedBeforeComment = changedStoryFields(plan.source.story.business, beforeStoryFields, ['stage']);
  if (changedBeforeComment.length) {
    throw new Error(`任务 #${plan.taskId} 已完成，但需求字段已变化：${changedBeforeComment.join('、')}；未写需求备注，禁止重复完成`);
  }
  if (actionHistoryHasComment(storyBeforeComment, plan.target.deliveryComment)) {
    throw new Error(`任务 #${plan.taskId} 已完成，需求备注已存在；未重复写入，请只读核验`);
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
  const changedAfterComment = changedStoryFields(beforeStoryFields, storyBusinessSnapshot(story));
  if (changedAfterComment.length) {
    throw new Error(`任务 #${plan.taskId} 已完成且需求备注已写入，但需求业务字段发生非计划变化：${changedAfterComment.join('、')}；已停止且未重试`);
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
function applyCommentPlan(options, plan) {
  let writeError = null;
  try {
    cliJson(options, ['task', 'update', plan.taskId,
      `--data=${JSON.stringify(plan.operations[0].data)}`]);
  } catch (error) {
    // 响应异常也须先回读，不自动重试，避免已经成功的备注被重复新增。
    writeError = error;
  }
  const current = getTask(options, plan.taskId);
  const snapshot = remoteSnapshot(current);
  const unexpected = unexpectedAssignmentChanges(plan.source, snapshot);
  if (snapshot.assignedTo !== plan.source.assignedTo) unexpected.push('assignedTo');
  if (unexpected.length > 0) {
    throw new Error(`新增备注后发现非计划字段变化：${unexpected.join('、')}；已停止，不会自动恢复或再次写入`);
  }
  if (!actionHistoryHasComment(current, plan.target.deliveryComment)) {
    throw new Error(`任务备注回读未找到与预览完全一致的正文；未自动重试。${writeError ? writeError.message : ''}`);
  }
  return current;
}

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
    : plan.action === 'comment'
      ? applyCommentPlan(options, plan)
      : plan.action === 'restore-start'
        ? applyRestoreStartPlan(options, plan)
        : await applyAssignPlan(options, plan);

  const planFile = path.join(PLAN_DIRECTORY, `${plan.hash}.json`);
  if (fs.existsSync(planFile)) {
    fs.unlinkSync(planFile);
  }
  return current;
}

function applyRestoreStartPlan(options, plan) {
  cliJson(options, ['task', 'update', plan.taskId,
    `--data=${JSON.stringify(plan.operations[0].data)}`]);
  const current = getTask(options, plan.taskId);
  const after = remoteSnapshot(current);
  const unexpected = unexpectedAssignmentChanges(plan.target, after);
  if (after.assignedTo !== plan.source.assignedTo) unexpected.push('assignedTo');
  if (unexpected.length) {
    throw new Error(`恢复开始时间后发现非计划字段变化：${unexpected.join('、')}；已停止且未重试`);
  }
  const actions = current.actions || [];
  const rawBeforeActionsHash = plan.source.actionsHash;
  if (!actions.length || crypto.createHash('sha256').update(JSON.stringify(actions)).digest('hex') === rawBeforeActionsHash) {
    throw new Error('恢复开始时间后未读到对应操作记录，已停止且未重试');
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
  console.log(`动作：${plan.action === 'complete' ? '完成任务' : plan.action === 'comment' ? '仅新增任务备注' : plan.action === 'restore-start' ? '恢复开始时间' : '指派已完成任务'}；操作数：${plan.operations.length}；阻断项：${plan.blockers.length}`);
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
    } else if (plan.action === 'comment') {
      console.log('任务备注正文回读一致，状态、工时、指派及业务字段保持不变');
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

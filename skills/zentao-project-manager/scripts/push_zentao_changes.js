#!/usr/bin/env node

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { expandHome, loadRuntimeConfig } = require('./runtime_config');

const RUNTIME_CONFIG = loadRuntimeConfig();
const DEFAULT_CONFIG = expandHome(RUNTIME_CONFIG.zentao?.config)
  || path.join(os.homedir(), '.config', 'zentao', 'zentao.json');
const DEFAULT_CLI = expandHome(RUNTIME_CONFIG.zentao?.cli) || 'zentao';
const DEFAULT_PROJECTS_FOLDER = '04.项目';
const PROJECT_MANAGER_PLUGIN_ID = 'project-manager-enhanced';
const EXECUTION_TASKS_FOLDER = '01.需求与任务';
const KEYCHAIN_SERVICE = String(RUNTIME_CONFIG.zentao?.keychainService || 'zentao-cli');
const DEFAULT_ACCOUNT = String(RUNTIME_CONFIG.zentao?.account || '');
const DEFAULT_SERVER = String(RUNTIME_CONFIG.zentao?.server || '');
const DEFAULT_PAGE_SIZE = 200;
const CLI_TIMEOUT_MS = 60000;
const CLI_MAX_BUFFER = 64 * 1024 * 1024;
const PLAN_DIRECTORY = path.join(os.tmpdir(), 'zentao-project-manager-push');

function printHelp() {
  console.log([
    '用法:',
    '  push_zentao_changes.js --execution <迭代ID> [选项]',
    '',
    '两阶段写回:',
    '  1. 不传 --apply：只预览本地相对禅道的修改，并生成计划哈希。',
    '  2. 用户确认后：传 --apply --plan-hash <哈希> 执行完全一致的计划。',
    '',
    '选项:',
    '  --vault <目录>              Obsidian vault 根目录，默认当前目录',
    '  --projects-folder <目录>    Project Manager 项目目录，默认读取插件配置',
    '  --config <文件>             zentao-cli 配置文件',
    '  --cli <文件>                zentao-cli 可执行文件，默认 zentao',
    '  --apply                     确认后实际更新禅道',
    '  --plan-hash <哈希>          预览输出的计划哈希；--apply 时必填',
    '  --json                      使用 JSON 输出',
    '  -h, --help                  显示帮助',
    '',
    '安全限制:',
    '  只更新现有需求和任务的白名单字段；不创建、不删除，不自动执行状态流转。',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {
    apply: false,
    cli: DEFAULT_CLI,
    config: DEFAULT_CONFIG,
    json: false,
    planHash: '',
    projectsFolder: '',
    vault: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--execution') {
      const value = argv[index + 1];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error('--execution 必须提供纯数字 ID');
      }
      options.execution = value;
      index += 1;
      continue;
    }

    if (['--vault', '--projects-folder', '--config', '--cli', '--plan-hash'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} 缺少参数值`);
      }
      const keyMap = {
        '--vault': 'vault',
        '--projects-folder': 'projectsFolder',
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

  if (!options.help && !options.execution) {
    throw new Error('必须指定 --execution <ID>');
  }
  if (options.apply && !/^[a-f0-9]{64}$/.test(options.planHash)) {
    throw new Error('--apply 必须同时提供预览生成的 --plan-hash');
  }

  return options;
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/("?(?:password|token|secret|session|cookie)"?\s*[:=]\s*)[^,\s}\]]+/gi, '$1***')
    .replace(/([?&](?:password|token|secret|session)=)[^&\s]+/gi, '$1***');
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

function rawCliJson(options, args) {
  const result = spawn(options.cli, [
    '--config', options.config,
    '--machine-readable',
    `--timeout=${CLI_TIMEOUT_MS}`,
    '--format=json',
    ...args,
  ]);
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;

  if (result.error) {
    throw new Error(`无法执行 zentao-cli：${redactSensitiveText(result.error.message)}`);
  }

  let body;
  try {
    body = JSON.parse(result.stdout || '{}');
  } catch (error) {
    const cliError = new Error(`zentao-cli 返回异常：${redactSensitiveText(combined.trim() || error.message)}`);
    cliError.authCode = findErrorCode(combined);
    throw cliError;
  }

  if (result.status !== 0 || body.status === 'fail' || body.error) {
    const cliError = new Error(`zentao-cli 操作失败：${redactSensitiveText(JSON.stringify(body.error || body.message || body))}`);
    cliError.authCode = findErrorCode(combined) || findErrorCode(JSON.stringify(body));
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
    throw new Error(`未找到钥匙串服务 ${KEYCHAIN_SERVICE} 中账号 ${account} 的凭据`);
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
    throw new Error('禅道自动重新登录失败，请检查 CLI 配置或本机钥匙串凭据');
  }
}

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

function getCliList(options, moduleName, params = []) {
  if (!['story', 'task', 'user'].includes(moduleName)) {
    throw new Error(`拒绝读取非白名单模块：${moduleName}`);
  }

  const items = [];
  let page = 1;
  while (true) {
    const body = cliJson(options, [
      moduleName,
      ...params,
      `--page=${page}`,
      `--recPerPage=${DEFAULT_PAGE_SIZE}`,
    ]);
    const list = Array.isArray(body.data) ? body.data : [];
    const total = Number(body.pager?.total ?? items.length + list.length);
    items.push(...list);
    if (list.length === 0 || items.length >= total) {
      break;
    }
    page += 1;
  }
  return items;
}

function parseYamlValue(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    return '';
  }
  if (raw === 'null') {
    return null;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (raw.startsWith('"') || raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      return raw;
    }
  }
  // Obsidian 的 YAML 序列化器会把包含 JSON 的字符串改写成单引号标量。
  // YAML 单引号内部用两个连续单引号表示一个单引号。
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function splitFrontmatter(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: '', body: String(content || '') };
  }
  return { frontmatter: match[1], body: String(content || '').slice(match[0].length) };
}

function parseScalar(frontmatter, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 这里只允许消费行内空白，不能让 \s* 跨行吞掉块序列的第一项。
  const match = frontmatter.match(new RegExp(`^${escaped}:[ \\t]*(.*)$`, 'm'));
  if (!match) {
    return '';
  }
  if (match[1].trim()) {
    return parseYamlValue(match[1]);
  }

  // Project Manager 会把 assignees、tags 等数组保存成 YAML 块序列。
  const lines = String(frontmatter || '').split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => new RegExp(`^${escaped}:\\s*$`).test(line));
  if (keyIndex < 0) {
    return '';
  }
  const values = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    if (lines[index] && !/^\s/.test(lines[index])) {
      break;
    }
    const item = lines[index].match(/^\s+-\s+(.*)$/);
    if (item) {
      values.push(parseYamlValue(item[1]));
    }
  }
  return values;
}

function parseNestedScalar(frontmatter, section, key) {
  const lines = String(frontmatter || '').split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line.trim() === `${section}:` && !/^\s/.test(line));
  if (sectionIndex < 0) {
    return '';
  }

  const prefix = `  ${key}:`;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (lines[index] && !/^\s/.test(lines[index])) {
      break;
    }
    if (lines[index].startsWith(prefix)) {
      return parseYamlValue(lines[index].slice(prefix.length));
    }
  }
  return '';
}

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

function normalizeDate(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match && match[1] !== '0000-00-00' ? match[1] : '';
}

function numericValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectId(value) {
  if (value && typeof value === 'object') {
    return String(value.id || value.value || '');
  }
  const text = String(value ?? '').trim();
  return text === '0' ? '' : text;
}

function accountValue(value) {
  if (value && typeof value === 'object') {
    return String(value.account || '');
  }
  return String(value || '');
}

function normalizedAssignedAccount(value) {
  const account = accountValue(value);
  return account === 'closed' ? '' : account;
}

function mapPriorityToZenTao(value) {
  return ({ critical: '1', high: '2', medium: '3', low: '4' })[String(value || '')] || '';
}

/**
 * 兼容历史同步文件：旧版曾把“需求 #ID ·”写进事项标题。
 * 新版标题与禅道原文保持一致，禅道 ID 始终从 customFields.zentaoId 读取。
 */
function normalizeLegacyRequirementTitle(value, id) {
  return String(value || '').replace(new RegExp(`^需求\\s*#?${String(id)}\\s*·\\s*`), '');
}

function valuesEqual(left, right) {
  return JSON.stringify(left ?? '') === JSON.stringify(right ?? '');
}

function readProjectsFolder(vault, explicitFolder) {
  if (explicitFolder) {
    return explicitFolder;
  }
  const dataFile = path.join(vault, '.obsidian', 'plugins', PROJECT_MANAGER_PLUGIN_ID, 'data.json');
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return data.projectsFolder || DEFAULT_PROJECTS_FOLDER;
  } catch (error) {
    return DEFAULT_PROJECTS_FOLDER;
  }
}

function assertVault(value) {
  const vault = path.resolve(value);
  if (!fs.existsSync(path.join(vault, '.obsidian'))) {
    throw new Error(`目标目录不是有效 Obsidian vault：${vault}`);
  }
  return vault;
}

function findExecutionProject(vault, projectsFolder, executionId) {
  const directory = path.resolve(vault, projectsFolder);
  if (!fs.existsSync(directory)) {
    throw new Error(`Project Manager 项目目录不存在：${projectsFolder}`);
  }

  for (const filePath of walkMarkdownFiles(directory)) {
    const frontmatter = splitFrontmatter(fs.readFileSync(filePath, 'utf8')).frontmatter;
    if (String(parseScalar(frontmatter, 'id')) === `zentao-execution-${executionId}`) {
      const nestedTaskFolder = path.join(path.dirname(filePath), EXECUTION_TASKS_FOLDER);
      const legacyTaskFolder = filePath.replace(/\.md$/, '_tasks');
      return {
        filePath,
        taskFolder: fs.existsSync(nestedTaskFolder) ? nestedTaskFolder : legacyTaskFolder,
      };
    }
  }
  throw new Error(`未找到迭代 ${executionId} 对应的 Project Manager 项目`);
}

function readLocalItems(vault, taskFolder, executionId) {
  const items = [];
  for (const filePath of walkMarkdownFiles(taskFolder)) {
    const frontmatter = splitFrontmatter(fs.readFileSync(filePath, 'utf8')).frontmatter;
    if (parseScalar(frontmatter, 'pm-task') !== true) {
      continue;
    }

    const sourceType = String(parseNestedScalar(frontmatter, 'customFields', 'zentaoSourceType') || '');
    if (!['story', 'task'].includes(sourceType)) {
      continue;
    }
    const itemExecution = String(parseNestedScalar(frontmatter, 'customFields', 'executionId') || executionId);
    if (itemExecution !== String(executionId) && sourceType === 'task') {
      continue;
    }

    const zentaoId = String(parseNestedScalar(frontmatter, 'customFields', 'zentaoId') || '');
    if (!/^\d+$/.test(zentaoId)) {
      throw new Error(`文件缺少有效禅道 ID：${path.relative(vault, filePath)}`);
    }

    let baseline = null;
    const baselineRaw = parseNestedScalar(frontmatter, 'customFields', 'zentaoPushBaseline');
    if (baselineRaw) {
      try {
        baseline = typeof baselineRaw === 'string' ? JSON.parse(baselineRaw) : baselineRaw;
      } catch (error) {
        throw new Error(`写回基线损坏：${path.relative(vault, filePath)}`);
      }
    }

    const assigneesRaw = parseScalar(frontmatter, 'assignees');
    items.push({
      kind: sourceType,
      id: zentaoId,
      filePath,
      relativePath: path.relative(vault, filePath),
      baseline,
      local: {
        title: String(parseScalar(frontmatter, 'title') || ''),
        stage: String(parseScalar(frontmatter, 'stage') || ''),
        status: String(parseScalar(frontmatter, 'status') || ''),
        priority: String(parseScalar(frontmatter, 'priority') || ''),
        start: normalizeDate(parseScalar(frontmatter, 'start')),
        due: normalizeDate(parseScalar(frontmatter, 'due')),
        assignees: Array.isArray(assigneesRaw) ? assigneesRaw.map(String) : [],
        timeEstimate: numericValue(parseScalar(frontmatter, 'timeEstimate') || parseNestedScalar(frontmatter, 'customFields', 'estimatedHours')),
        zentaoModuleId: objectId(parseNestedScalar(frontmatter, 'customFields', 'zentaoModuleId')),
        storyId: objectId(parseNestedScalar(frontmatter, 'customFields', 'storyId')),
      },
    });
  }
  return items;
}

function createAccountResolver(users) {
  const byAccount = new Map();
  const byName = new Map();
  for (const user of users) {
    const account = String(user.account || '');
    const name = String(user.realname || user.name || account);
    if (!account) {
      continue;
    }
    byAccount.set(account, account);
    const accounts = byName.get(name) || [];
    accounts.push(account);
    byName.set(name, accounts);
  }

  return function resolveAccount(names) {
    if (!Array.isArray(names) || names.length === 0) {
      return '';
    }
    if (names.length > 1) {
      throw new Error(`禅道任务只支持单个指派人，本地当前为：${names.join('、')}`);
    }
    const name = String(names[0]);
    if (byAccount.has(name)) {
      return name;
    }
    const accounts = byName.get(name) || [];
    if (accounts.length !== 1) {
      throw new Error(accounts.length > 1 ? `姓名 ${name} 对应多个禅道账号` : `无法把姓名 ${name} 解析为禅道账号`);
    }
    return accounts[0];
  };
}

function addFieldChange(context, specification) {
  const {
    localKey,
    remoteKey,
    label,
    localValue,
    desiredRemote,
    currentRemote,
    requiresBaseline = false,
  } = specification;
  const baselineLocal = context.localItem.baseline?.local?.[localKey];
  const baselineRemote = context.localItem.baseline?.remote?.[remoteKey];
  const hasBaseline = baselineLocal !== undefined && baselineRemote !== undefined;

  if (requiresBaseline && !hasBaseline) {
    return;
  }

  const changedLocally = hasBaseline
    ? !valuesEqual(localValue, baselineLocal)
    : !valuesEqual(desiredRemote, currentRemote);
  if (!changedLocally || valuesEqual(desiredRemote, currentRemote)) {
    return;
  }

  if (hasBaseline && !valuesEqual(currentRemote, baselineRemote)) {
    context.conflicts.push({
      object: `${context.kindLabel} #${context.localItem.id}`,
      field: label,
      baseline: baselineRemote,
      remote: currentRemote,
      local: desiredRemote,
      file: context.localItem.relativePath,
    });
    return;
  }

  context.operation.data[remoteKey] = desiredRemote;
  context.operation.fields.push({ field: label, from: currentRemote, to: desiredRemote });
}

function buildTaskOperation(localItem, remote, resolveAccount, conflicts, unsupported) {
  const operation = { kind: 'task', id: localItem.id, file: localItem.relativePath, data: {}, fields: [] };
  const context = { localItem, operation, conflicts, kindLabel: '任务' };
  let assignedTo;
  try {
    assignedTo = resolveAccount(localItem.local.assignees);
  } catch (error) {
    unsupported.push({ object: `任务 #${localItem.id}`, field: '指派人', reason: error.message, file: localItem.relativePath });
    assignedTo = normalizedAssignedAccount(remote.assignedTo);
  }

  const specifications = [
    ['title', 'name', '名称', localItem.local.title, localItem.local.title, String(remote.name || '')],
    ['priority', 'pri', '优先级', localItem.local.priority, mapPriorityToZenTao(localItem.local.priority), String(remote.pri || '')],
    ['assignees', 'assignedTo', '指派人', localItem.local.assignees, assignedTo, normalizedAssignedAccount(remote.assignedTo)],
    ['timeEstimate', 'estimate', '预计工时', localItem.local.timeEstimate, localItem.local.timeEstimate, numericValue(remote.estimate)],
    ['zentaoModuleId', 'module', '所属模块', localItem.local.zentaoModuleId, localItem.local.zentaoModuleId || '0', objectId(remote.module) || '0'],
    ['storyId', 'story', '关联需求', localItem.local.storyId, localItem.local.storyId || '0', objectId(remote.story) || '0'],
  ];
  for (const [localKey, remoteKey, label, localValue, desiredRemote, currentRemote] of specifications) {
    addFieldChange(context, { localKey, remoteKey, label, localValue, desiredRemote, currentRemote });
  }
  const dateSpecifications = [
    {
      localKey: 'start',
      remoteKey: 'estStarted',
      label: '预计开始',
      localValue: localItem.local.start,
      currentRemote: normalizeDate(remote.estStarted),
      // 没有显式基线时，使用拉取脚本当时会生成的本地值作为兼容基线。
      fallbackLocal: normalizeDate(remote.estStarted || remote.realStarted || remote.openedDate),
    },
    {
      localKey: 'due',
      remoteKey: 'deadline',
      label: '截止日期',
      localValue: localItem.local.due,
      currentRemote: normalizeDate(remote.deadline),
      fallbackLocal: normalizeDate(remote.deadline || remote.estFinished || remote.realFinished),
    },
  ];
  for (const specification of dateSpecifications) {
    const hasBaseline = localItem.baseline?.local?.[specification.localKey] !== undefined
      && localItem.baseline?.remote?.[specification.remoteKey] !== undefined;
    if (hasBaseline) {
      addFieldChange(context, {
        ...specification,
        desiredRemote: specification.localValue,
      });
      continue;
    }

    // 旧文件或 Project Manager 缓存覆盖基线时，仅当本地日期偏离同步推导值才进入预览。
    if (!valuesEqual(specification.localValue, specification.fallbackLocal)
      && !valuesEqual(specification.localValue, specification.currentRemote)) {
      operation.data[specification.remoteKey] = specification.localValue;
      operation.fields.push({
        field: specification.label,
        from: specification.currentRemote,
        to: specification.localValue,
      });
    }
  }

  const baselineStatus = localItem.baseline?.local?.status;
  if (baselineStatus !== undefined && localItem.local.status !== baselineStatus && localItem.local.status !== String(remote.status || '')) {
    unsupported.push({
      object: `任务 #${localItem.id}`,
      field: '状态',
      reason: `状态流转需要 start/finish/activate/close 专用动作，当前不会自动写入（${remote.status} → ${localItem.local.status}）`,
      file: localItem.relativePath,
    });
  }
  const baselineStage = localItem.baseline?.local?.stage;
  if (baselineStage !== undefined && localItem.local.stage !== baselineStage && localItem.local.stage !== String(remote.type || '')) {
    unsupported.push({
      object: `任务 #${localItem.id}`,
      field: '阶段',
      reason: `任务阶段直接对应禅道任务类型，当前不在通用写回白名单中（${remote.type} → ${localItem.local.stage}）`,
      file: localItem.relativePath,
    });
  }
  if (operation.fields.length > 0) {
    // 禅道任务 PUT 接口会把部分缺省字段重置为默认值，因此写入时携带完整可编辑字段。
    // operation.data 放在最后，确保用户确认的目标值覆盖当前远端值。
    operation.data = {
      name: String(remote.name || ''),
      type: String(remote.type || ''),
      assignedTo: normalizedAssignedAccount(remote.assignedTo),
      estStarted: normalizeDate(remote.estStarted),
      deadline: normalizeDate(remote.deadline),
      pri: String(remote.pri ?? ''),
      estimate: numericValue(remote.estimate),
      module: objectId(remote.module) || '0',
      story: objectId(remote.story) || '0',
      desc: String(remote.desc || remote.description || ''),
      ...operation.data,
    };
  }
  return operation;
}

function buildStoryOperation(localItem, remote, resolveAccount, conflicts, unsupported) {
  const operation = { kind: 'story', id: localItem.id, file: localItem.relativePath, data: {}, fields: [] };
  const context = { localItem, operation, conflicts, kindLabel: '需求' };
  let assignedTo;
  try {
    assignedTo = resolveAccount(localItem.local.assignees);
  } catch (error) {
    unsupported.push({ object: `需求 #${localItem.id}`, field: '指派人', reason: error.message, file: localItem.relativePath });
    assignedTo = normalizedAssignedAccount(remote.assignedTo);
  }
  const desiredTitle = normalizeLegacyRequirementTitle(localItem.local.title, localItem.id);
  const specifications = [
    ['title', 'title', '名称', localItem.local.title, desiredTitle, String(remote.title || remote.name || '')],
    ['priority', 'pri', '优先级', localItem.local.priority, mapPriorityToZenTao(localItem.local.priority), String(remote.pri || '')],
    ['assignees', 'assignedTo', '指派人', localItem.local.assignees, assignedTo, normalizedAssignedAccount(remote.assignedTo)],
    ['timeEstimate', 'estimate', '预计工时', localItem.local.timeEstimate, localItem.local.timeEstimate, numericValue(remote.estimate)],
    ['zentaoModuleId', 'module', '所属模块', localItem.local.zentaoModuleId, localItem.local.zentaoModuleId || '0', objectId(remote.module) || '0'],
  ];
  for (const [localKey, remoteKey, label, localValue, desiredRemote, currentRemote] of specifications) {
    addFieldChange(context, { localKey, remoteKey, label, localValue, desiredRemote, currentRemote });
  }

  const baselineStatus = localItem.baseline?.local?.status;
  if (baselineStatus !== undefined && localItem.local.status !== baselineStatus && localItem.local.status !== String(remote.status || '')) {
    unsupported.push({
      object: `需求 #${localItem.id}`,
      field: '状态',
      reason: `需求状态需要 change/activate/close 专用动作，当前不会自动写入（${remote.status} → ${localItem.local.status}）`,
      file: localItem.relativePath,
    });
  }
  const baselineStage = localItem.baseline?.local?.stage;
  if (baselineStage !== undefined && localItem.local.stage !== baselineStage && localItem.local.stage !== String(remote.stage || '')) {
    unsupported.push({
      object: `需求 #${localItem.id}`,
      field: '阶段',
      reason: `需求阶段需要禅道需求工作流或专用接口处理，当前不会自动写入（${remote.stage} → ${localItem.local.stage}）`,
      file: localItem.relativePath,
    });
  }

  if (operation.fields.length > 0) {
    // 需求更新同样采用 PUT 语义，携带接口支持的完整字段，避免未修改字段被默认值覆盖。
    operation.data = {
      title: String(remote.title || remote.name || ''),
      pri: String(remote.pri ?? ''),
      module: objectId(remote.module) || '0',
      parent: objectId(remote.parent) || '0',
      plan: objectId(remote.plan) || '0',
      estimate: numericValue(remote.estimate),
      category: String(remote.category || ''),
      source: String(remote.source || ''),
      assignedTo: normalizedAssignedAccount(remote.assignedTo),
      ...operation.data,
    };
  }
  return operation;
}

function buildPlan(options, vault, projectsFolder) {
  const project = findExecutionProject(vault, projectsFolder, options.execution);
  const localItems = readLocalItems(vault, project.taskFolder, options.execution);
  const remoteTasks = getCliList(options, 'task', [`--executionID=${options.execution}`, '--status=all']);
  const remoteStories = getCliList(options, 'story', [`--execution=${options.execution}`]);
  const users = getCliList(options, 'user', ['--browseType=inside']);
  const resolveAccount = createAccountResolver(users);
  const tasksById = new Map(remoteTasks.map((item) => [String(item.id), item]));
  const storiesById = new Map(remoteStories.map((item) => [String(item.id), item]));
  const conflicts = [];
  const unsupported = [];
  const missing = [];
  const operations = [];
  let withoutBaseline = 0;

  for (const localItem of localItems) {
    if (!localItem.baseline) {
      withoutBaseline += 1;
    }
    const remote = localItem.kind === 'task' ? tasksById.get(localItem.id) : storiesById.get(localItem.id);
    if (!remote) {
      missing.push({
        object: `${localItem.kind === 'task' ? '任务' : '需求'} #${localItem.id}`,
        file: localItem.relativePath,
        reason: '当前迭代的禅道数据中不存在该对象',
      });
      continue;
    }

    const operation = localItem.kind === 'task'
      ? buildTaskOperation(localItem, remote, resolveAccount, conflicts, unsupported)
      : buildStoryOperation(localItem, remote, resolveAccount, conflicts, unsupported);
    if (operation.fields.length > 0) {
      operations.push(operation);
    }
  }

  operations.sort((left, right) => `${left.kind}-${left.id}`.localeCompare(`${right.kind}-${right.id}`, 'en', { numeric: true }));
  // 计划哈希覆盖完整预览，确保阶段或状态等“只报告”差异发生变化时，旧确认同样失效。
  const hashSource = JSON.stringify({
    execution: String(options.execution),
    operations,
    conflicts,
    unsupported,
    missing,
    withoutBaseline,
  });
  const hash = crypto.createHash('sha256').update(hashSource).digest('hex');
  return {
    version: 1,
    execution: String(options.execution),
    projectFile: path.relative(vault, project.filePath),
    taskFolder: path.relative(vault, project.taskFolder),
    localItems: localItems.length,
    operations,
    conflicts,
    unsupported,
    missing,
    withoutBaseline,
    hash,
  };
}

function savePlan(plan) {
  fs.mkdirSync(PLAN_DIRECTORY, { recursive: true, mode: 0o700 });
  const filePath = path.join(PLAN_DIRECTORY, `${plan.hash}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

function applyPlan(options, plan) {
  if (plan.hash !== options.planHash) {
    throw new Error(`计划已变化，拒绝更新。原确认哈希 ${options.planHash.slice(0, 12)}，当前哈希 ${plan.hash.slice(0, 12)}`);
  }
  if (plan.conflicts.length > 0) {
    throw new Error(`存在 ${plan.conflicts.length} 个远端冲突，拒绝自动覆盖`);
  }

  for (const operation of plan.operations) {
    if (!['task', 'story'].includes(operation.kind)) {
      throw new Error(`拒绝更新非白名单对象：${operation.kind}`);
    }
    cliJson(options, [
      operation.kind,
      'update',
      operation.id,
      `--data=${JSON.stringify(operation.data)}`,
    ]);
  }
}

function displayValue(value) {
  if (Array.isArray(value)) {
    return value.length ? value.join('、') : '（空）';
  }
  if (value === '' || value === null || value === undefined) {
    return '（空）';
  }
  return String(value);
}

function printPlan(plan, applied, asJson) {
  if (asJson) {
    console.log(JSON.stringify({ mode: applied ? 'applied' : 'preview', ...plan }, null, 2));
    return;
  }

  console.log(`${applied ? '已更新禅道' : '禅道写回预览'}：迭代 #${plan.execution}`);
  console.log(`扫描本地对象：${plan.localItems}；待更新对象：${plan.operations.length}；冲突：${plan.conflicts.length}；暂不支持：${plan.unsupported.length}；远端缺失：${plan.missing.length}`);
  for (const operation of plan.operations) {
    console.log(`- ${operation.kind === 'task' ? '任务' : '需求'} #${operation.id}（${operation.file}）`);
    for (const field of operation.fields) {
      console.log(`  - ${field.field}：${displayValue(field.from)} → ${displayValue(field.to)}`);
    }
  }
  for (const conflict of plan.conflicts) {
    console.log(`- 冲突 ${conflict.object} / ${conflict.field}：远端=${displayValue(conflict.remote)}，本地拟写入=${displayValue(conflict.local)}`);
  }
  for (const item of plan.unsupported) {
    console.log(`- 暂不支持 ${item.object} / ${item.field}：${item.reason}`);
  }
  for (const item of plan.missing) {
    console.log(`- 远端缺失 ${item.object}：${item.reason}`);
  }
  if (plan.withoutBaseline > 0) {
    console.log(`警告：${plan.withoutBaseline} 个对象尚无字段级同步基线；本次会显示差异，但无法识别远端并发修改。完成一次拉取同步后将自动建立基线。`);
  }
  if (!applied) {
    console.log(`计划哈希：${plan.hash}`);
    console.log('当前仅为预览，没有更新禅道。用户明确确认后，使用相同计划哈希执行。');
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const vault = assertVault(options.vault);
  const projectsFolder = readProjectsFolder(vault, options.projectsFolder);
  const plan = buildPlan(options, vault, projectsFolder);

  if (options.apply) {
    applyPlan(options, plan);
    const verified = buildPlan(options, vault, projectsFolder);
    if (verified.operations.length > 0) {
      throw new Error(`禅道更新后仍检测到 ${verified.operations.length} 个未生效对象，请停止并人工检查`);
    }
    printPlan(plan, true, options.json);
    return;
  }

  savePlan(plan);
  printPlan(plan, false, options.json);
}

try {
  main();
} catch (error) {
  console.error(`禅道写回失败：${redactSensitiveText(error.message)}`);
  process.exitCode = 1;
}

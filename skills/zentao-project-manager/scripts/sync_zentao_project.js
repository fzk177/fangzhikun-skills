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
const DASHBOARD_ARCHIVED_PROJECTS_SETTING = 'dashboardArchivedProjects';
const EXECUTION_OVERVIEW_FILE = '00.迭代总览.md';
const EXECUTION_TASKS_FOLDER = '01.需求与任务';
const EXECUTION_MANAGEMENT_FOLDER = '02.项目管理';
const EXECUTION_DATA_SUPPORT_FOLDER = '03.数据支持';
const EXECUTION_BUG_FACTS_FILE = 'zentao-bug-facts.json';
const EXECUTION_ITERATION_SUMMARY_FILE = 'zentao-iteration-summary.json';
const EXECUTION_ORPHANED_ITEMS_FILE = 'zentao-orphaned-items.json';
const ITERATION_DELIVERY_PLANS_SETTING = 'iterationDeliveryPlans';
const KEYCHAIN_SERVICE = String(RUNTIME_CONFIG.zentao?.keychainService || 'zentao-cli');
const DEFAULT_ACCOUNT = String(RUNTIME_CONFIG.zentao?.account || '');
const DEFAULT_SERVER = String(RUNTIME_CONFIG.zentao?.server || '');
const DEFAULT_PAGE_SIZE = 200;
const CLI_TIMEOUT_MS = 60000;
const CLI_MAX_BUFFER = 64 * 1024 * 1024;
const SYNC_BLOCK_PATTERN = /<!-- zentao-sync:start -->[\s\S]*?<!-- zentao-sync:end -->/g;
const ZENTAO_MANAGED_TASK_CUSTOM_FIELDS = new Set([
  'zentaoSourceType',
  'zentaoId',
  'zentaoUrl',
  'zentaoModule',
  'zentaoModuleId',
  'executionId',
  'storyId',
  'completedBy',
  'estimatedHours',
  'consumedHours',
  'remainingHours',
  'actualStartedAt',
  'actualFinishedAt',
  'sourceUpdatedAt',
  'zentaoPushBaseline',
  'displayEstimatedHours',
  'displayConsumedHours',
  'displayRemainingHours',
  'bugTotal',
  'bugUnclosed',
  'bugUnclosedSeverity1',
  'bugUnclosedSeverity2',
  'bugUnresolved',
  'bugResolvedOpen',
  'bugClosed',
  'bugSummary',
  'zentaoSyncState',
  'zentaoMissingSince',
  'zentaoLastCheckedAt',
  'zentaoStateChangedAt',
  'zentaoMissingCount',
  'zentaoRemoteExecutionIds',
]);
const HOUR_ROUNDING_FACTOR = 100;
const HOUR_COMPARISON_EPSILON = 1e-9;
const DEVELOPMENT_TASK_STAGES = new Set(['devel', 'develop', 'development', 'dev']);
const TEST_TASK_STAGES = new Set(['test', 'testing', 'qa']);
const REQUIREMENT_MANAGEMENT_TAGS = new Set(['未分配开发', '未分配测试', '未更新工时']);
const ZENTAO_ORPHAN_STATE = Object.freeze({
  MISSING_UNCONFIRMED: 'missing_unconfirmed',
  MOVED_TO_OTHER_EXECUTION: 'moved_to_other_execution',
  REMOVED_FROM_EXECUTION: 'removed_from_execution',
  DELETED_REMOTE: 'deleted_remote',
  VERIFY_FAILED: 'verify_failed',
});
const ZENTAO_ORPHAN_SOURCE_TYPES = new Set(['story', 'task']);
const ITERATION_THEME_RULES = (RUNTIME_CONFIG.zentaoProjectManager?.iterationThemeRules || [])
  .map((rule) => ({
    label: String(rule.label || ''),
    pattern: new RegExp(String(rule.pattern || '(?!)'), 'iu'),
  }))
  .filter((rule) => rule.label);

function printHelp() {
  console.log([
    '用法:',
    '  sync_zentao_project.js --execution <迭代ID> [选项]',
    '  sync_zentao_project.js --all-local [--include-archived] [选项]',
    '',
    '同步模型:',
    '  迭代：需求为顶层事项，关联任务为子任务，未关联需求的任务保持顶层；',
    '        首次同步同时初始化项目管理记录和上线准备记录；后续同步比较并更新',
    '        禅道同步属性，同时维护整体与交付批次迭代总结，保留手工正文和本地',
    '        管理属性；远端不再出现的事项软失效并写入遗留清单，不物理删除；',
    '        不生成禅道项目汇总。',
    '',
    '选项:',
    '  --vault <目录>              Obsidian vault 根目录，默认当前目录',
    '  --projects-folder <目录>    Project Manager 项目目录，默认读取插件配置',
    '  --system-folder <目录>      新迭代归属的一级系统目录；已有迭代忽略此参数并沿用原目录',
    '  --all-local                 更新本地已存在的全部禅道迭代，默认跳过已归档项目',
    '  --include-archived          与 --all-local 配合，同时更新已归档项目',
    '  --config <文件>             zentao-cli 配置文件',
    '  --cli <文件>                zentao-cli 可执行文件，默认 zentao',
    '  --apply                     实际写入；不传时仅预览',
    '  --dry-run                   明确指定仅预览',
    '  --compact                   文本模式只输出汇总、属性差异和异常，省略普通变更文件明细',
    '  --json                      使用 JSON 输出同步摘要',
    '  -h, --help                  显示帮助',
    '',
    '认证:',
    `  Token 缺失或失效时，从 macOS 钥匙串服务 ${KEYCHAIN_SERVICE} 读取当前账号凭据，`,
    '  再通过 zentao login --useEnv 自动恢复登录。密码不会写入命令行、文件或输出。',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {
    apply: false,
    cli: DEFAULT_CLI,
    compact: false,
    config: DEFAULT_CONFIG,
    json: false,
    includeArchived: false,
    profileCache: {
      cli: null,
      config: null,
    },
    projectsFolder: '',
    systemFolder: '',
    vault: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--execution') {
      const value = argv[index + 1];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error(`${argument} 必须提供纯数字 ID`);
      }

      if (options.scope) {
        throw new Error('--execution 只能指定一次');
      }

      options.scope = argument.slice(2);
      options.id = value;
      index += 1;
      continue;
    }

    if (argument === '--all-local') {
      if (options.scope) {
        throw new Error('--all-local 不能与 --execution 同时使用');
      }

      options.scope = 'all-local';
      continue;
    }

    if (['--vault', '--projects-folder', '--system-folder', '--config', '--cli'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} 缺少参数值`);
      }

      const keyMap = {
        '--vault': 'vault',
        '--projects-folder': 'projectsFolder',
        '--system-folder': 'systemFolder',
        '--config': 'config',
        '--cli': 'cli',
      };
      options[keyMap[argument]] = value;
      index += 1;
      continue;
    }

    if (argument === '--apply') {
      options.apply = true;
      continue;
    }

    if (argument === '--dry-run') {
      options.apply = false;
      continue;
    }

    if (argument === '--json') {
      options.json = true;
      continue;
    }

    if (argument === '--compact') {
      options.compact = true;
      continue;
    }

    if (argument === '--include-archived') {
      options.includeArchived = true;
      continue;
    }

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    throw new Error(`不支持的参数：${argument}`);
  }

  if (!options.help && !options.scope) {
    throw new Error('必须指定 --execution <迭代ID> 或 --all-local');
  }

  if (!options.help && options.scope === 'execution' && !options.id) {
    throw new Error('必须指定 --execution <迭代ID>');
  }

  if (!options.help && options.includeArchived && options.scope !== 'all-local') {
    throw new Error('--include-archived 只能与 --all-local 配合使用；指定 --execution 时无论是否归档都会更新');
  }

  return options;
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/("?(?:password|token|secret|session|cookie)"?\s*[:=]\s*)[^,\s}\]]+/gi, '$1***')
    .replace(/([?&](?:password|token|secret|session)=)[^&\s]+/gi, '$1***');
}

function findErrorCode(value) {
  const text = String(value || '');
  const match = text.match(/"code"\s*:\s*"?(1001|1004)"?/);
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

  let body = null;
  try {
    body = JSON.parse(result.stdout || '{}');
  } catch (error) {
    if (result.status !== 0) {
      const cliError = new Error(`zentao-cli 查询失败：${redactSensitiveText(combined.trim())}`);
      cliError.authCode = findErrorCode(combined);
      throw cliError;
    }

    throw new Error(`zentao-cli 返回的不是有效 JSON：${redactSensitiveText(error.message)}`);
  }

  if (result.status !== 0 || body.status === 'fail' || body.error) {
    const cliError = new Error(`zentao-cli 查询失败：${redactSensitiveText(JSON.stringify(body.error || body.message || body))}`);
    cliError.authCode = findErrorCode(combined) || findErrorCode(JSON.stringify(body));
    throw cliError;
  }

  return body;
}

function getProfileWithoutRelogin(options) {
  if (options.profileCache?.cli) {
    return options.profileCache.cli;
  }

  try {
    const body = rawCliJson(options, ['profile']);
    const profile = (body.profiles || []).find((item) => item.current) || {};
    if (options.profileCache) {
      options.profileCache.cli = profile;
    }
    return profile;
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
      ...process.env,
      ZENTAO_URL: server,
      ZENTAO_ACCOUNT: account,
      ZENTAO_PASSWORD: password,
    },
  });

  if (loginResult.error || loginResult.status !== 0) {
    throw new Error('禅道自动重新登录失败，请检查服务地址、CLI 配置或本机钥匙串凭据');
  }

  // 登录会刷新配置文件中的 Token，清空配置缓存后再执行原请求。
  if (options.profileCache) {
    options.profileCache.cli = { account, server };
    options.profileCache.config = null;
  }
}

function readOnlyCliJson(options, args) {
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

function getCurrentConfigProfile(options) {
  if (options.profileCache?.config) {
    return options.profileCache.config;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(options.config, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 zentao-cli 配置：${redactSensitiveText(error.message)}`);
  }

  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const current = getProfileWithoutRelogin(options);
  const profile = profiles.find((item) => (
    String(item.account || '') === String(current.account || '')
    && String(item.server || '').replace(/\/+$/, '') === String(current.server || '').replace(/\/+$/, '')
  )) || profiles[0] || null;
  if (options.profileCache) {
    options.profileCache.config = profile;
  }
  return profile;
}

function rawApiJson(options, apiPath, query = {}) {
  const profile = getCurrentConfigProfile(options);
  if (!profile?.token) {
    const authError = new Error('zentao-cli 当前配置缺少可用 Token');
    authError.authCode = '1001';
    throw authError;
  }

  const server = String(profile.server || DEFAULT_SERVER).replace(/\/+$/, '');
  const url = new URL(`${server}/api.php/v2/${String(apiPath).replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }

  // Token 通过标准输入交给 curl，不放入命令行参数、日志或错误输出。
  const result = spawn('curl', [
    '--silent',
    '--show-error',
    '--max-time',
    String(Math.ceil(CLI_TIMEOUT_MS / 1000)),
    '--request',
    'GET',
    '--header',
    '@-',
    '--write-out',
    '\n%{http_code}',
    url.toString(),
  ], {
    input: `Token: ${profile.token}\nContent-Type: application/json\n`,
  });

  if (result.error || result.status !== 0) {
    throw new Error(`禅道 REST API 查询失败：${redactSensitiveText(result.stderr || result.error?.message || '')}`);
  }

  const output = String(result.stdout || '');
  const separator = output.lastIndexOf('\n');
  const responseText = separator >= 0 ? output.slice(0, separator) : output;
  const statusCode = Number(separator >= 0 ? output.slice(separator + 1) : 0);
  if (statusCode === 401) {
    const authError = new Error('禅道 REST API Token 已失效');
    authError.authCode = '1004';
    throw authError;
  }
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`禅道 REST API 查询失败（HTTP ${statusCode}）：${redactSensitiveText(responseText)}`);
  }

  try {
    return JSON.parse(responseText || '{}');
  } catch (error) {
    throw new Error(`禅道 REST API 返回的不是有效 JSON：${redactSensitiveText(error.message)}`);
  }
}

function readOnlyApiJson(options, apiPath, query = {}) {
  try {
    return rawApiJson(options, apiPath, query);
  } catch (error) {
    if (error.authCode !== '1001' && error.authCode !== '1004') {
      throw error;
    }

    restoreLoginFromKeychain(options);
    return rawApiJson(options, apiPath, query);
  }
}

function getCliList(options, moduleName, params = []) {
  const allowedModules = new Set(['bug', 'execution', 'story', 'task', 'user']);
  if (!allowedModules.has(moduleName)) {
    throw new Error(`拒绝执行非白名单禅道模块：${moduleName}`);
  }

  const items = [];
  let page = 1;

  while (true) {
    const body = readOnlyCliJson(options, [
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

function uniqueBy(items, keySelector) {
  const result = [];
  const keys = new Set();

  for (const item of items) {
    const key = keySelector(item);
    if (keys.has(key)) {
      continue;
    }

    keys.add(key);
    result.push(item);
  }

  return result;
}

function loadExecutions(options) {
  return getCliList(options, 'execution', ['--status=all']);
}

function loadTasks(options, executionId) {
  return getCliList(options, 'task', [`--executionID=${executionId}`, '--status=all']);
}

function loadStories(options, executionId) {
  return getCliList(options, 'story', [`--execution=${executionId}`]);
}

function loadBugs(options, executionId) {
  return getCliList(options, 'bug', [
    `--execution=${executionId}`,
    '--browseType=all',
    '--pick=id,story,severity,status,assignedTo,resolvedBy,deleted',
  ]);
}

/**
 * 读取单个禅道需求或任务详情，仅用于确认远端遗留原因。
 *
 * 详情正文属于不可信数据，本方法只返回对象，由调用方摘取 ID、删除标记和迭代归属。
 */
function loadZenTaoObjectDetail(options, sourceType, objectId) {
  if (!ZENTAO_ORPHAN_SOURCE_TYPES.has(sourceType) || !/^\d+$/u.test(String(objectId))) {
    throw new Error(`无法验证不受支持的禅道对象：${sourceType} #${objectId}`);
  }

  const body = readOnlyCliJson(options, [sourceType, String(objectId)]);
  const nested = body[sourceType];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested;
  }
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return body.data;
  }
  if (String(body.id || '') === String(objectId)) {
    return body;
  }

  return null;
}

function loadStoryDetails(options, stories, context) {
  return stories.map((story) => {
    const storyId = String(story.id);

    // 需求列表不包含历史备注，因此按需求读取详情；同一次同步中重复出现的需求复用缓存结果。
    if (!context.storyDetails.has(storyId)) {
      try {
        const body = readOnlyApiJson(options, `stories/${storyId}`);
        if (body.status === 'fail' || body.error) {
          throw new Error(`禅道需求详情接口返回失败：${redactSensitiveText(body.message || body.error || '')}`);
        }
        if (!body.story || typeof body.story !== 'object') {
          throw new Error('禅道需求详情接口未返回需求对象');
        }
        if (!Array.isArray(body.actions)) {
          context.storyWarnings.push(`需求 #${storyId} 的详情中未返回历史操作，备注可能不完整`);
        }

        context.storyDetails.set(storyId, {
          story: body.story,
          actions: Array.isArray(body.actions) ? body.actions : [],
        });
      } catch (error) {
        context.storyDetails.set(storyId, { story: {}, actions: [] });
        context.storyWarnings.push(`需求 #${storyId} 的详情与备注获取失败：${redactSensitiveText(error.message)}`);
      }
    }

    const detail = context.storyDetails.get(storyId);
    return {
      ...story,
      ...detail.story,
      zentaoActions: detail.actions,
    };
  });
}

function loadUsers(options) {
  return getCliList(options, 'user', ['--browseType=inside']);
}

function normalizeModulePath(value) {
  return String(value || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' / ');
}

function loadExecutionModuleNames(options, executionId) {
  const body = readOnlyApiJson(
    options,
    `executions/${executionId}/task/modules`,
    { executionID: executionId, rootID: executionId },
  );
  const modules = body.modules && typeof body.modules === 'object' ? body.modules : {};
  const result = new Map([['0', '未设置']]);

  for (const [moduleId, modulePath] of Object.entries(modules)) {
    const normalized = normalizeModulePath(modulePath);
    result.set(String(moduleId), normalized || '未设置');
  }

  return result;
}

function mergeModuleNames(target, source) {
  for (const [moduleId, moduleName] of source) {
    if (moduleName) {
      target.set(String(moduleId), moduleName);
    }
  }
}

function createModuleResolver(moduleNames) {
  return function moduleName(value) {
    const moduleId = extractObjectId(value);
    if (moduleId === '0') {
      return '未设置';
    }

    return moduleNames.get(moduleId) || `模块 #${moduleId}`;
  };
}

function accountValue(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'object') {
    return value.account || '';
  }

  return String(value);
}

function createPersonResolver(users) {
  const byAccount = new Map(users.map((user) => [String(user.account), user]));

  return function person(value) {
    if (!value) {
      return '';
    }

    if (typeof value === 'object') {
      return value.realname || value.name || value.account || '';
    }

    const account = String(value);
    if (account === 'closed') {
      return '';
    }

    const user = byAccount.get(account);
    return user?.realname || user?.name || account;
  };
}

function normalizeDate(value) {
  if (!value || value === '0000-00-00' || value === '0000-00-00 00:00:00') {
    return '';
  }

  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function normalizeDateTime(value) {
  if (!value || String(value).startsWith('0000-00-00')) {
    return '';
  }

  const match = String(value).trim().replace('T', ' ').match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2})(?::(\d{2}))?)?/);
  if (!match) {
    return '';
  }

  return match[2] ? `${match[1]} ${match[2]}:${match[3] || '00'}` : match[1];
}

function normalizeIsoDate(value, fallback = '') {
  if (!value || String(value).startsWith('0000-00-00')) {
    return fallback;
  }

  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function mapPriority(priority) {
  const numeric = Number(priority);
  if (numeric === 1) {
    return 'critical';
  }
  if (numeric === 2) {
    return 'high';
  }
  if (numeric === 4) {
    return 'low';
  }
  return 'medium';
}

function calculateProgress(task, completed) {
  if (completed) {
    return 100;
  }

  const direct = Number(task.progress);
  if (Number.isFinite(direct)) {
    return Math.max(0, Math.min(100, Math.round(direct)));
  }

  const consumed = Number(task.consumed);
  const left = Number(task.left);
  if (Number.isFinite(consumed) && Number.isFinite(left) && consumed + left > 0) {
    return Math.round((consumed / (consumed + left)) * 100);
  }

  return 0;
}

function numericValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundHours(value) {
  return Math.round((numericValue(value) + Number.EPSILON) * HOUR_ROUNDING_FACTOR) / HOUR_ROUNDING_FACTOR;
}

function formatHours(value) {
  return String(roundHours(value));
}

function buildTimeVarianceTag(estimatedHours, consumedHours, completed) {
  const estimated = roundHours(estimatedHours);
  const consumed = roundHours(consumedHours);
  const difference = roundHours(Math.abs(consumed - estimated));
  if (difference <= HOUR_COMPARISON_EPSILON) {
    return '';
  }

  if (consumed > estimated) {
    return `超时${formatHours(difference)}h`;
  }

  return completed ? `提前${formatHours(difference)}h` : '';
}

function isManagedWorkTag(tag) {
  return REQUIREMENT_MANAGEMENT_TAGS.has(tag) || tag.startsWith('超时') || tag.startsWith('提前');
}

function extractObjectId(value) {
  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null && item !== undefined && String(item) !== '0');
    return first === undefined ? '0' : extractObjectId(first);
  }

  if (value && typeof value === 'object') {
    return String(value.id || value.story || value.value || '0');
  }

  return String(value || '0');
}

function normalizeBugAccount(value) {
  const account = accountValue(value);
  return account === 'closed' ? '' : account;
}

function buildBugFacts(rawBugs, person) {
  const bugs = uniqueBy(rawBugs, (bug) => String(bug.id));
  const facts = [];

  // Bug 只保留洞察所需的最小维度，不把 ID、标题、描述或操作历史写入本地数据文件。
  for (const bug of bugs) {
    if (String(bug.deleted || '0') === '1') {
      continue;
    }

    const storyId = extractObjectId(bug.story);
    const assignedToAccount = normalizeBugAccount(bug.assignedTo);
    const resolvedByAccount = normalizeBugAccount(bug.resolvedBy);
    facts.push({
      storyId: storyId === '0' ? '' : storyId,
      severity: String(bug.severity || ''),
      status: String(bug.status || '').trim().toLowerCase(),
      assignedToAccount,
      assignedTo: assignedToAccount ? (person(bug.assignedTo) || assignedToAccount) : '',
      resolvedByAccount,
      resolvedBy: resolvedByAccount ? (person(bug.resolvedBy) || resolvedByAccount) : '',
    });
  }

  // 稳定排序保证相同数据重复同步时不会仅因接口返回顺序变化而改写文件。
  return facts.sort((left, right) => [
    left.storyId.localeCompare(right.storyId, 'zh-CN'),
    left.severity.localeCompare(right.severity, 'zh-CN'),
    left.status.localeCompare(right.status, 'zh-CN'),
    left.assignedToAccount.localeCompare(right.assignedToAccount, 'zh-CN'),
    left.resolvedByAccount.localeCompare(right.resolvedByAccount, 'zh-CN'),
  ].find((value) => value !== 0) || 0);
}

function emptyBugStats() {
  return {
    total: 0,
    severity1: 0,
    severity2: 0,
    unresolved: 0,
    resolvedOpen: 0,
    resolved: 0,
    unclosed: 0,
    unclosedSeverity1: 0,
    unclosedSeverity2: 0,
    closed: 0,
  };
}

function aggregateBugFacts(facts) {
  const stats = emptyBugStats();
  for (const fact of facts) {
    const isUnclosed = fact.status !== 'closed';
    const isResolved = fact.status === 'resolved' || fact.status === 'closed';
    stats.total += 1;
    stats.severity1 += Number(fact.severity === '1');
    stats.severity2 += Number(fact.severity === '2');
    stats.unresolved += Number(fact.status === 'active');
    stats.resolvedOpen += Number(fact.status === 'resolved');
    stats.resolved += Number(isResolved);
    stats.unclosed += Number(isUnclosed);
    stats.unclosedSeverity1 += Number(isUnclosed && fact.severity === '1');
    stats.unclosedSeverity2 += Number(isUnclosed && fact.severity === '2');
    stats.closed += Number(fact.status === 'closed');
  }
  return stats;
}

function formatBugPeople(facts, field, predicate) {
  const people = new Map();
  for (const fact of facts.filter(predicate)) {
    const name = String(fact[field] || '').trim() || (field === 'assignedTo' ? '未指派' : '解决人未知');
    people.set(name, (people.get(name) || 0) + 1);
  }
  return [...people.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
    .map(([name, count]) => `${name} ${count}`)
    .join('、') || '—';
}

function renderRequirementBugSummary(facts) {
  const stats = aggregateBugFacts(facts);
  const assignees = formatBugPeople(facts, 'assignedTo', (fact) => fact.status !== 'closed');
  const resolvers = formatBugPeople(facts, 'resolvedBy', (fact) => fact.status === 'resolved' || fact.status === 'closed');
  return [
    '### Bug 汇总',
    '',
    '| Bug总数 | 未关闭 | 未关闭1级 | 未关闭2级 | 未解决 | 待验证/关闭 | 已关闭 |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    `| ${stats.total} | ${stats.unclosed} | ${stats.unclosedSeverity1} | ${stats.unclosedSeverity2} | ${stats.unresolved} | ${stats.resolvedOpen} | ${stats.closed} |`,
    '',
    `- 当前待处理人：${assignees}`,
    `- 解决人：${resolvers}`,
  ].join('\n');
}

function attachBugStatsToRequirements(roots, facts) {
  const factsByStory = new Map();
  for (const fact of facts) {
    if (!fact.storyId) continue;
    const related = factsByStory.get(fact.storyId) || [];
    related.push(fact);
    factsByStory.set(fact.storyId, related);
  }

  for (const { node } of flattenNodes(roots)) {
    if (node.kind !== 'requirement') continue;
    const relatedFacts = factsByStory.get(node.zentaoId) || [];
    const stats = aggregateBugFacts(relatedFacts);
    node.task.customFields.bugTotal = stats.total;
    node.task.customFields.bugUnclosed = stats.unclosed;
    node.task.customFields.bugUnclosedSeverity1 = stats.unclosedSeverity1;
    node.task.customFields.bugUnclosedSeverity2 = stats.unclosedSeverity2;
    node.task.customFields.bugUnresolved = stats.unresolved;
    node.task.customFields.bugResolvedOpen = stats.resolvedOpen;
    node.task.customFields.bugClosed = stats.closed;
    node.task.customFields.bugSummary = stats.unclosed > 0
      ? `未关闭${stats.unclosed}｜S1 ${stats.unclosedSeverity1}｜S2 ${stats.unclosedSeverity2}`
      : '无未关闭Bug';

    const section = renderRequirementBugSummary(relatedFacts);
    node.syncBlock = node.syncBlock.replace(
      '<!-- zentao-sync:end -->',
      `${section}\n<!-- zentao-sync:end -->`,
    );
  }
}

function renderBugFactsData(projectId, executionId, facts) {
  const canonicalRecords = JSON.stringify(facts);
  const dataHash = crypto.createHash('sha256').update(canonicalRecords).digest('hex');
  return `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    executionId,
    recordCount: facts.length,
    dataHash,
    records: facts,
  }, null, 2)}\n`;
}

/**
 * 读取 Project Manager Enhanced 配置；总结只消费交付批次，不修改插件本地设置。
 */
function readProjectManagerPluginData(vault) {
  const dataFile = path.join(
    vault,
    '.obsidian',
    'plugins',
    PROJECT_MANAGER_PLUGIN_ID,
    'data.json',
  );
  if (!fs.existsSync(dataFile)) {
    return {};
  }

  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (error) {
    throw new Error(`无法读取 Project Manager Enhanced 交付批次配置：${error.message}`);
  }
}

/**
 * 统一交付批次的新旧字段，保证旧项目无需先在界面中重新保存也能生成总结。
 */
function normalizeIterationDeliveryPlan(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const batches = (Array.isArray(source.batches) ? source.batches : [])
    .map((batch) => ({
      id: String(batch?.id || ''),
      name: String(batch?.name || ''),
      testingDate: normalizeDate(batch?.testingDate || batch?.testingEnd || batch?.testingStart),
      releaseDate: normalizeDate(batch?.releaseDate || batch?.releaseStart || batch?.releaseEnd),
      owner: String(batch?.owner || ''),
      description: String(batch?.description || '').trim(),
    }))
    .filter((batch) => batch.id);
  const assignments = source.assignments && typeof source.assignments === 'object'
    && !Array.isArray(source.assignments)
    ? Object.fromEntries(Object.entries(source.assignments)
      .map(([itemId, batchId]) => [String(itemId), String(batchId || '')])
      .filter(([itemId, batchId]) => itemId && batchId)
      .sort(([left], [right]) => left.localeCompare(right, 'zh-CN')))
    : {};
  return { version: 2, batches, assignments };
}

/**
 * 交付批次签名只包含会影响总结归纳的字段，人工历史记录不参与无意义改写。
 */
function iterationDeliveryPlanSignature(plan) {
  return JSON.stringify({
    batches: plan.batches.map((batch) => ({
      id: batch.id,
      name: batch.name,
      testingDate: batch.testingDate,
      releaseDate: batch.releaseDate,
      owner: batch.owner,
      description: batch.description,
    })),
    assignments: Object.entries(plan.assignments),
  });
}

/**
 * 将需求富文本压缩为只用于归纳的纯文本，不执行或保留其中的脚本、图片与链接结构。
 */
function iterationSummaryPlainText(value, maximumLength = 600) {
  return htmlToMarkdown(value || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[`*_>#|~-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximumLength);
}

function iterationSummaryBracketLabel(title) {
  const matches = [...String(title || '').matchAll(/【([^】]+)】/gu)]
    .map((match) => String(match[1] || '').trim())
    .filter((label) => label && !/^\d{4}$/u.test(label) && !/bug转需求/iu.test(label));
  return matches[0] || '';
}

/**
 * 功能主题先使用稳定业务规则，再回退到模块或需求标题，避免同步之间分类随机漂移。
 */
function iterationRequirementTheme(requirement) {
  const searchable = `${requirement.title} ${requirement.module} ${requirement.description}`;
  const matched = ITERATION_THEME_RULES.find((rule) => rule.pattern.test(searchable));
  if (matched) return matched.label;

  const moduleParts = String(requirement.module || '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '未设置' && !/^模块 #\d+$/u.test(part));
  if (moduleParts.length > 0) return moduleParts[moduleParts.length - 1];

  return iterationSummaryBracketLabel(requirement.title) || '其他功能优化';
}

function iterationSummaryJoinLabels(labels) {
  const values = [...new Set(labels.filter(Boolean))];
  if (values.length <= 1) return values[0] || '当前需求';
  return `${values.slice(0, -1).join('、')}及${values[values.length - 1]}`;
}

/**
 * 每项需求只归入一个主主题，主题内保留稳定需求 ID，界面再读取当前标题和状态。
 */
function buildIterationThemes(requirements) {
  const groups = new Map();
  for (const requirement of requirements) {
    const label = iterationRequirementTheme(requirement);
    const group = groups.get(label) || [];
    group.push(requirement);
    groups.set(label, group);
  }

  return [...groups.entries()]
    .map(([label, items]) => {
      const sorted = [...items].sort((left, right) => Number(left.zentaoId) - Number(right.zentaoId));
      const examples = sorted.slice(0, 3).map((item) => `“${item.title}”`);
      return {
        id: crypto.createHash('sha256').update(`iteration-theme:${label}`).digest('hex').slice(0, 16),
        label,
        summary: examples.length > 0
          ? `主要包括${iterationSummaryJoinLabels(examples)}${sorted.length > examples.length ? '等功能' : ''}。`
          : `当前归纳为${label}相关功能。`,
        requirementIds: sorted.map((item) => item.id),
      };
    })
    .sort((left, right) => right.requirementIds.length - left.requirementIds.length
      || left.label.localeCompare(right.label, 'zh-CN'));
}

function iterationSummaryScopeIntroduction(name, themes, requirementCount, independentTaskCount = 0) {
  const themeLabels = themes.map((theme) => theme.label).slice(0, 5);
  const scopeText = themeLabels.length > 0
    ? iterationSummaryJoinLabels(themeLabels)
    : (independentTaskCount > 0 ? '独立任务' : '当前范围');
  const taskText = independentTaskCount > 0 ? `，并包含${independentTaskCount}项未关联需求的独立任务` : '';
  return `${name}主要交付${scopeText}相关能力，覆盖${requirementCount}项需求${taskText}。`;
}

function iterationSummaryBugDataHash(facts) {
  return crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

function readExistingIterationSummary(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Number(data?.schemaVersion) === 1 ? data : null;
  } catch {
    return null;
  }
}

function buildIterationSummaryChanges(previous, currentSnapshot) {
  if (!previous?.snapshot || !Array.isArray(previous.snapshot.requirements)) {
    return {
      initial: true,
      addedRequirementIds: [],
      removedRequirementIds: [],
      newlyClosedRequirementIds: [],
      statusChangedRequirementIds: [],
      batchChangedRequirementIds: [],
      bugDelta: { unclosed: 0, closed: 0, unclosedSeverity1: 0, unclosedSeverity2: 0 },
    };
  }

  const previousRequirements = new Map(previous.snapshot.requirements.map((item) => [String(item.id), item]));
  const currentRequirements = new Map(currentSnapshot.requirements.map((item) => [String(item.id), item]));
  const addedRequirementIds = [...currentRequirements.keys()].filter((id) => !previousRequirements.has(id));
  const removedRequirementIds = [...previousRequirements.keys()].filter((id) => !currentRequirements.has(id));
  const comparableIds = [...currentRequirements.keys()].filter((id) => previousRequirements.has(id));
  const previousBugStats = previous.snapshot.bugStats || emptyBugStats();
  const currentBugStats = currentSnapshot.bugStats;

  return {
    initial: false,
    addedRequirementIds,
    removedRequirementIds,
    newlyClosedRequirementIds: comparableIds.filter((id) => (
      String(previousRequirements.get(id).status || '').toLowerCase() !== 'closed'
      && String(currentRequirements.get(id).status || '').toLowerCase() === 'closed'
    )),
    statusChangedRequirementIds: comparableIds.filter((id) => (
      String(previousRequirements.get(id).status || '') !== String(currentRequirements.get(id).status || '')
    )),
    batchChangedRequirementIds: comparableIds.filter((id) => (
      String(previousRequirements.get(id).batchId || '') !== String(currentRequirements.get(id).batchId || '')
    )),
    bugDelta: {
      unclosed: currentBugStats.unclosed - Number(previousBugStats.unclosed || 0),
      closed: currentBugStats.closed - Number(previousBugStats.closed || 0),
      unclosedSeverity1: currentBugStats.unclosedSeverity1 - Number(previousBugStats.unclosedSeverity1 || 0),
      unclosedSeverity2: currentBugStats.unclosedSeverity2 - Number(previousBugStats.unclosedSeverity2 || 0),
    },
  };
}

/**
 * 生成整体、交付批次与未安排范围的版本化总结；精确进度由插件继续按当前任务实时计算。
 */
function buildIterationSummaryData(context, model, execution, rawStories, rawTasks, bugFacts) {
  const pluginData = readProjectManagerPluginData(context.vault);
  const deliveryPlan = normalizeIterationDeliveryPlan(
    pluginData?.[ITERATION_DELIVERY_PLANS_SETTING]?.[model.project.id],
  );
  const deliveryPlanSignature = iterationDeliveryPlanSignature(deliveryPlan);
  const flatNodes = flattenNodes(model.project.roots);
  const nodesByZenTaoId = new Map(flatNodes
    .filter(({ node }) => node.kind === 'requirement')
    .map(({ node }) => [String(node.zentaoId), node]));
  const requirements = uniqueBy(rawStories, (story) => String(story.id))
    .map((story) => {
      const node = nodesByZenTaoId.get(String(story.id));
      if (!node) return null;
      return {
        id: node.task.id,
        zentaoId: String(story.id),
        title: String(story.title || story.name || node.task.title),
        description: iterationSummaryPlainText(
          story.spec || story.desc || story.description || story.verify || '',
        ),
        descriptionHash: crypto.createHash('sha256').update(sanitizeSourceText(
          story.spec || story.desc || story.description || story.verify || '',
        )).digest('hex'),
        module: String(node.task.customFields.zentaoModule || ''),
        stage: String(node.task.stage || ''),
        status: String(node.task.status || ''),
        progress: Number(node.task.progress || 0),
        batchId: String(deliveryPlan.assignments[node.task.id] || ''),
      };
    })
    .filter(Boolean)
    .sort((left, right) => Number(left.zentaoId) - Number(right.zentaoId));
  const independentTasks = flatNodes
    .filter(({ node }) => node.kind === 'task' && !String(node.task.customFields.storyId || ''))
    .map(({ node }) => ({
      id: node.task.id,
      zentaoId: node.zentaoId,
      title: node.task.title,
      batchId: String(deliveryPlan.assignments[node.task.id] || ''),
    }));
  const overallThemes = buildIterationThemes(requirements);
  const unassignedRequirements = requirements.filter((requirement) => !deliveryPlan.batches
    .some((batch) => batch.id === requirement.batchId));
  const unassignedTasks = independentTasks.filter((task) => !deliveryPlan.batches
    .some((batch) => batch.id === task.batchId));
  const batchSummaries = deliveryPlan.batches.map((batch) => {
    const batchRequirements = requirements.filter((requirement) => requirement.batchId === batch.id);
    const batchIndependentTasks = independentTasks.filter((task) => task.batchId === batch.id);
    const themes = buildIterationThemes(batchRequirements);
    return {
      id: batch.id,
      name: batch.name || '未命名交付批次',
      introduction: iterationSummaryScopeIntroduction(
        batch.name || '该交付批次',
        themes,
        batchRequirements.length,
        batchIndependentTasks.length,
      ),
      themes,
      requirementIds: batchRequirements.map((requirement) => requirement.id),
      independentTaskIds: batchIndependentTasks.map((task) => task.id),
    };
  });
  const overallScopeText = overallThemes.length > 0
    ? iterationSummaryJoinLabels(overallThemes.map((theme) => theme.label).slice(0, 6))
    : '独立任务';
  const overallIntroduction = [
    `本迭代围绕“${String(execution.name || '未命名迭代')}”开展，功能范围主要覆盖${overallScopeText}。`,
    deliveryPlan.batches.length > 0
      ? `当前按${deliveryPlan.batches.length}个交付批次组织推进${unassignedRequirements.length > 0 || unassignedTasks.length > 0 ? `，另有${unassignedRequirements.length}项需求和${unassignedTasks.length}项独立任务尚未安排批次` : '，当前范围均已安排交付批次'}。`
      : `当前尚未配置交付批次，${requirements.length}项需求均按迭代整体管理。`,
  ].join('');
  const bugStats = aggregateBugFacts(bugFacts);
  const snapshot = {
    requirements: requirements.map((requirement) => ({
      id: requirement.id,
      zentaoId: requirement.zentaoId,
      status: requirement.status,
      batchId: requirement.batchId,
    })),
    bugStats,
  };
  const summaryFile = path.join(
    path.dirname(model.project.filePath),
    EXECUTION_DATA_SUPPORT_FOLDER,
    EXECUTION_ITERATION_SUMMARY_FILE,
  );
  const previous = readExistingIterationSummary(summaryFile);
  const source = {
    execution: {
      id: String(execution.id),
      name: String(execution.name || ''),
      status: String(execution.status || ''),
      begin: normalizeDate(execution.begin),
      end: normalizeDate(execution.end),
      updatedAt: model.project.updatedAt,
    },
    requirements,
    tasks: uniqueBy(rawTasks, (task) => String(task.id))
      .sort((left, right) => Number(left.id) - Number(right.id))
      .map((task) => ({
        id: String(task.id),
        name: String(task.name || ''),
        storyId: extractObjectId(task.story),
        type: String(task.type || ''),
        status: String(task.status || ''),
        progress: Number(task.progress || 0),
        estimate: numericValue(task.estimate),
        consumed: numericValue(task.consumed),
        remaining: numericValue(task.left),
      })),
    bugDataHash: iterationSummaryBugDataHash(bugFacts),
    deliveryPlanSignature,
  };
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
  if (previous?.sourceHash === sourceHash) {
    return { filePath: summaryFile, data: previous, content: `${JSON.stringify(previous, null, 2)}\n` };
  }

  const data = {
    schemaVersion: 1,
    projectId: model.project.id,
    executionId: String(execution.id),
    generatedAt: new Date().toISOString(),
    sourceHash,
    projectUpdatedAt: model.project.updatedAt,
    bugDataHash: source.bugDataHash,
    deliveryPlanSignature,
    coverage: {
      requirementTotal: requirements.length,
      requirementWithDescription: requirements.filter((requirement) => requirement.description).length,
      requirementWithoutDescriptionIds: requirements
        .filter((requirement) => !requirement.description)
        .map((requirement) => requirement.zentaoId),
    },
    overall: {
      introduction: overallIntroduction,
      themes: overallThemes,
    },
    batches: batchSummaries,
    unassigned: {
      introduction: unassignedRequirements.length > 0 || unassignedTasks.length > 0
        ? `当前有${unassignedRequirements.length}项需求和${unassignedTasks.length}项独立任务尚未安排交付批次，需要确认交付去向。`
        : '当前没有未安排交付批次的需求或独立任务。',
      themes: buildIterationThemes(unassignedRequirements),
      requirementIds: unassignedRequirements.map((requirement) => requirement.id),
      independentTaskIds: unassignedTasks.map((task) => task.id),
    },
    changes: buildIterationSummaryChanges(previous, snapshot),
    snapshot,
  };
  return { filePath: summaryFile, data, content: `${JSON.stringify(data, null, 2)}\n` };
}

function deterministicId(kind, id) {
  return crypto.createHash('sha256').update(`zentao-${kind}:${id}`).digest('hex').slice(0, 32);
}

function safeFilePart(value, fallback = 'untitled') {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#[\]^]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

function taskFileName(title, id) {
  return `${safeFilePart(title, 'task').toLowerCase()}-${id.slice(0, 8)}.md`;
}

function sanitizeSourceText(value) {
  return String(value || '')
    .replace(/<!--\s*zentao-sync:(?:start|end)\s*-->/gi, '[已移除同步控制标记]')
    .replace(/\r\n/g, '\n')
    .trim();
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? match;
  });
}

/**
 * 创建禅道富文本转换上下文。
 *
 * 需求、任务和备注中的图片不再参与同步，避免每次刷新重复下载低价值资源。
 * 已经存在于 vault 的历史图片保持原样，不在普通同步中自动删除。
 */
function createRichTextContext(context) {
  const assets = new Map();

  return {
    assets,
    render(value) {
      return htmlToMarkdown(value, {
        server: context.server,
      });
    },
  };
}

function htmlToMarkdown(value, options = {}) {
  let source = sanitizeSourceText(value)
    .replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--(?:[\s\S]*?)-->/g, '');

  source = source
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<a\b[^>]*href=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (match, doubleQuoted, singleQuoted, label) => {
      const href = decodeHtmlEntities(doubleQuoted ?? singleQuoted ?? '');
      const text = decodeHtmlEntities(String(label || '').replace(/<[^>]+>/g, '')).trim();
      if (!text) return '';
      if (!href || /^javascript:/iu.test(href)) return text;
      try {
        const absolute = new URL(href, new URL(options.server || DEFAULT_SERVER).origin).toString();
        return `[${text.replace(/[\[\]]/g, '')}](${absolute.replace(/\)/g, '%29')})`;
      } catch {
        return text;
      }
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (match, level, text) => `${'#'.repeat(Number(level))} ${text}\n\n`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, '*$2*')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<p\b[^>]*>/gi, '')
    .replace(/<ul\b[^>]*>|<ol\b[^>]*>|<\/ul\s*>|<\/ol\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n');

  return decodeHtmlEntities(source)
    .replace(/!\[[^\]]*\]\([^\r\n)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function storyRemarkLines(actions, person, richText, storyId) {
  const remarks = (Array.isArray(actions) ? actions : [])
    .filter((action) => String(action.action || '').toLowerCase() === 'commented')
    .map((action) => ({
      id: Number(action.id) || 0,
      date: String(action.date || ''),
      actor: person(action.actor) || accountValue(action.actor) || '未知人员',
      comment: (richText?.render(action.comment || '', 'story', storyId) ?? htmlToMarkdown(action.comment || ''))
        .replace(/[ \t]{2,}/g, ' '),
    }))
    .filter((remark) => remark.comment)
    .sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);

  if (remarks.length === 0) {
    return ['暂无备注。'];
  }

  const lines = [];
  for (const remark of remarks) {
    lines.push(
      `#### ${remark.date || '未知时间'} · ${remark.actor}`,
      '',
      remark.comment,
      '',
    );
  }

  return lines.slice(0, -1);
}

function escapeWikiAlias(value) {
  return String(value || '').replace(/\]\]/g, '］］').replace(/\|/g, '｜');
}

function buildTaskUrl(server, taskId) {
  return `${String(server || DEFAULT_SERVER).replace(/\/+$/, '')}/task-view-${taskId}.html`;
}

function buildStoryUrl(server, storyId) {
  return `${String(server || DEFAULT_SERVER).replace(/\/+$/, '')}/story-view-${storyId}.html`;
}

function buildExecutionUrl(server, executionId) {
  return `${String(server || DEFAULT_SERVER).replace(/\/+$/, '')}/execution-task-${executionId}.html`;
}

function vaultWikiLink(vault, filePath, alias = '') {
  const relativePath = path.relative(vault, filePath)
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '');
  return `[[${relativePath}${alias ? `|${escapeWikiAlias(alias)}` : ''}]]`;
}

function sourceUpdatedAt(item, fallback) {
  return normalizeIsoDate(
    item.lastEditedDate || item.finishedDate || item.realEnd || item.closedDate || item.openedDate || item.begin,
    fallback,
  );
}

function isSourceCompleted(kind, status, stage) {
  if (kind === 'story') {
    return status === 'closed' || ['verified', 'released', 'delivered', 'closed'].includes(stage);
  }

  return ['done', 'closed'].includes(status);
}

/** 完成日期只记录实际完成事实，不再从截止日期或阶段映射中推算。 */
function completionDate(item, kind, status, stage, fallback = '') {
  if (!isSourceCompleted(kind, status, stage)) {
    return '';
  }

  return normalizeDate(item.finishedDate || item.realEnd || item.closedDate || item.realFinished) || fallback;
}

function makeTaskNode(rawTask, person, moduleName, server, existingMeta = {}, richText = null) {
  const zentaoId = String(rawTask.id);
  const id = deterministicId('task', zentaoId);
  const stage = String(rawTask.type || '');
  const status = String(rawTask.status || '');
  const completed = completionDate(rawTask, 'task', status, stage, existingMeta.completed || '');
  const createdAt = normalizeIsoDate(rawTask.openedDate, existingMeta.createdAt || new Date().toISOString());
  const updatedAt = sourceUpdatedAt(rawTask, existingMeta.updatedAt || createdAt);
  const assignee = person(rawTask.assignedTo);
  const description = richText?.render(
    rawTask.desc || rawTask.description || rawTask.storyDesc || '',
    'task',
    zentaoId,
  ) ?? htmlToMarkdown(rawTask.desc || rawTask.description || rawTask.storyDesc || '');
  const sourceTime = rawTask.lastEditedDate || rawTask.finishedDate || rawTask.openedDate || '';
  const storyId = extractObjectId(rawTask.story);
  const linkedStoryDescription = storyId !== '0'
    ? (richText?.render(rawTask.storySpec || '', 'story', storyId) ?? htmlToMarkdown(rawTask.storySpec || ''))
    : '';
  const executionId = extractObjectId(rawTask.execution);
  const moduleId = extractObjectId(rawTask.module);
  const modulePath = moduleName(rawTask.module);
  const completedBy = person(rawTask.finishedBy);
  const estimatedHours = numericValue(rawTask.estimate);
  const consumedHours = numericValue(rawTask.consumed);
  const remainingHours = numericValue(rawTask.left);
  const actualStartedAt = normalizeDateTime(rawTask.realStarted);
  const actualFinishedAt = normalizeDateTime(rawTask.finishedDate);
  const priority = mapPriority(rawTask.pri);
  const start = normalizeDate(rawTask.estStarted || rawTask.realStarted || rawTask.openedDate);
  const due = normalizeDate(rawTask.deadline || rawTask.estFinished || rawTask.realFinished);
  const timeEstimate = estimatedHours > 0 ? estimatedHours : undefined;
  const timeVarianceTag = buildTimeVarianceTag(estimatedHours, consumedHours, Boolean(completed));
  const pushBaseline = JSON.stringify({
    version: 1,
    kind: 'task',
    local: {
      title: String(rawTask.name || '未命名任务'),
      stage,
      status,
      priority,
      start,
      due,
      assignees: assignee ? [assignee] : [],
      timeEstimate: timeEstimate ?? 0,
      zentaoModuleId: moduleId === '0' ? '' : moduleId,
      storyId: storyId === '0' ? '' : storyId,
    },
    remote: {
      name: String(rawTask.name || ''),
      type: stage,
      status: String(rawTask.status || ''),
      pri: String(rawTask.pri || ''),
      estStarted: normalizeDate(rawTask.estStarted),
      deadline: normalizeDate(rawTask.deadline),
      assignedTo: accountValue(rawTask.assignedTo) === 'closed' ? '' : accountValue(rawTask.assignedTo),
      estimate: estimatedHours,
      module: moduleId === '0' ? '0' : moduleId,
      story: storyId === '0' ? '0' : storyId,
    },
  });
  const syncBlock = [
    '<!-- zentao-sync:start -->',
    '## 禅道信息',
    '',
    `- 禅道任务：[#${zentaoId}](${buildTaskUrl(server, zentaoId)})`,
    `- 禅道阶段：${rawTask.type || '未知'}`,
    `- 禅道状态：${rawTask.status || '未知'}`,
    `- 所属模块：${modulePath}${moduleId !== '0' ? `（#${moduleId}）` : ''}`,
    `- 禅道指派：${person(rawTask.assignedTo) || accountValue(rawTask.assignedTo) || '未指派'}`,
    `- 完成者：${completedBy || '未完成'}`,
    `- 关联需求：${storyId !== '0' ? `#${storyId}` : '未关联需求'}`,
    `- 工时：预计 ${estimatedHours}h / 已消耗 ${consumedHours}h / 剩余 ${remainingHours}h`,
    ...(actualStartedAt ? [`- 实际开始：${actualStartedAt}`] : []),
    ...(actualFinishedAt ? [`- 实际完成：${actualFinishedAt}`] : []),
    `- 禅道更新时间：${sourceTime || '未知'}`,
    '',
    '### 禅道任务描述',
    '',
    description || '禅道中未填写任务描述。',
    ...(linkedStoryDescription ? [
      '',
      `### 关联需求 #${storyId} 描述`,
      '',
      linkedStoryDescription,
    ] : []),
    '<!-- zentao-sync:end -->',
  ].join('\n');

  return {
    kind: 'task',
    zentaoId,
    rawParentId: String(rawTask.parent || rawTask.parentID || '0'),
    storyId,
    syncBlock,
    task: {
      id,
      title: String(rawTask.name || '未命名任务'),
      type: 'task',
      stage,
      status,
      priority,
      start,
      due,
      progress: calculateProgress(rawTask, Boolean(completed)),
      completed,
      assignees: assignee ? [assignee] : [],
      tags: ['zentao', 'zentao-task', ...(timeVarianceTag ? [timeVarianceTag] : [])],
      subtasks: [],
      dependencies: [],
      timeEstimate,
      customFields: {
        zentaoSourceType: 'task',
        zentaoId,
        zentaoUrl: buildTaskUrl(server, zentaoId),
        zentaoModule: modulePath,
        zentaoModuleId: moduleId === '0' ? '' : moduleId,
        executionId: executionId === '0' ? '' : executionId,
        storyId: storyId === '0' ? '' : storyId,
        completedBy,
        estimatedHours,
        consumedHours,
        remainingHours,
        ...(actualStartedAt ? { actualStartedAt } : {}),
        ...(actualFinishedAt ? { actualFinishedAt } : {}),
        sourceUpdatedAt: sourceTime,
        zentaoPushBaseline: pushBaseline,
      },
      createdAt,
      updatedAt,
    },
  };
}

function makeStoryNode(rawStory, person, moduleName, server, existingMeta = {}, richText = null) {
  const zentaoId = String(rawStory.id);
  const id = deterministicId('story', zentaoId);
  const stage = String(rawStory.stage || '');
  const status = String(rawStory.status || '');
  const completed = completionDate(rawStory, 'story', status, stage, existingMeta.completed || '');
  const createdAt = normalizeIsoDate(rawStory.openedDate, existingMeta.createdAt || new Date().toISOString());
  const updatedAt = sourceUpdatedAt(rawStory, existingMeta.updatedAt || createdAt);
  const assignee = person(rawStory.assignedTo);
  const description = richText?.render(
    rawStory.spec || rawStory.desc || rawStory.description || rawStory.verify || '',
    'story',
    zentaoId,
  ) ?? htmlToMarkdown(rawStory.spec || rawStory.desc || rawStory.description || rawStory.verify || '');
  const sourceTime = rawStory.lastEditedDate || rawStory.closedDate || rawStory.openedDate || '';
  const executionId = extractObjectId(rawStory.execution);
  const moduleId = extractObjectId(rawStory.module);
  const modulePath = moduleName(rawStory.module);
  const estimatedHours = numericValue(rawStory.estimate);
  const priority = mapPriority(rawStory.pri);
  const title = String(rawStory.title || rawStory.name || '未命名需求');
  const pushBaseline = JSON.stringify({
    version: 1,
    kind: 'story',
    local: {
      title,
      stage,
      status,
      priority,
      assignees: assignee ? [assignee] : [],
      timeEstimate: estimatedHours,
      zentaoModuleId: moduleId === '0' ? '' : moduleId,
    },
    remote: {
      title: String(rawStory.title || rawStory.name || ''),
      stage,
      status: String(rawStory.status || ''),
      pri: String(rawStory.pri || ''),
      assignedTo: accountValue(rawStory.assignedTo) === 'closed' ? '' : accountValue(rawStory.assignedTo),
      estimate: estimatedHours,
      module: moduleId === '0' ? '0' : moduleId,
    },
  });
  const syncBlock = [
    '<!-- zentao-sync:start -->',
    '## 禅道需求信息',
    '',
    `- 禅道需求：[#${zentaoId}](${buildStoryUrl(server, zentaoId)})`,
    `- 禅道状态：${rawStory.status || '未知'}`,
    `- 禅道阶段：${rawStory.stage || '未知'}`,
    `- 所属模块：${modulePath}${moduleId !== '0' ? `（#${moduleId}）` : ''}`,
    `- 禅道指派：${person(rawStory.assignedTo) || accountValue(rawStory.assignedTo) || '未指派'}`,
    `- 禅道更新时间：${sourceTime || '未知'}`,
    '',
    '### 禅道需求描述',
    '',
    description || '禅道中未填写需求描述。',
    '',
    '### 禅道需求备注',
    '',
    ...storyRemarkLines(rawStory.zentaoActions, person, richText, zentaoId),
    '<!-- zentao-sync:end -->',
  ].join('\n');

  return {
    kind: 'requirement',
    zentaoId,
    rawParentId: extractObjectId(rawStory.parent),
    syncBlock,
    task: {
      id,
      title,
      type: 'task',
      stage,
      status,
      priority,
      start: normalizeDate(rawStory.begin || rawStory.openedDate),
      due: normalizeDate(rawStory.deadline),
      progress: calculateProgress(rawStory, Boolean(completed)),
      completed,
      assignees: assignee ? [assignee] : [],
      tags: ['zentao', 'zentao-requirement'],
      subtasks: [],
      dependencies: [],
      timeEstimate: estimatedHours > 0 ? estimatedHours : undefined,
      customFields: {
        zentaoSourceType: 'story',
        zentaoId,
        zentaoUrl: buildStoryUrl(server, zentaoId),
        zentaoModule: modulePath,
        zentaoModuleId: moduleId === '0' ? '' : moduleId,
        executionId: executionId === '0' ? '' : executionId,
        storyId: '',
        completedBy: '',
        estimatedHours,
        consumedHours: 0,
        remainingHours: 0,
        sourceUpdatedAt: sourceTime,
        zentaoPushBaseline: pushBaseline,
      },
      createdAt,
      updatedAt,
    },
  };
}

function makeExecutionMilestoneNode(execution, server, existingMeta = {}) {
  const executionId = String(execution.id);
  const id = deterministicId('milestone', `execution-${executionId}-planned-end`);
  const stage = String(execution.type || '');
  const status = String(execution.status || '');
  const createdAt = normalizeIsoDate(execution.openedDate || execution.begin, existingMeta.createdAt || new Date().toISOString());
  const updatedAt = sourceUpdatedAt(execution, existingMeta.updatedAt || createdAt);
  const plannedEnd = normalizeDate(execution.end);
  const actualEnd = normalizeDate(execution.realEnd || execution.closedDate);
  const sourceTime = execution.lastEditedDate || execution.realEnd || execution.closedDate || execution.begin || '';
  const syncBlock = [
    '<!-- zentao-sync:start -->',
    '## 禅道里程碑信息',
    '',
    `- 来源迭代：[#${executionId}](${buildExecutionUrl(server, executionId)})`,
    `- 禅道状态：${execution.status || '未知'}`,
    `- 计划完成：${plannedEnd || '未设置'}`,
    `- 实际完成：${actualEnd || '未完成'}`,
    `- 禅道更新时间：${sourceTime || '未知'}`,
    '<!-- zentao-sync:end -->',
  ].join('\n');

  return {
    kind: 'milestone',
    zentaoId: executionId,
    rawParentId: '0',
    storyId: '0',
    syncBlock,
    task: {
      id,
      title: `迭代 #${executionId} · 计划完成`,
      type: 'milestone',
      stage,
      status,
      priority: 'medium',
      start: '',
      due: plannedEnd,
      progress: 0,
      completed: isSourceCompleted('execution', status, stage) ? actualEnd : '',
      assignees: [],
      tags: ['zentao', 'zentao-milestone'],
      subtasks: [],
      dependencies: [],
      customFields: {
        zentaoSourceType: 'execution',
        zentaoId: executionId,
        zentaoUrl: buildExecutionUrl(server, executionId),
        zentaoModule: '',
        zentaoModuleId: '',
        executionId,
        storyId: '',
        completedBy: '',
        estimatedHours: 0,
        consumedHours: 0,
        remainingHours: 0,
        sourceUpdatedAt: sourceTime,
      },
      createdAt,
      updatedAt,
    },
  };
}

function sortByNumericId(left, right) {
  return Number(left.zentaoId) - Number(right.zentaoId);
}

function buildTaskTree(rawTasks, person, moduleName, server, existingMetadata, richText = null) {
  const nodes = uniqueBy(rawTasks, (task) => String(task.id))
    .map((task) => {
      const id = deterministicId('task', task.id);
      return makeTaskNode(task, person, moduleName, server, existingMetadata.get(id) || {}, richText);
    })
    .sort(sortByNumericId);
  const byZenTaoId = new Map(nodes.map((node) => [node.zentaoId, node]));
  const roots = [];

  // 按 parent 字段还原层级；异常的自引用或找不到父任务时回退为根任务。
  for (const node of nodes) {
    const parent = byZenTaoId.get(node.rawParentId);
    if (!parent || parent === node) {
      roots.push(node);
      continue;
    }

    node.task.type = 'subtask';
    parent.task.subtasks.push(node);
  }

  return roots;
}

function updateRequirementProgress(node) {
  for (const child of node.task.subtasks) {
    if (child.kind === 'requirement') {
      updateRequirementProgress(child);
    }
  }

  if (node.kind !== 'requirement' || node.task.subtasks.length === 0) {
    return;
  }

  let weightedProgress = 0;
  let totalWeight = 0;

  for (const child of node.task.subtasks) {
    const estimate = numericValue(child.task.timeEstimate);
    const weight = estimate > 0 ? estimate : 1;
    weightedProgress += child.task.progress * weight;
    totalWeight += weight;
  }

  node.task.progress = totalWeight > 0 ? Math.round(weightedProgress / totalWeight) : node.task.progress;
}

function updateRequirementManagement(node) {
  for (const child of node.task.subtasks) {
    if (child.kind === 'requirement') {
      updateRequirementManagement(child);
    }
  }

  if (node.kind !== 'requirement') {
    return;
  }

  // 汇总需求下的全部后代任务；子需求本身不计入工时，避免重复累计。
  const taskNodes = [];
  const collectTasks = (children) => {
    for (const child of children) {
      if (child.kind === 'task') {
        taskNodes.push(child);
      }
      collectTasks(child.task.subtasks);
    }
  };
  collectTasks(node.task.subtasks);

  const totals = taskNodes.reduce((result, child) => ({
    estimated: result.estimated + numericValue(child.task.customFields.estimatedHours),
    consumed: result.consumed + numericValue(child.task.customFields.consumedHours),
    remaining: result.remaining + numericValue(child.task.customFields.remainingHours),
  }), { estimated: 0, consumed: 0, remaining: 0 });
  totals.estimated = roundHours(totals.estimated);
  totals.consumed = roundHours(totals.consumed);
  totals.remaining = roundHours(totals.remaining);

  const rawEstimated = roundHours(node.task.customFields.estimatedHours);
  const childHasHours = totals.estimated > HOUR_COMPARISON_EPSILON
    || totals.consumed > HOUR_COMPARISON_EPSILON
    || totals.remaining > HOUR_COMPARISON_EPSILON;
  const displayEstimated = rawEstimated > HOUR_COMPARISON_EPSILON ? rawEstimated : totals.estimated;
  const managementTags = [];
  if (!taskNodes.some((child) => DEVELOPMENT_TASK_STAGES.has(String(child.task.stage).toLowerCase()))) {
    managementTags.push('未分配开发');
  }
  if (!taskNodes.some((child) => TEST_TASK_STAGES.has(String(child.task.stage).toLowerCase()))) {
    managementTags.push('未分配测试');
  }
  if (rawEstimated <= HOUR_COMPARISON_EPSILON && childHasHours) {
    managementTags.push('未更新工时');
  }

  const timeVarianceTag = buildTimeVarianceTag(displayEstimated, totals.consumed, Boolean(node.task.completed));
  if (timeVarianceTag) {
    managementTags.push(timeVarianceTag);
  }

  node.task.tags = [
    ...node.task.tags.filter((tag) => !isManagedWorkTag(tag)),
    ...managementTags,
  ];
  // 展示字段不加入项目自定义字段定义，也不进入禅道写回基线，只供插件工时列使用。
  node.task.customFields.displayEstimatedHours = displayEstimated;
  node.task.customFields.displayConsumedHours = totals.consumed;
  node.task.customFields.displayRemainingHours = totals.remaining;
}

function buildRequirementTaskTree(rawStories, rawTasks, person, moduleName, server, existingMetadata, richText = null) {
  const storyNodes = uniqueBy(rawStories, (story) => String(story.id))
    .map((story) => {
      const id = deterministicId('story', story.id);
      return makeStoryNode(story, person, moduleName, server, existingMetadata.get(id) || {}, richText);
    })
    .sort(sortByNumericId);
  const storiesByZenTaoId = new Map(storyNodes.map((node) => [node.zentaoId, node]));
  const storyRoots = [];

  // 先还原父子需求，再把直接关联需求的根任务挂到需求下。
  for (const node of storyNodes) {
    const parent = storiesByZenTaoId.get(node.rawParentId);
    if (!parent || parent === node) {
      storyRoots.push(node);
      continue;
    }

    node.task.type = 'subtask';
    parent.task.subtasks.push(node);
  }

  const taskRoots = buildTaskTree(rawTasks, person, moduleName, server, existingMetadata, richText);
  const unlinkedTaskRoots = [];

  for (const node of taskRoots) {
    const requirement = storiesByZenTaoId.get(node.storyId);
    if (!requirement) {
      unlinkedTaskRoots.push(node);
      continue;
    }

    node.task.type = 'subtask';
    requirement.task.subtasks.push(node);
  }

  for (const storyRoot of storyRoots) {
    updateRequirementManagement(storyRoot);
    updateRequirementProgress(storyRoot);
  }

  return [...storyRoots, ...unlinkedTaskRoots];
}

function flattenNodes(nodes) {
  const result = [];

  function visit(node, parent = null) {
    result.push({ node, parent });
    for (const subtask of node.task.subtasks) {
      visit(subtask, node);
    }
  }

  for (const node of nodes) {
    visit(node);
  }

  return result;
}

function splitFrontmatter(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: '', body: String(content || '') };
  }

  return {
    frontmatter: match[1],
    body: String(content || '').slice(match[0].length),
  };
}

function parseScalar(frontmatter, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 只消费行内空白，避免 \s* 跨行吞掉 YAML 块序列的第一项。
  const pattern = new RegExp(`^${escapedKey}:[ \\t]*(.*)$`, 'm');
  const match = frontmatter.match(pattern);
  if (!match) {
    return '';
  }

  const raw = match[1].trim();
  if (!raw) {
    const lines = String(frontmatter || '').split(/\r?\n/);
    const keyIndex = lines.findIndex((line) => new RegExp(`^${escapedKey}:[ \\t]*$`).test(line));
    const values = [];
    for (let index = keyIndex + 1; index < lines.length; index += 1) {
      if (lines[index] && !/^\s/.test(lines[index])) {
        break;
      }
      const item = lines[index].match(/^\s+-\s+(.*)$/);
      if (item) {
        values.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
      }
    }
    return values;
  }

  if (raw.startsWith('"') || raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }

  return raw;
}

/**
 * 读取 Frontmatter 对象中的一级子属性。
 */
function parseNestedScalar(frontmatter, parentKey, childKey) {
  const range = findFrontmatterPropertyRange(frontmatter, parentKey);
  if (range.start < 0) {
    return '';
  }

  const block = range.lines.slice(range.start + 1, range.end).join('\n');
  return parseScalar(block.replace(/^  /gm, ''), childKey);
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

function scanExistingTasks(taskFolder) {
  const byId = new Map();
  const metadata = new Map();

  for (const filePath of walkMarkdownFiles(taskFolder)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const split = splitFrontmatter(content);
    const id = String(parseScalar(split.frontmatter, 'id') || '');
    const isTask = String(parseScalar(split.frontmatter, 'pm-task')) === 'true';
    const rawTags = parseScalar(split.frontmatter, 'tags');
    const tags = Array.isArray(rawTags) ? rawTags.map(String) : [];
    const isZenTaoManaged = tags.includes('zentao');
    const syncState = String(parseNestedScalar(split.frontmatter, 'customFields', 'zentaoSyncState') || '');

    // 软失效遗留笔记使用 pm-task: false，但仍需按稳定 ID 纳入扫描，便于重新出现时原位恢复。
    if (!id || (!isTask && !(isZenTaoManaged && syncState))) {
      continue;
    }

    if (byId.has(id)) {
      throw new Error(`检测到重复的 Project Manager 任务 ID：${id}`);
    }

    byId.set(id, {
      filePath,
      content,
      isTask,
      isZenTaoManaged,
      syncState,
      sourceType: String(parseNestedScalar(split.frontmatter, 'customFields', 'zentaoSourceType') || ''),
      zentaoId: String(parseNestedScalar(split.frontmatter, 'customFields', 'zentaoId') || ''),
    });
    metadata.set(id, {
      createdAt: String(parseScalar(split.frontmatter, 'createdAt') || ''),
      updatedAt: String(parseScalar(split.frontmatter, 'updatedAt') || ''),
      completed: String(parseScalar(split.frontmatter, 'completed') || ''),
    });
  }

  return { byId, metadata };
}

function findExistingProjectFile(projectsDirectory, projectId) {
  for (const filePath of walkMarkdownFiles(projectsDirectory)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const split = splitFrontmatter(content);
    const isProject = String(parseScalar(split.frontmatter, 'pm-project')) === 'true';
    const id = String(parseScalar(split.frontmatter, 'id') || '');
    if (isProject && id === projectId) {
      return { filePath, content, frontmatter: split.frontmatter };
    }
  }

  return null;
}

/**
 * 归档状态由 Project Manager Enhanced 首页维护在插件配置中，独立于禅道同步项目文件。
 */
function readDashboardArchivedProjectIds(vault) {
  const dataFile = path.join(
    vault,
    '.obsidian',
    'plugins',
    PROJECT_MANAGER_PLUGIN_ID,
    'data.json',
  );
  if (!fs.existsSync(dataFile)) {
    return new Set();
  }

  let pluginData;
  try {
    pluginData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 Project Manager Enhanced 归档配置：${error.message}`);
  }

  const storedProjects = pluginData?.[DASHBOARD_ARCHIVED_PROJECTS_SETTING];
  if (!storedProjects || typeof storedProjects !== 'object' || Array.isArray(storedProjects)) {
    return new Set();
  }

  return new Set(
    Object.entries(storedProjects)
      .filter(([, archived]) => archived === true)
      .map(([projectId]) => projectId),
  );
}

/**
 * 批量同步只发现 vault 中已经存在的禅道迭代，不读取或推断新的禅道项目范围。
 */
function listLocalExecutionProjects(vault, projectsDirectory) {
  const archivedProjectIds = readDashboardArchivedProjectIds(vault);
  const projects = [];
  const projectIds = new Set();

  for (const filePath of walkMarkdownFiles(projectsDirectory)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const split = splitFrontmatter(content);
    const isProject = String(parseScalar(split.frontmatter, 'pm-project')) === 'true';
    const projectId = String(parseScalar(split.frontmatter, 'id') || '');
    const idMatch = projectId.match(/^zentao-execution-(\d+)$/u);
    if (!isProject || !idMatch) {
      continue;
    }

    if (projectIds.has(projectId)) {
      throw new Error(`检测到重复的禅道迭代项目 ID：${projectId}`);
    }

    projectIds.add(projectId);
    projects.push({
      id: idMatch[1],
      projectId,
      filePath,
      content,
      frontmatter: split.frontmatter,
      archived: archivedProjectIds.has(projectId)
        || String(parseScalar(split.frontmatter, 'archived')) === 'true',
    });
  }

  return projects.sort((left, right) => Number(right.id) - Number(left.id));
}

/**
 * 返回 Project Manager 项目目录下可供新迭代选择的一级系统目录。
 */
function listSystemFolders(projectsDirectory) {
  if (!fs.existsSync(projectsDirectory)) {
    throw new Error(`Project Manager 项目目录不存在：${projectsDirectory}`);
  }

  return fs.readdirSync(projectsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

/**
 * 新迭代只能进入用户明确选择的既有一级系统目录，避免同步脚本擅自归类。
 */
function resolveSystemFolder(projectsDirectory, systemFolder, executionId) {
  const folders = listSystemFolders(projectsDirectory);
  const normalized = String(systemFolder || '').replace(/^[/\\]+|[/\\]+$/g, '');

  if (!normalized) {
    const choices = folders.length > 0 ? folders.join('、') : '暂无可选目录';
    throw new Error(`禅道迭代 #${executionId} 尚未在本地创建，请先选择归属系统目录：${choices}；确认后使用 --system-folder <目录> 重新预览`);
  }

  if (path.isAbsolute(normalized) || normalized.split(/[\\/]+/).length !== 1 || normalized === '.' || normalized === '..') {
    throw new Error('--system-folder 必须是 Project Manager 项目目录下的一级目录名称');
  }

  if (!folders.includes(normalized)) {
    throw new Error(`--system-folder “${normalized}” 不存在，可选目录：${folders.length > 0 ? folders.join('、') : '暂无'}`);
  }

  return normalized;
}

function yamlScalar(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  return JSON.stringify(String(value));
}

function renderYamlValue(lines, key, value, indent = 0) {
  const prefix = '  '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${prefix}${key}: []`);
      return;
    }

    if (value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
      lines.push(`${prefix}${key}: [${value.map(yamlScalar).join(', ')}]`);
      return;
    }

    lines.push(`${prefix}${key}:`);
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        lines.push(`${prefix}  - ${yamlScalar(item)}`);
        continue;
      }

      const entries = Object.entries(item);
      if (entries.length === 0) {
        continue;
      }

      entries.forEach(([itemKey, itemValue], index) => {
        const itemPrefix = index === 0 ? `${prefix}  - ` : `${prefix}    `;
        lines.push(`${itemPrefix}${itemKey}: ${JSON.stringify(itemValue)}`);
      });
    }
    return;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      lines.push(`${prefix}${key}: {}`);
      return;
    }

    lines.push(`${prefix}${key}:`);
    for (const [childKey, childValue] of entries) {
      renderYamlValue(lines, childKey, childValue, indent + 1);
    }
    return;
  }

  lines.push(`${prefix}${key}: ${yamlScalar(value)}`);
}

function renderFrontmatter(values) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(values)) {
    renderYamlValue(lines, key, value);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * 从禅道详情对象中提取全部迭代 ID，兼容任务单值和需求多迭代结构。
 */
function extractRemoteExecutionIds(sourceType, remoteObject) {
  const executionIds = new Set();
  const addExecutionId = (value) => {
    const executionId = extractObjectId(value);
    if (/^\d+$/u.test(executionId) && executionId !== '0') {
      executionIds.add(executionId);
    }
  };

  addExecutionId(remoteObject?.execution);
  addExecutionId(remoteObject?.executionID);

  if (sourceType === 'story') {
    const executions = remoteObject?.executions;
    if (Array.isArray(executions)) {
      for (const execution of executions) {
        addExecutionId(execution);
      }
    } else if (executions && typeof executions === 'object') {
      for (const [executionId, execution] of Object.entries(executions)) {
        addExecutionId(executionId);
        addExecutionId(execution);
      }
    }
  }

  return [...executionIds].sort((left, right) => Number(left) - Number(right));
}

/**
 * 使用只读详情判断遗留事项的远端状态。
 */
function verifyOrphanedItem(options, context, executionId, existing) {
  const sourceType = String(existing.sourceType || '');
  const zentaoId = String(existing.zentaoId || '');
  if (!ZENTAO_ORPHAN_SOURCE_TYPES.has(sourceType) || !/^\d+$/u.test(zentaoId)) {
    return {
      state: ZENTAO_ORPHAN_STATE.MISSING_UNCONFIRMED,
      remoteExecutionIds: [],
    };
  }

  try {
    const remoteObject = loadZenTaoObjectDetail(options, sourceType, zentaoId);
    if (!remoteObject) {
      return {
        state: ZENTAO_ORPHAN_STATE.MISSING_UNCONFIRMED,
        remoteExecutionIds: [],
      };
    }

    const remoteExecutionIds = extractRemoteExecutionIds(sourceType, remoteObject);
    if (String(remoteObject.deleted || '0') === '1') {
      return {
        state: ZENTAO_ORPHAN_STATE.DELETED_REMOTE,
        remoteExecutionIds,
      };
    }
    if (remoteExecutionIds.includes(String(executionId))) {
      // 详情仍指向当前迭代但列表未返回时，不能擅自推断原因。
      return {
        state: ZENTAO_ORPHAN_STATE.MISSING_UNCONFIRMED,
        remoteExecutionIds,
      };
    }
    if (remoteExecutionIds.length > 0) {
      return {
        state: ZENTAO_ORPHAN_STATE.MOVED_TO_OTHER_EXECUTION,
        remoteExecutionIds,
      };
    }

    return {
      state: ZENTAO_ORPHAN_STATE.REMOVED_FROM_EXECUTION,
      remoteExecutionIds: [],
    };
  } catch (error) {
    const sourceLabel = sourceType === 'story' ? '需求' : '任务';
    context.orphanWarnings.push(`迭代 #${executionId} 的${sourceLabel} #${zentaoId} 遗留状态验证失败，已保留原文件并从活动视图隔离`);
    return {
      state: ZENTAO_ORPHAN_STATE.VERIFY_FAILED,
      remoteExecutionIds: [],
    };
  }
}

/**
 * 读取已有遗留清单，格式异常时停止当前迭代，避免覆盖审计历史。
 */
function readOrphanedItemsData(filePath) {
  if (!fs.existsSync(filePath)) {
    return { content: null, data: null };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  try {
    const data = JSON.parse(content);
    if (Number(data.schemaVersion) !== 1 || !Array.isArray(data.records)) {
      throw new Error('schemaVersion 或 records 不符合约定');
    }
    return { content, data };
  } catch (error) {
    throw new Error(`无法解析禅道遗留清单 ${filePath}：${error.message}`);
  }
}

/**
 * 生成当前迭代的遗留清单，并识别本次新增、持续遗留和恢复事项。
 */
function buildOrphanedItemsModel(options, context, model, executionId) {
  const filePath = path.join(
    path.dirname(model.project.filePath),
    EXECUTION_DATA_SUPPORT_FOLDER,
    EXECUTION_ORPHANED_ITEMS_FILE,
  );
  const existingManifest = readOrphanedItemsData(filePath);
  const previousRecords = Array.isArray(existingManifest.data?.records)
    ? existingManifest.data.records
    : [];
  const previousById = new Map(previousRecords.map((record) => [String(record.id || ''), record]));
  const generatedTaskIds = new Set(
    flattenNodes(model.project.roots).map(({ node }) => String(node.task.id)),
  );
  const restored = previousRecords.filter((record) => generatedTaskIds.has(String(record.id || '')));
  const records = [];

  for (const [id, existing] of model.existingTasks.byId) {
    if (generatedTaskIds.has(id) || !existing.isZenTaoManaged) {
      continue;
    }

    const previous = previousById.get(id);
    const verification = verifyOrphanedItem(options, context, executionId, existing);
    const stateChanged = String(previous?.state || '') !== verification.state;
    records.push({
      id,
      sourceType: String(existing.sourceType || ''),
      zentaoId: String(existing.zentaoId || ''),
      filePath: path.relative(context.vault, existing.filePath).replace(/\\/g, '/'),
      state: verification.state,
      firstMissingAt: String(previous?.firstMissingAt || context.syncTimestamp),
      lastCheckedAt: context.syncTimestamp,
      stateChangedAt: stateChanged
        ? context.syncTimestamp
        : String(previous?.stateChangedAt || previous?.firstMissingAt || context.syncTimestamp),
      missingSyncCount: Number(previous?.missingSyncCount || 0) + 1,
      remoteExecutionIds: verification.remoteExecutionIds,
    });
  }

  records.sort((left, right) => (
    left.sourceType.localeCompare(right.sourceType, 'zh-CN')
    || Number(left.zentaoId || 0) - Number(right.zentaoId || 0)
    || left.id.localeCompare(right.id, 'zh-CN')
  ));
  const counts = {};
  for (const state of Object.values(ZENTAO_ORPHAN_STATE)) {
    counts[state] = records.filter((record) => record.state === state).length;
  }

  const dataHash = crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
  const data = {
    schemaVersion: 1,
    projectId: model.project.id,
    executionId: String(executionId),
    generatedAt: context.syncTimestamp,
    dataHash,
    recordCount: records.length,
    counts,
    records,
  };
  const content = existingManifest.data?.dataHash === dataHash
    ? existingManifest.content
    : `${JSON.stringify(data, null, 2)}\n`;

  return {
    filePath,
    content,
    records,
    restored,
    newCount: records.filter((record) => !previousById.has(record.id)).length,
    continuedCount: records.filter((record) => previousById.has(record.id)).length,
  };
}

/**
 * 将遗留笔记软失效，只更新同步生命周期字段，正文和其余 Frontmatter 保持原样。
 */
function renderOrphanedTaskContent(existingContent, record) {
  const split = splitFrontmatter(existingContent);
  if (!split.frontmatter) {
    throw new Error(`禅道遗留事项缺少 Frontmatter：${record.filePath}`);
  }

  const lines = split.frontmatter.split(/\r?\n/);
  const taskIndex = lines.findIndex((line) => /^pm-task:[ \t]*/u.test(line));
  if (taskIndex < 0) {
    throw new Error(`禅道遗留事项缺少 pm-task 属性：${record.filePath}`);
  }
  lines[taskIndex] = 'pm-task: false';

  const customRange = findFrontmatterPropertyRange(lines.join('\n'), 'customFields');
  if (customRange.start < 0) {
    throw new Error(`禅道遗留事项缺少 customFields：${record.filePath}`);
  }

  const managedFields = {
    zentaoSyncState: record.state,
    zentaoMissingSince: record.firstMissingAt,
    zentaoLastCheckedAt: record.lastCheckedAt,
    zentaoStateChangedAt: record.stateChangedAt,
    zentaoMissingCount: record.missingSyncCount,
    zentaoRemoteExecutionIds: record.remoteExecutionIds,
  };
  const managedKeys = new Set(Object.keys(managedFields));
  const customLines = customRange.lines
    .slice(customRange.start + 1, customRange.end)
    .filter((line) => {
      const child = line.match(/^  ([A-Za-z0-9_-]+):/u);
      return !child || !managedKeys.has(child[1]);
    });
  const renderedManagedFields = [];
  for (const [key, value] of Object.entries(managedFields)) {
    renderYamlValue(renderedManagedFields, key, value, 1);
  }

  const mergedFrontmatter = [
    ...customRange.lines.slice(0, customRange.start + 1),
    ...customLines,
    ...renderedManagedFields,
    ...customRange.lines.slice(customRange.end),
  ].join('\n');
  return `---\n${mergedFrontmatter}\n---\n${split.body}`;
}

/**
 * 查找 Frontmatter 顶层属性占用的行范围。
 *
 * 同时兼容单行属性和带缩进的 YAML 数组、对象，便于只替换同步归属属性。
 */
function findFrontmatterPropertyRange(frontmatter, key) {
  const lines = String(frontmatter || '').split(/\r?\n/);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedKey}:[ \\t]*`);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) {
    return { lines, start: -1, end: -1 };
  }

  let end = start + 1;
  while (end < lines.length && (/^[ \\t]+/.test(lines[end]) || lines[end] === '')) {
    end += 1;
  }

  return { lines, start, end };
}

/**
 * 读取 Frontmatter 对象的一级子属性块，属性值为数组或对象时一并保留完整缩进内容。
 */
function frontmatterChildPropertyBlocks(frontmatter, parentKey) {
  const parentRange = findFrontmatterPropertyRange(frontmatter, parentKey);
  if (parentRange.start < 0) {
    return [];
  }

  const parentIndent = (parentRange.lines[parentRange.start].match(/^[ \t]*/u) || [''])[0].length;
  const childIndent = parentIndent + 2;
  const blocks = [];
  let currentBlock = null;

  for (let index = parentRange.start + 1; index < parentRange.end; index += 1) {
    const line = parentRange.lines[index];
    const childMatch = line.match(/^([ \t]+)([A-Za-z0-9_-]+):/u);
    if (childMatch && childMatch[1].length === childIndent) {
      if (currentBlock) {
        currentBlock.end = index;
        currentBlock.lines = parentRange.lines.slice(currentBlock.start, currentBlock.end);
        blocks.push(currentBlock);
      }

      currentBlock = {
        key: childMatch[2],
        start: index,
        end: parentRange.end,
        lines: [],
      };
    }
  }

  if (currentBlock) {
    currentBlock.lines = parentRange.lines.slice(currentBlock.start, currentBlock.end);
    blocks.push(currentBlock);
  }

  return blocks;
}

/**
 * 合并事项中的本地自定义字段。
 *
 * 禅道同步字段由本次结果全量重建；插件或人工维护的未知字段直接沿用旧 YAML 块，
 * 避免任务完整性例外、审计原因等本地状态在刷新禅道数据时被覆盖。
 */
function preserveLocalTaskCustomFields(existingContent, generatedContent) {
  if (!existingContent) {
    return generatedContent;
  }

  const existing = splitFrontmatter(existingContent);
  const generated = splitFrontmatter(generatedContent);
  const generatedBlocks = frontmatterChildPropertyBlocks(generated.frontmatter, 'customFields');
  const generatedKeys = new Set(generatedBlocks.map((block) => block.key));
  const localBlocks = frontmatterChildPropertyBlocks(existing.frontmatter, 'customFields')
    .filter((block) => !ZENTAO_MANAGED_TASK_CUSTOM_FIELDS.has(block.key))
    .filter((block) => !generatedKeys.has(block.key));

  if (localBlocks.length === 0) {
    return generatedContent;
  }

  const generatedRange = findFrontmatterPropertyRange(generated.frontmatter, 'customFields');
  if (generatedRange.start < 0) {
    throw new Error('禅道事项缺少 customFields，无法合并本地自定义字段');
  }

  const mergedFrontmatter = [
    ...generatedRange.lines.slice(0, generatedRange.end),
    ...localBlocks.flatMap((block) => block.lines),
    ...generatedRange.lines.slice(generatedRange.end),
  ].join('\n');
  return `---\n${mergedFrontmatter}\n---\n${generated.body}`;
}

/** 将属性值转换为稳定结构，避免对象键顺序造成无效差异。 */
function normalizeComparableProperty(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeComparableProperty);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeComparableProperty(value[key])]),
    );
  }

  return value;
}

/** 比较两个 Frontmatter 属性的语义值，不把引号或 YAML 排版差异当成业务变化。 */
function frontmatterPropertyEquals(left, right) {
  return JSON.stringify(normalizeComparableProperty(left))
    === JSON.stringify(normalizeComparableProperty(right));
}

/**
 * 合并项目资料笔记中的禅道同步属性。
 *
 * 仅更新明确列入白名单的属性；正文、未知属性和本地管理属性全部原样保留。
 */
function mergeManagedNoteProperties(existingContent, generatedContent, managedProperties) {
  const existing = splitFrontmatter(existingContent);
  const generated = splitFrontmatter(generatedContent);

  if (!existing.frontmatter) {
    return {
      // 既有正文没有 Frontmatter 时补齐完整初始属性，但正文仍保持原样。
      content: `---\n${generated.frontmatter}\n---\n${existing.body}`,
      changedProperties: [...managedProperties],
    };
  }

  let mergedFrontmatter = existing.frontmatter;
  const changedProperties = [];

  for (const key of managedProperties) {
    const expectedRange = findFrontmatterPropertyRange(generated.frontmatter, key);
    if (expectedRange.start < 0) {
      throw new Error(`项目资料笔记缺少待同步属性：${key}`);
    }

    const currentRange = findFrontmatterPropertyRange(mergedFrontmatter, key);
    const currentValue = currentRange.start < 0 ? undefined : parseScalar(mergedFrontmatter, key);
    const expectedValue = parseScalar(generated.frontmatter, key);
    if (currentRange.start >= 0 && frontmatterPropertyEquals(currentValue, expectedValue)) {
      continue;
    }

    const expectedBlock = expectedRange.lines.slice(expectedRange.start, expectedRange.end);
    const mergedLines = currentRange.start < 0
      ? [...currentRange.lines, ...expectedBlock]
      : [
        ...currentRange.lines.slice(0, currentRange.start),
        ...expectedBlock,
        ...currentRange.lines.slice(currentRange.end),
      ];
    mergedFrontmatter = mergedLines.join('\n');
    changedProperties.push(key);
  }

  if (changedProperties.length === 0) {
    return { content: existingContent, changedProperties };
  }

  return {
    content: `---\n${mergedFrontmatter}\n---\n${existing.body}`,
    changedProperties,
  };
}

function removeManagedRelations(body) {
  return String(body || '')
    .replace(SYNC_BLOCK_PATTERN, '')
    .replace(/^Project: \[\[.*\]\]\s*$/gm, '')
    .replace(/^Parent: \[\[.*\]\]\s*$/gm, '')
    // 只移除插件生成的 Subtasks 标题和任务链接，保留其后的本地自定义章节。
    .replace(/(?:^|\n)## Subtasks\s*\n(?:- \[[ xX]\] [^\n]*(?:\n|$))*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderTaskContent(node, parent, project, existingContent) {
  const task = node.task;
  const values = {
    'pm-task': true,
    projectId: project.id,
    parentId: parent ? parent.task.id : null,
    id: task.id,
    title: task.title,
    type: task.type,
    stage: task.stage,
    status: task.status,
    priority: task.priority,
    start: task.start,
    due: task.due,
    progress: task.progress,
    assignees: task.assignees,
    tags: task.tags,
    subtaskIds: task.subtasks.map((subtask) => subtask.task.id),
    dependencies: task.dependencies,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };

  if (task.completed) {
    values.completed = task.completed;
  }

  if (task.timeEstimate !== undefined) {
    values.timeEstimate = task.timeEstimate;
  }

  if (Object.keys(task.customFields).length > 0) {
    values.customFields = task.customFields;
  }

  const manualBody = removeManagedRelations(splitFrontmatter(existingContent || '').body);
  const bodyParts = [node.syncBlock];
  if (manualBody) {
    bodyParts.push(manualBody);
  }

  if (parent) {
    bodyParts.push(`Parent: ${vaultWikiLink(project.vault, parent.filePath, escapeWikiAlias(parent.task.title))}`);
  } else {
    bodyParts.push(`Project: ${vaultWikiLink(project.vault, project.filePath, escapeWikiAlias(project.title))}`);
  }

  if (task.subtasks.length > 0) {
    const links = ['## Subtasks'];
    for (const subtask of task.subtasks) {
      const checked = subtask.task.completed ? 'x' : ' ';
      links.push(`- [${checked}] ${vaultWikiLink(project.vault, subtask.filePath, escapeWikiAlias(subtask.task.title))}`);
    }
    bodyParts.push(links.join('\n'));
  }

  const generatedContent = `${renderFrontmatter(values)}${bodyParts.join('\n\n')}\n`;
  return preserveLocalTaskCustomFields(existingContent, generatedContent);
}

function renderProjectContent(project) {
  const values = {
    'pm-project': true,
    id: project.id,
    title: project.title,
    description: project.description,
    color: project.color,
    icon: project.icon,
    status: project.status,
    taskIds: project.roots.map((node) => node.task.id),
    customFields: project.customFields,
    teamMembers: project.teamMembers,
    savedViews: project.savedViews,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
  const lines = [
    renderFrontmatter(values).trimEnd(),
    '',
    `# ${project.icon} ${project.title}`,
    '',
    project.description,
  ];

  if (project.roots.length > 0) {
    lines.push('', '## Tasks');
    for (const node of project.roots) {
      const checked = node.task.completed ? 'x' : ' ';
      lines.push(`- [${checked}] ${vaultWikiLink(project.vault, node.filePath, escapeWikiAlias(node.task.title))}`);
    }
  }

  if (Array.isArray(project.supportingNotes) && project.supportingNotes.length > 0) {
    lines.push('', '## 项目资料');
    for (const note of project.supportingNotes) {
      lines.push(`- ${vaultWikiLink(project.vault, note.filePath, note.label)}`);
    }

    lines.push(
      '',
      '## 本地管理约定',
      '',
      '- 禅道同步事项继续使用 `zentao` 标签；本地项目管理任务使用 `local-management` 标签。',
      '- 上线准备、执行和验证任务额外使用 `release-management` 标签，以便通过“上线管理”视图集中查看。',
      '- 上线脚本、执行方式、验证结果和回滚记录维护在上线记录中，不写入禅道同步区域。',
    );
  }

  return `${lines.join('\n')}\n`;
}

function renderProjectManagementNote(context, model, execution, releaseFile) {
  const project = model.project;
  const executionId = String(execution.id);
  const values = {
    type: 'project-management-record',
    project: vaultWikiLink(context.vault, project.filePath),
    zentaoExecutionId: executionId,
    zentaoExecutionUrl: buildExecutionUrl(context.server, executionId),
    status: 'active',
  };
  const lines = [
    renderFrontmatter(values).trimEnd(),
    '',
    `# ${execution.name || `迭代 #${executionId}`} · 项目管理`,
    '',
    '## 快速入口',
    '',
    `- Project Manager：${vaultWikiLink(context.vault, project.filePath, project.title)}`,
    `- 上线准备：${vaultWikiLink(context.vault, releaseFile, '打开上线准备记录')}`,
    `- 禅道迭代：[查看迭代 #${executionId}](${buildExecutionUrl(context.server, executionId)})`,
    '',
    '## 项目目标',
    '',
    '## 当前进展',
    '',
    '## 风险',
    '',
    '| 风险 | 影响 | 负责人 | 应对方式 | 状态 |',
    '|---|---|---|---|---|',
    '',
    '## 决策记录',
    '',
    '| 日期 | 决策 | 参与人 | 原因 |',
    '|---|---|---|---|',
    '',
    '## 进展记录',
    '',
    '## 复盘',
  ];
  return `${lines.join('\n')}\n`;
}

function renderReleasePreparationNote(context, model, execution, managementFile) {
  const project = model.project;
  const executionId = String(execution.id);
  const plannedDate = normalizeDate(execution.end);
  const values = {
    type: 'release-record',
    project: vaultWikiLink(context.vault, project.filePath),
    projectManagement: vaultWikiLink(context.vault, managementFile),
    zentaoExecutionId: executionId,
    version: '',
    environment: 'production',
    plannedDate,
    status: 'preparing',
    owner: '',
  };
  const lines = [
    renderFrontmatter(values).trimEnd(),
    '',
    `# ${execution.name || `迭代 #${executionId}`} · 上线准备`,
    '',
    '> `plannedDate` 同步自禅道迭代计划结束日期，仅作为上线计划参考；实际发布时间请在确认后维护。',
    '',
    '## 上线范围',
    '',
    '- 关联需求：',
    '- 关联任务：',
    '- 不包含内容：',
    '',
    '## 上线负责人',
    '',
    '| 角色 | 负责人 |',
    '|---|---|',
    '| 总负责人 | |',
    '| 后端执行 | |',
    '| 前端执行 | |',
    '| 数据库执行 | |',
    '| 验证人员 | |',
    '',
    '## 前置检查',
    '',
    '- [ ] 禅道需求和任务状态已确认',
    '- [ ] 测试已经通过',
    '- [ ] 数据库备份已经确认',
    '- [ ] 上线脚本已经审核',
    '- [ ] 回滚方案已经确认',
    '- [ ] 相关人员已经通知',
    '',
    '## 执行方式',
    '',
    '### 后端',
    '',
    '- 服务：',
    '- 分支、Tag 或 Commit：',
    '- 执行顺序：',
    '- 重启方式：',
    '',
    '### 前端',
    '',
    '- 构建版本：',
    '- 发布目录：',
    '- CDN 或缓存处理：',
    '',
    '### 数据库',
    '',
    '- 数据库：',
    '- 执行人：',
    '- 执行顺序：',
    '',
    '## 上线脚本',
    '',
    '### 正向脚本',
    '',
    '```sql',
    '-- 在此记录脚本，或填写代码仓库中的脚本路径、Commit ID 和校验信息。',
    '```',
    '',
    '### 回滚脚本',
    '',
    '```sql',
    '-- 在此记录回滚脚本，或填写代码仓库中的脚本路径、Commit ID 和校验信息。',
    '```',
    '',
    '## 验证方案',
    '',
    '- [ ] 核心流程验证',
    '- [ ] 数据核对',
    '- [ ] 日志检查',
    '- [ ] 告警检查',
    '',
    '## 实际执行记录',
    '',
    '| 时间 | 执行人 | 操作 | 结果 |',
    '|---|---|---|---|',
    '',
    '## 异常及处理',
    '',
    '## 上线结论',
    '',
    '## 后续事项',
  ];
  return `${lines.join('\n')}\n`;
}

function createExecutionSupportingNotes(context, model, execution) {
  const executionId = String(execution.id);
  const managementFolder = path.join(path.dirname(model.project.filePath), EXECUTION_MANAGEMENT_FOLDER);
  const managementFile = path.join(managementFolder, '项目管理.md');
  const releaseFile = path.join(managementFolder, '上线记录', `迭代-${executionId}-上线准备.md`);
  const notes = [
    {
      label: '项目管理记录',
      filePath: managementFile,
      content: renderProjectManagementNote(context, model, execution, releaseFile),
      managedProperties: ['type', 'project', 'zentaoExecutionId', 'zentaoExecutionUrl'],
    },
    {
      label: '上线准备记录',
      filePath: releaseFile,
      content: renderReleasePreparationNote(context, model, execution, managementFile),
      managedProperties: ['type', 'project', 'projectManagement', 'zentaoExecutionId', 'plannedDate'],
    },
  ];
  model.project.vault = context.vault;
  model.project.supportingNotes = notes;
  model.supportingNotes = notes;
}

function readProjectsFolder(vault, explicitFolder) {
  const folder = explicitFolder || (() => {
    const settingsPath = path.join(vault, '.obsidian', 'plugins', PROJECT_MANAGER_PLUGIN_ID, 'data.json');
    if (!fs.existsSync(settingsPath)) {
      return DEFAULT_PROJECTS_FOLDER;
    }

    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings.projectsFolder || DEFAULT_PROJECTS_FOLDER;
    } catch (error) {
      throw new Error(`无法解析 Project Manager Enhanced 配置：${error.message}`);
    }
  })();

  if (path.isAbsolute(folder) || folder.split(/[\\/]+/).includes('..')) {
    throw new Error('Project Manager 项目目录必须是 vault 内的相对路径');
  }

  return folder.replace(/^[/\\]+|[/\\]+$/g, '');
}

function assertVault(vault) {
  const resolved = path.resolve(vault);
  if (!fs.existsSync(path.join(resolved, '.obsidian'))) {
    throw new Error(`不是有效的 Obsidian vault：${resolved}`);
  }

  const pluginRoot = path.join(resolved, '.obsidian', 'plugins');
  if (!fs.existsSync(path.join(pluginRoot, PROJECT_MANAGER_PLUGIN_ID, 'manifest.json'))) {
    throw new Error('当前 vault 未安装 Project Manager Enhanced 插件');
  }

  return resolved;
}

function assignTaskPaths(project, taskFolder, existingTasks) {
  const usedPaths = new Map();
  const flat = flattenNodes(project.roots);

  for (const { node } of flat) {
    const existing = existingTasks.byId.get(node.task.id);
    const filePath = existing?.filePath || path.join(taskFolder, taskFileName(node.task.title, node.task.id));
    const normalized = path.resolve(filePath);
    const conflict = usedPaths.get(normalized);
    if (conflict && conflict !== node.task.id) {
      throw new Error(`任务文件名冲突：${filePath}`);
    }

    usedPaths.set(normalized, node.task.id);
    node.filePath = filePath;
  }
}

function collectTeamMembers(project, rawSource, person) {
  const members = new Set();
  const sourceMembers = Array.isArray(rawSource.teamMembers) ? rawSource.teamMembers : [];

  for (const member of sourceMembers) {
    const name = person(member);
    if (name) {
      members.add(name);
    }
  }

  for (const { node } of flattenNodes(project.roots)) {
    for (const assignee of node.task.assignees) {
      if (assignee) {
        members.add(assignee);
      }
    }
  }

  return [...members].sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function defaultCustomFields() {
  return [
    { id: 'zentaoSourceType', name: '禅道来源类型', type: 'select', options: ['story', 'task', 'execution', 'release', 'build'] },
    { id: 'zentaoId', name: '禅道 ID', type: 'text', options: [] },
    { id: 'zentaoUrl', name: '禅道链接', type: 'url', options: [] },
    { id: 'zentaoModule', name: '所属模块', type: 'text', options: [] },
    { id: 'zentaoModuleId', name: '模块 ID', type: 'text', options: [] },
    { id: 'executionId', name: '迭代 ID', type: 'text', options: [] },
    { id: 'storyId', name: '关联需求 ID', type: 'text', options: [] },
    { id: 'completedBy', name: '完成者', type: 'person', options: [] },
    { id: 'estimatedHours', name: '预计工时', type: 'number', options: [] },
    { id: 'consumedHours', name: '已消耗工时', type: 'number', options: [] },
    { id: 'remainingHours', name: '剩余工时', type: 'number', options: [] },
    { id: 'bugSummary', name: 'Bug概况', type: 'text', options: [] },
    { id: 'actualStartedAt', name: '实际开始时间', type: 'text', options: [] },
    { id: 'actualFinishedAt', name: '实际完成时间', type: 'text', options: [] },
    { id: 'sourceUpdatedAt', name: '禅道更新时间', type: 'text', options: [] },
  ];
}

function createSavedView(id, name, filter, viewMode, sortKey = 'stage', groupBy = 'stage') {
  return {
    id,
    name,
    filter: {
      text: '',
      stages: [],
      statuses: [],
      priorities: [],
      assignees: [],
      participants: [],
      tags: [],
      dueDateFilter: 'any',
      showArchived: false,
      ...filter,
    },
    sortKey,
    sortDir: 'asc',
    viewMode,
    groupBy,
  };
}

function defaultSavedViews(currentPerson) {
  const views = [
    createSavedView('zentao-requirements', '需求阶段', { tags: ['zentao-requirement'] }, 'table', 'stage'),
    createSavedView('zentao-tasks', '任务状态', { tags: ['zentao-task'] }, 'kanban', 'status', 'status'),
    createSavedView('zentao-milestones', '里程碑', { tags: ['zentao-milestone'] }, 'gantt', 'due'),
    createSavedView('zentao-high-priority', '高优先级', { priorities: ['critical', 'high'] }, 'table', 'priority'),
    createSavedView(
      'zentao-unfinished',
      '禅道未完成状态',
      { statuses: ['draft', 'reviewing', 'active', 'changing', 'changed', 'wait', 'doing', 'pause', 'paused', 'suspended', 'todo', 'in-progress', 'blocked', 'review'] },
      'table',
      'due',
    ),
    createSavedView('release-management', '上线管理', { tags: ['release-management'] }, 'table', 'due'),
  ];

  if (currentPerson) {
    views.push(createSavedView(
      'zentao-my-participated',
      '我参与的',
      { participants: [currentPerson] },
      'table',
      'due',
    ));
    views.push(createSavedView(
      'zentao-my-work',
      '我的禅道未完成状态',
      {
        statuses: ['draft', 'reviewing', 'active', 'changing', 'changed', 'wait', 'doing', 'pause', 'paused', 'suspended', 'todo', 'in-progress', 'blocked', 'review'],
        participants: [currentPerson],
      },
      'table',
      'due',
    ));
  }

  return views;
}

function prepareProjectTarget(context, projectId, target, existingProject) {
  const projectFile = existingProject?.filePath || target.projectFile;
  if (!existingProject && fs.existsSync(projectFile)) {
    throw new Error(`目标项目文件已存在且不属于当前禅道对象：${projectFile}`);
  }

  // 既有项目始终沿用其所在目录，避免普通同步在未确认时移动用户已有资料。
  const nestedTaskFolder = path.join(path.dirname(projectFile), EXECUTION_TASKS_FOLDER);
  const legacyTaskFolder = projectFile.replace(/\.md$/i, '_tasks');
  const taskFolder = existingProject
    ? (fs.existsSync(nestedTaskFolder) ? nestedTaskFolder : legacyTaskFolder)
    : target.taskFolder;
  return {
    existingProject,
    existingTasks: scanExistingTasks(taskFolder),
    projectFile,
    taskFolder,
  };
}

function finalizeProjectModel(context, target, source, specification) {
  const createdAt = normalizeIsoDate(
    source.openedDate || source.begin,
    String(parseScalar(target.existingProject?.frontmatter || '', 'createdAt') || new Date().toISOString()),
  );
  const updatedAt = sourceUpdatedAt(
    source,
    String(parseScalar(target.existingProject?.frontmatter || '', 'updatedAt') || createdAt),
  );
  const project = {
    id: specification.id,
    title: specification.title,
    description: specification.description,
    color: '#8b72be',
    icon: specification.icon,
    status: String(source.status || ''),
    roots: specification.roots,
    customFields: defaultCustomFields(),
    savedViews: defaultSavedViews(context.currentPerson),
    teamMembers: [],
    createdAt,
    updatedAt,
    filePath: target.projectFile,
    vault: context.vault,
  };

  assignTaskPaths(project, target.taskFolder, target.existingTasks);
  project.teamMembers = collectTeamMembers(project, source, context.person);

  return {
    kind: specification.kind,
    source,
    project,
    taskFolder: target.taskFolder,
    existingProject: target.existingProject,
    existingTasks: target.existingTasks,
  };
}

function createExecutionModel(options, context, execution) {
  const executionId = String(execution.id);
  const projectId = `zentao-execution-${executionId}`;
  const existingProject = context.existingProjects.get(projectId)
    || findExistingProjectFile(context.projectsDirectory, projectId);
  if (existingProject) {
    context.existingProjects.set(projectId, existingProject);
  }
  const systemFolder = existingProject
    ? ''
    : resolveSystemFolder(context.projectsDirectory, options.systemFolder, executionId);
  const executionDirectory = path.join(
    context.projectsDirectory,
    systemFolder,
    `迭代-${executionId}-${safeFilePart(execution.name || '未命名迭代')}`,
  );
  const target = prepareProjectTarget(context, projectId, {
    projectFile: path.join(executionDirectory, EXECUTION_OVERVIEW_FILE),
    taskFolder: path.join(executionDirectory, EXECUTION_TASKS_FOLDER),
  }, existingProject);
  const rawStories = loadStories(options, executionId);
  const tasks = loadTasks(options, executionId);
  const rawBugs = loadBugs(options, executionId);

  if (rawStories.length === 0 && tasks.length === 0) {
    throw new Error(`禅道迭代 #${executionId} 下没有可见需求或任务，为避免创建空项目，本次停止`);
  }

  const stories = loadStoryDetails(options, rawStories, context);
  const bugFacts = buildBugFacts(rawBugs, context.person);
  const storiesById = new Map(stories.map((story) => [String(story.id), story]));
  const enrichedTasks = tasks.map((task) => {
    const linkedStory = storiesById.get(extractObjectId(task.story));
    if (!linkedStory) return task;
    return {
      ...task,
      storySpec: task.storySpec || linkedStory.spec || linkedStory.desc || linkedStory.description || '',
      storyVerify: task.storyVerify || linkedStory.verify || '',
    };
  });
  const richText = createRichTextContext(context);

  try {
    mergeModuleNames(context.moduleNames, loadExecutionModuleNames(options, executionId));
  } catch (error) {
    context.moduleWarnings.push(`迭代 #${executionId} 的模块名称获取失败，将使用模块 ID 占位：${redactSensitiveText(error.message)}`);
  }

  const roots = buildRequirementTaskTree(
    stories,
    enrichedTasks,
    context.person,
    context.moduleName,
    context.server,
    target.existingTasks.metadata,
    richText,
  );
  attachBugStatsToRequirements(roots, bugFacts);
  const milestoneId = deterministicId('milestone', `execution-${executionId}-planned-end`);
  roots.push(makeExecutionMilestoneNode(
    execution,
    context.server,
    target.existingTasks.metadata.get(milestoneId) || {},
  ));
  const description = [
    '<!-- zentao-project-manager:start -->',
    `由 zentao-project-manager 从禅道迭代 #${executionId} 单向同步。`,
    `禅道状态：${execution.status || '未知'}。`,
    '<!-- zentao-project-manager:end -->',
  ].join('\n');

  const model = finalizeProjectModel(context, target, execution, {
    kind: 'execution',
    id: projectId,
    title: `禅道迭代 #${executionId} · ${execution.name || '未命名迭代'}`,
    description,
    icon: '🚀',
    roots,
  });
  model.assets = richText.assets;
  model.bugFacts = bugFacts;
  model.bugStats = aggregateBugFacts(bugFacts);
  model.bugFactsFile = path.join(
    path.dirname(model.project.filePath),
    EXECUTION_DATA_SUPPORT_FOLDER,
    EXECUTION_BUG_FACTS_FILE,
  );
  model.bugFactsContent = renderBugFactsData(projectId, executionId, bugFacts);
  const iterationSummary = buildIterationSummaryData(
    context,
    model,
    execution,
    stories,
    enrichedTasks,
    bugFacts,
  );
  model.iterationSummaryFile = iterationSummary.filePath;
  model.iterationSummaryData = iterationSummary.data;
  model.iterationSummaryContent = iterationSummary.content;
  model.orphanedItems = buildOrphanedItemsModel(options, context, model, executionId);
  createExecutionSupportingNotes(context, model, execution);
  return model;
}

function createBundleContext(options, vault, projectsFolder, localProjects = []) {
  const profileBody = readOnlyCliJson(options, ['profile']);
  const profile = (profileBody.profiles || []).find((item) => item.current) || {};
  if (options.profileCache) {
    options.profileCache.cli = profile;
  }
  const server = profile.server || DEFAULT_SERVER;
  const users = loadUsers(options);
  const person = createPersonResolver(users);
  const moduleNames = new Map([['0', '未设置']]);
  const existingProjects = new Map(localProjects.map((project) => [project.projectId, {
    filePath: project.filePath,
    content: project.content,
    frontmatter: project.frontmatter,
  }]));
  return {
    vault,
    projectsFolder,
    projectsDirectory: path.join(vault, projectsFolder),
    server,
    person,
    currentPerson: person(profile.account) || profile.account || '',
    existingProjects,
    moduleNames,
    moduleName: createModuleResolver(moduleNames),
    moduleWarnings: [],
    assetWarnings: [],
    orphanWarnings: [],
    storyDetails: new Map(),
    storyWarnings: [],
    syncTimestamp: new Date().toISOString(),
  };
}

function createExecutionBundle(
  options,
  vault,
  projectsFolder,
  executionIds,
  scope,
  skippedArchivedProjects = [],
  localProjects = [],
) {
  const context = createBundleContext(options, vault, projectsFolder, localProjects);
  const executions = loadExecutions(options);
  const executionsById = new Map(executions.map((execution) => [String(execution.id), execution]));
  const missingIds = executionIds.filter((executionId) => !executionsById.has(String(executionId)));
  if (missingIds.length > 0) {
    throw new Error(`未找到禅道迭代：${missingIds.map((executionId) => `#${executionId}`).join('、')}`);
  }

  const models = executionIds.map((executionId) => createExecutionModel(
    { ...options, id: String(executionId) },
    context,
    executionsById.get(String(executionId)),
  ));

  return {
    scope,
    context,
    models,
    skippedArchivedProjects,
  };
}

function createBundle(options, vault, projectsFolder) {
  return createExecutionBundle(
    options,
    vault,
    projectsFolder,
    [options.id],
    `zentao-execution-${options.id}`,
  );
}

function createLocalProjectsBundle(options, vault, projectsFolder) {
  const projectsDirectory = path.join(vault, projectsFolder);
  const localProjects = listLocalExecutionProjects(vault, projectsDirectory);
  const skippedArchivedProjects = options.includeArchived
    ? []
    : localProjects.filter((project) => project.archived);
  const selectedProjects = options.includeArchived
    ? localProjects
    : localProjects.filter((project) => !project.archived);

  // 本地没有可同步项目时不访问禅道，只返回可核对的空摘要。
  if (selectedProjects.length === 0) {
    return {
      scope: 'local-executions',
      context: {
        moduleWarnings: [],
        assetWarnings: [],
        orphanWarnings: [],
        storyWarnings: [],
      },
      models: [],
      skippedArchivedProjects,
    };
  }

  return createExecutionBundle(
    options,
    vault,
    projectsFolder,
    selectedProjects.map((project) => project.id),
    'local-executions',
    skippedArchivedProjects,
    localProjects,
  );
}

function calculateChanges(model) {
  const changes = [];
  const generatedTaskIds = new Set();
  const flat = flattenNodes(model.project.roots);

  for (const { node, parent } of flat) {
    generatedTaskIds.add(node.task.id);
    const existing = model.existingTasks.byId.get(node.task.id);
    const content = renderTaskContent(node, parent, model.project, existing?.content || '');
    changes.push({
      type: existing ? (existing.content === content ? 'unchanged' : 'update') : 'create',
      filePath: node.filePath,
      content,
    });
  }

  const projectContent = renderProjectContent(model.project);
  changes.push({
    type: model.existingProject
      ? (model.existingProject.content === projectContent ? 'unchanged' : 'update')
      : 'create',
    filePath: model.project.filePath,
    content: projectContent,
    project: true,
  });

  if (model.bugFactsFile && model.bugFactsContent) {
    const existingBugFacts = fs.existsSync(model.bugFactsFile)
      ? fs.readFileSync(model.bugFactsFile, 'utf8')
      : null;
    changes.push({
      type: existingBugFacts === null
        ? 'create'
        : (existingBugFacts === model.bugFactsContent ? 'unchanged' : 'update'),
      filePath: model.bugFactsFile,
      content: model.bugFactsContent,
      dataSupport: true,
    });
  }

  if (model.iterationSummaryFile && model.iterationSummaryContent) {
    const existingIterationSummary = fs.existsSync(model.iterationSummaryFile)
      ? fs.readFileSync(model.iterationSummaryFile, 'utf8')
      : null;
    changes.push({
      type: existingIterationSummary === null
        ? 'create'
        : (existingIterationSummary === model.iterationSummaryContent ? 'unchanged' : 'update'),
      filePath: model.iterationSummaryFile,
      content: model.iterationSummaryContent,
      dataSupport: true,
      iterationSummary: true,
    });
  }

  for (const note of model.supportingNotes || []) {
    if (!fs.existsSync(note.filePath)) {
      changes.push({
        type: 'create',
        filePath: note.filePath,
        content: note.content,
        supportingNote: true,
        propertyChanges: [],
      });
      continue;
    }

    const existingContent = fs.readFileSync(note.filePath, 'utf8');
    const merged = mergeManagedNoteProperties(
      existingContent,
      note.content,
      note.managedProperties || [],
    );
    changes.push({
      type: merged.changedProperties.length > 0 ? 'update' : 'unchanged',
      filePath: note.filePath,
      content: merged.content,
      supportingNote: true,
      propertyChanges: merged.changedProperties,
    });
  }

  for (const [filePath, content] of model.assets || []) {
    const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    changes.push({
      type: existingContent === null
        ? 'create'
        : (existingContent.equals(content) ? 'unchanged' : 'update'),
      filePath,
      content,
      asset: true,
    });
  }

  const orphaned = [];
  for (const record of model.orphanedItems?.records || []) {
    const existing = model.existingTasks.byId.get(record.id);
    if (!existing) {
      throw new Error(`遗留清单引用了不存在的本地事项：${record.filePath}`);
    }

    const content = renderOrphanedTaskContent(existing.content, record);
    changes.push({
      type: existing.content === content ? 'unchanged' : 'update',
      filePath: existing.filePath,
      content,
      orphanedNote: true,
      propertyChanges: existing.content === content
        ? []
        : [
          'pm-task',
          'customFields.zentaoSyncState',
          'customFields.zentaoMissingSince',
          'customFields.zentaoLastCheckedAt',
          'customFields.zentaoStateChangedAt',
          'customFields.zentaoMissingCount',
          'customFields.zentaoRemoteExecutionIds',
        ],
    });
    orphaned.push({
      ...record,
      filePath: existing.filePath,
    });
  }

  if (model.orphanedItems?.filePath && model.orphanedItems?.content !== null) {
    const existingOrphanedItems = fs.existsSync(model.orphanedItems.filePath)
      ? fs.readFileSync(model.orphanedItems.filePath, 'utf8')
      : null;
    changes.push({
      type: existingOrphanedItems === null
        ? 'create'
        : (existingOrphanedItems === model.orphanedItems.content ? 'unchanged' : 'update'),
      filePath: model.orphanedItems.filePath,
      content: model.orphanedItems.content,
      dataSupport: true,
      orphanedItems: true,
    });
  }

  return {
    changes,
    orphaned,
    restored: model.orphanedItems?.restored || [],
  };
}

function calculateBundleChanges(bundle) {
  const changes = [];
  const orphaned = [];
  const restored = [];

  for (const model of bundle.models) {
    const result = calculateChanges(model);
    changes.push(...result.changes);
    orphaned.push(...result.orphaned);
    restored.push(...result.restored);
  }

  return { changes, orphaned, restored };
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  if (Buffer.isBuffer(content)) fs.writeFileSync(temporary, content);
  else fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, filePath);
}

function applyChanges(changes) {
  // 先写资源、统计数据和任务，再写项目索引，避免页面在中间状态下引用不存在的文件。
  const ordered = [...changes].sort((left, right) => {
    const priority = (change) => change.asset || change.dataSupport ? 0 : (change.project ? 2 : 1);
    return priority(left) - priority(right);
  });
  for (const change of ordered) {
    if (change.type === 'unchanged') {
      continue;
    }

    writeAtomic(change.filePath, change.content);
  }
}

function summarize(bundle, result, applied, vault) {
  const relative = (filePath) => path.relative(vault, filePath).replace(/\\/g, '/');
  const counts = { create: 0, update: 0, unchanged: 0 };
  for (const change of result.changes) {
    counts[change.type] += 1;
  }
  const managementTags = {};
  for (const model of bundle.models) {
    for (const { node } of flattenNodes(model.project.roots)) {
      for (const tag of node.task.tags.filter(isManagedWorkTag)) {
        managementTags[tag] = (managementTags[tag] || 0) + 1;
      }
    }
  }
  const orphanStateCounts = {};
  for (const state of Object.values(ZENTAO_ORPHAN_STATE)) {
    orphanStateCounts[state] = result.orphaned.filter((record) => record.state === state).length;
  }

  return {
    mode: applied ? 'apply' : 'dry-run',
    scope: bundle.scope,
    skippedArchivedProjects: (bundle.skippedArchivedProjects || []).map((project) => ({
      id: project.id,
      path: relative(project.filePath),
    })),
    projects: bundle.models.map((model) => ({
      kind: model.kind,
      path: relative(model.project.filePath),
      taskFolder: relative(model.taskFolder),
      requirementCount: flattenNodes(model.project.roots).filter(({ node }) => node.kind === 'requirement').length,
      taskCount: flattenNodes(model.project.roots).filter(({ node }) => node.kind === 'task').length,
      milestoneCount: flattenNodes(model.project.roots).filter(({ node }) => node.kind === 'milestone').length,
      assetCount: model.assets?.size || 0,
      bugFactCount: model.bugFacts?.length || 0,
      bugStats: model.bugStats || emptyBugStats(),
      bugFactsFile: model.bugFactsFile ? relative(model.bugFactsFile) : '',
      iterationSummaryFile: model.iterationSummaryFile ? relative(model.iterationSummaryFile) : '',
      iterationSummaryStatus: result.changes.find((change) => (
        change.iterationSummary && change.filePath === model.iterationSummaryFile
      ))?.type || 'unchanged',
      iterationSummaryCoverage: model.iterationSummaryData?.coverage || {},
      unassignedRequirementCount: model.iterationSummaryData?.unassigned?.requirementIds?.length || 0,
      unassignedIndependentTaskCount: model.iterationSummaryData?.unassigned?.independentTaskIds?.length || 0,
      orphanedItemsFile: model.orphanedItems?.filePath ? relative(model.orphanedItems.filePath) : '',
      orphanedItemCount: model.orphanedItems?.records?.length || 0,
      supportingNotes: (model.supportingNotes || []).map((note) => relative(note.filePath)),
    })),
    requirementCount: bundle.models.reduce(
      (total, model) => total + flattenNodes(model.project.roots).filter(({ node }) => node.kind === 'requirement').length,
      0,
    ),
    taskCount: bundle.models.reduce(
      (total, model) => total + flattenNodes(model.project.roots).filter(({ node }) => node.kind === 'task').length,
      0,
    ),
    milestoneCount: bundle.models.reduce(
      (total, model) => total + flattenNodes(model.project.roots).filter(({ node }) => node.kind === 'milestone').length,
      0,
    ),
    assetCount: bundle.models.reduce((total, model) => total + (model.assets?.size || 0), 0),
    bugFactCount: bundle.models.reduce((total, model) => total + (model.bugFacts?.length || 0), 0),
    changes: counts,
    managementTags,
    propertyUpdateCount: result.changes.filter((change) => change.propertyChanges?.length > 0).length,
    newOrphanedItemCount: bundle.models.reduce(
      (total, model) => total + Number(model.orphanedItems?.newCount || 0),
      0,
    ),
    continuedOrphanedItemCount: bundle.models.reduce(
      (total, model) => total + Number(model.orphanedItems?.continuedCount || 0),
      0,
    ),
    restoredItemCount: result.restored.length,
    orphanStateCounts,
    files: result.changes
      .filter((change) => change.type !== 'unchanged')
      .map((change) => ({
        type: change.type,
        path: relative(change.filePath),
        propertyChanges: change.propertyChanges || [],
      })),
    orphanedFiles: result.orphaned.map((record) => relative(record.filePath)),
    orphanedItems: result.orphaned.map((record) => ({
      id: record.id,
      sourceType: record.sourceType,
      zentaoId: record.zentaoId,
      state: record.state,
      path: relative(record.filePath),
      missingSyncCount: record.missingSyncCount,
      remoteExecutionIds: record.remoteExecutionIds,
    })),
    restoredItems: result.restored.map((record) => ({
      id: String(record.id || ''),
      sourceType: String(record.sourceType || ''),
      zentaoId: String(record.zentaoId || ''),
      path: String(record.filePath || ''),
    })),
    warnings: [
      ...bundle.context.moduleWarnings,
      ...bundle.context.assetWarnings,
      ...bundle.context.orphanWarnings,
      ...bundle.context.storyWarnings,
    ],
  };
}

function printSummary(summary, asJson, compact) {
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`${summary.mode === 'apply' ? '已同步' : '预览完成'}：${summary.scope}`);
  console.log(`本地项目：${summary.projects.length} 个；需求：${summary.requirementCount}；任务：${summary.taskCount}；里程碑：${summary.milestoneCount}；Bug事实：${summary.bugFactCount}；图片资源同步：已关闭`);
  if (summary.skippedArchivedProjects.length > 0) {
    console.log(`已跳过归档项目：${summary.skippedArchivedProjects.length} 个（${summary.skippedArchivedProjects.map((project) => `#${project.id}`).join('、')}）`);
  }
  console.log(`变更统计：新增 ${summary.changes.create}，更新 ${summary.changes.update}，无变化 ${summary.changes.unchanged}`);
  const managementTagEntries = Object.entries(summary.managementTags || {});
  if (managementTagEntries.length > 0) {
    console.log(`管理标签：${managementTagEntries.map(([tag, count]) => `${tag} ${count}`).join('，')}`);
  }
  if (summary.propertyUpdateCount > 0) {
    console.log(`笔记属性更新：${summary.propertyUpdateCount} 个文件`);
  }

  for (const project of summary.projects) {
    if (compact) {
      console.log(`项目文件：${project.path}；事项目录：${project.taskFolder}`);
    }

    console.log(`Bug汇总：共 ${project.bugStats.total}；未关闭 ${project.bugStats.unclosed}；未关闭1级 ${project.bugStats.unclosedSeverity1}；未关闭2级 ${project.bugStats.unclosedSeverity2}；未解决 ${project.bugStats.unresolved}；待验证/关闭 ${project.bugStats.resolvedOpen}；数据文件 ${project.bugFactsFile}`);
    const iterationSummaryStatus = {
      create: '新增',
      update: '更新',
      unchanged: '无变化',
    }[project.iterationSummaryStatus] || project.iterationSummaryStatus;
    console.log(`迭代总结：${iterationSummaryStatus}；${project.iterationSummaryFile}；需求内容覆盖 ${project.iterationSummaryCoverage.requirementWithDescription || 0}/${project.iterationSummaryCoverage.requirementTotal || 0}`);
    console.log(`遗留清单：${project.orphanedItemCount} 项；${project.orphanedItemsFile}`);
    if (project.unassignedRequirementCount > 0 || project.unassignedIndependentTaskCount > 0) {
      console.log(`未安排交付：需求 ${project.unassignedRequirementCount}；独立任务 ${project.unassignedIndependentTaskCount}`);
    }
    if (project.supportingNotes.length > 0) {
      console.log(`项目管理笔记（正文和本地属性保留，同步属性按差异更新）：${project.supportingNotes.join('，')}`);
    }
  }

  if (compact) {
    if (summary.files.length > 0) {
      console.log(`变更文件：${summary.files.length} 个；普通文件明细已省略，去掉 --compact 可查看完整列表`);
    }

    // 项目资料属性属于人工维护边界，即使在紧凑模式下也必须逐项报告。
    for (const file of summary.files.filter((item) => item.propertyChanges.length > 0)) {
      console.log(`- ${file.type === 'create' ? '新增' : '更新'} ${file.path}（属性：${file.propertyChanges.join('、')}）`);
    }
  } else {
    for (const file of summary.files) {
      const propertyNote = file.propertyChanges.length > 0
        ? `（属性：${file.propertyChanges.join('、')}）`
        : '';
      console.log(`- ${file.type === 'create' ? '新增' : '更新'} ${file.path}${propertyNote}`);
    }
  }

  if (summary.orphanedItems.length > 0 || summary.restoredItemCount > 0) {
    const stateLabels = {
      [ZENTAO_ORPHAN_STATE.MISSING_UNCONFIRMED]: '待确认',
      [ZENTAO_ORPHAN_STATE.MOVED_TO_OTHER_EXECUTION]: '移至其他迭代',
      [ZENTAO_ORPHAN_STATE.REMOVED_FROM_EXECUTION]: '已移出迭代',
      [ZENTAO_ORPHAN_STATE.DELETED_REMOTE]: '禅道已删除',
      [ZENTAO_ORPHAN_STATE.VERIFY_FAILED]: '验证失败',
    };
    const stateSummary = Object.entries(summary.orphanStateCounts)
      .filter(([, count]) => count > 0)
      .map(([state, count]) => `${stateLabels[state] || state} ${count}`)
      .join('，');
    console.log(`遗留事项：新增 ${summary.newOrphanedItemCount}，持续 ${summary.continuedOrphanedItemCount}，恢复 ${summary.restoredItemCount}${stateSummary ? `；${stateSummary}` : ''}`);

    for (const item of summary.orphanedItems) {
      const sourceLabel = item.sourceType === 'story' ? '需求' : '任务';
      const targetExecutions = item.remoteExecutionIds.length > 0
        ? `；当前迭代 #${item.remoteExecutionIds.join('、#')}`
        : '';
      console.log(`- ${stateLabels[item.state] || item.state}：${sourceLabel} #${item.zentaoId || '未知'}；连续 ${item.missingSyncCount} 次${targetExecutions}；${item.path}`);
    }
    for (const item of summary.restoredItems) {
      const sourceLabel = item.sourceType === 'story' ? '需求' : '任务';
      console.log(`- 已恢复：${sourceLabel} #${item.zentaoId || '未知'}；${item.path}`);
    }
  }

  if (summary.warnings.length > 0) {
    console.log('同步警告：');
    for (const warning of summary.warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (summary.mode === 'dry-run') {
    console.log('当前为只读预览；确认后追加 --apply 才会写入文件。');
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
  const bundle = options.scope === 'all-local'
    ? createLocalProjectsBundle(options, vault, projectsFolder)
    : createBundle(options, vault, projectsFolder);
  const result = calculateBundleChanges(bundle);

  if (options.apply) {
    applyChanges(result.changes);
  }

  printSummary(summarize(bundle, result, options.apply, vault), options.json, options.compact);
}

try {
  main();
} catch (error) {
  console.error(`同步失败：${redactSensitiveText(error.message)}`);
  process.exitCode = 1;
}

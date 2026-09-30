'use strict';

// 保存运行设施所需的原始函数，官方 CLI 的文件写入稍后单独拦截。
const fs = { ...require('node:fs') };
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const configPath = process.env.FANGZHIKUN_SKILLS_CONFIG || path.join(os.homedir(), '.config', 'fangzhikun-skills', 'runtime.json');
const stateRoot = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'fangzhikun-skills', 'weaver');
const secrets = new Set();
const secretKey = /password|passwd|secret|token|cookie|authorization|eteamsid|stticket/i;
const output = process.stdout.write.bind(process.stdout);

function digest(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function losslessJson(text) {
  const normalized = text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token.startsWith('"') || !/^-?\d+$/.test(token)) return token;
    const integer = BigInt(token);
    return integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER) ? JSON.stringify(token) : token;
  });
  return JSON.parse(normalized);
}

function remember(value) {
  if (typeof value === 'string' && value.length > 0) secrets.add(value);
}

function redact(value, key = '') {
  if (secretKey.test(key)) return '[已隐藏凭证]';
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && secretKey.test(value[0])) return [value[0], '[已隐藏凭证]'];
    return value.map(item => redact(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'value' && typeof value.name === 'string' && secretKey.test(value.name) ? '[已隐藏凭证]' : redact(v, k)]));
  }
  if (typeof value !== 'string') return value;
  let text = value;
  for (const secret of secrets) text = text.split(secret).join('[已隐藏凭证]');
  if (/^\s*[\[{]/.test(text)) {
    try { return JSON.stringify(redact(JSON.parse(text))); } catch { /* 非 JSON 正文继续做已知秘密替换。 */ }
  }
  return text.replace(/(ETEAMSID\s*=)[^;\s]+/gi, '$1[已隐藏凭证]');
}

function emit(value) {
  output(JSON.stringify(redact(value), null, 2) + '\n');
}

function readJson(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('拒绝读取软链接配置或审核记录');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function privateDirectory(directory) {
  const resolved = path.resolve(directory);
  let cursor = resolved;
  while (cursor !== path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('本机状态目录不能包含软链接');
    cursor = path.dirname(cursor);
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  fs.chmodSync(resolved, 0o700);
}

function writePrivateNew(file, data) {
  // 只供本模块的私有运行记录使用，避免 writeFileSync 内部再次调用已拦截的 fs.openSync。
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    const bytes = Buffer.from(data, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new Error('私有运行记录未能完整写入');
      offset += count;
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeJson(file, value, exclusive = false) {
  privateDirectory(path.dirname(file));
  const data = JSON.stringify(value, null, 2) + '\n';
  if (exclusive) {
    writePrivateNew(file, data);
    return;
  }
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('拒绝覆盖软链接记录');
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  writePrivateNew(temporary, data);
  fs.renameSync(temporary, file);
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('环境地址必须是不含账号、参数或路径的 HTTP(S) origin');
  }
  return url.origin;
}

function resolveEnvironment(alias) {
  if (!['dev', 'pre', 'prod'].includes(alias)) throw new Error('必须显式指定 --env dev、pre 或 prod');
  const settings = readJson(configPath).weaver;
  if (!settings || typeof settings !== 'object') throw new Error('尚未登记 weaver 本机配置，请先预览并确认配置');
  const physical = alias === 'prod' ? 'prod' : 'test';
  const environments = settings.environments;
  if (!environments?.test || !environments?.prod) throw new Error('必须同时登记独立的 test 和 prod 环境');
  const testUrl = normalizeUrl(environments.test.baseUrl);
  const prodUrl = normalizeUrl(environments.prod.baseUrl);
  if (testUrl === prodUrl) throw new Error('测试和生产环境地址不得相同');
  if (environments.test.credentialEntry === environments.prod.credentialEntry) throw new Error('测试和生产凭证条目必须独立');
  const chosen = environments[physical];
  if (typeof chosen.credentialEntry !== 'string' || !chosen.credentialEntry.trim()) throw new Error('缺少环境对应的钥匙串条目名');
  const baseUrl = normalizeUrl(chosen.baseUrl);
  const environment = {
    alias, physical, baseUrl,
    passportUrl: normalizeUrl(chosen.passportUrl || chosen.baseUrl),
    credentialEntry: chosen.credentialEntry,
    keychainService: settings.keychainService || 'weaver-oa',
    approvalTimeoutSeconds: settings.approvalTimeoutSeconds ?? 1800,
    cliPackage: settings.cliPackage || null,
  };
  if (!Number.isInteger(environment.approvalTimeoutSeconds) || environment.approvalTimeoutSeconds < 30 || environment.approvalTimeoutSeconds > 7200) throw new Error('审核等待时间必须在 30 到 7200 秒之间');
  environment.configDigest = digest(JSON.stringify(environment));
  return environment;
}

function locateCli(environment) {
  let root = environment.cliPackage;
  if (!root) {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 10000 }).trim();
    root = path.join(globalRoot, 'weaver-e10-builder');
  }
  if (!path.isAbsolute(root)) throw new Error('cliPackage 必须是本机绝对路径');
  root = fs.realpathSync(root);
  const metadata = readJson(path.join(root, 'package.json'));
  if (metadata.name !== 'weaver-e10-builder' || !/^1\.\d+\.\d+$/.test(metadata.version)) throw new Error('仅支持经核对的官方 weaver-e10-builder 1.x 包');
  const parts = metadata.version.split('.').map(Number);
  if (parts[1] < 1 || (parts[1] === 1 && parts[2] < 9)) throw new Error('官方 CLI 版本不能低于 1.1.9');
  for (const relative of ['dist/index.js', 'dist/core/auth.js', 'dist/core/client.js']) {
    if (!fs.existsSync(path.join(root, relative))) throw new Error('官方 CLI 的模块结构不兼容');
  }
  return { root, version: metadata.version };
}

function cliFingerprint(cli) {
  const hash = crypto.createHash('sha256');
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('官方 CLI 代码不能包含软链接');
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        hash.update(path.relative(cli.root, file));
        hash.update(fs.readFileSync(file));
      }
    }
  }
  hash.update(fs.readFileSync(path.join(cli.root, 'package.json')));
  walk(path.join(cli.root, 'dist'));
  return hash.digest('hex');
}

function wrapperFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(__dirname).sort()) {
    if (name.endsWith('.js') || name.endsWith('.py')) { hash.update(name); hash.update(fs.readFileSync(path.join(__dirname, name))); }
  }
  return hash.digest('hex');
}

function jobDirectory(jobId) {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error('任务 ID 格式错误');
  return path.join(stateRoot, 'jobs', jobId);
}

function loadPolicy() {
  const file = path.join(__dirname, '..', 'references', 'read-only.json');
  const raw = fs.readFileSync(file, 'utf8');
  const rules = JSON.parse(raw).rules;
  if (!Array.isArray(rules)) throw new Error('只读策略格式不合法');
  return { fingerprint: digest(raw), rules: rules.map(rule => ({ ...rule, match: new RegExp(rule.path) })) };
}

module.exports = { fs, path, crypto, configPath, stateRoot, digest, losslessJson, remember, redact, emit, readJson, privateDirectory, writeJson, resolveEnvironment, locateCli, cliFingerprint, wrapperFingerprint, jobDirectory, loadPolicy };

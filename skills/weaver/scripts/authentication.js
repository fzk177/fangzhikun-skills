'use strict';

const { pathToFileURL } = require('node:url');
const { path, digest, remember, losslessJson } = require('./common.js');
const nativeFetch = globalThis.fetch.bind(globalThis);

async function dependencies(cli) {
  const keyring = require(path.join(cli.root, 'node_modules', '@napi-rs', 'keyring'));
  const { AuthSession } = await import(pathToFileURL(path.join(cli.root, 'dist', 'core', 'auth.js')).href);
  return { Entry: keyring.Entry, AuthSession };
}

function entries(environment, Entry) {
  if (process.platform !== 'darwin') throw new Error('当前实现仅使用 macOS 钥匙串，不回退到磁盘凭证');
  const identity = environment.physical + ':' + environment.credentialEntry + ':' + digest(environment.baseUrl).slice(0, 24);
  return {
    credential: new Entry(environment.keychainService, identity + ':credential'),
    session: new Entry(environment.keychainService, identity + ':session'),
  };
}

function readRecord(entry) {
  let raw;
  try { raw = entry.getPassword(); }
  catch (error) {
    if (/no entry|not found|does not exist|no matching|could not be found|-25300/i.test(String(error?.message || ''))) return null;
    throw new Error('无法访问 macOS 钥匙串，请确认钥匙串已解锁且授予本机访问权限');
  }
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { throw new Error('钥匙串记录格式错误，未使用或输出其内容'); }
}

async function storeCredential(environment, cli, value, replace) {
  if (typeof value.account !== 'string' || !value.account.trim() || typeof value.password !== 'string' || !value.password) throw new Error('账号和密码不能为空');
  remember(value.account); remember(value.password);
  const { Entry } = await dependencies(cli);
  const slots = entries(environment, Entry);
  const existing = readRecord(slots.credential);
  if (existing && !replace) throw new Error('该环境已有凭证，未覆盖；替换需 --replace 和本机确认');
  try {
    // 先失效旧会话，避免替换凭证失败时沿用其他账号。
    slots.session.setPassword('{}');
    slots.credential.setPassword(JSON.stringify({ account: value.account, password: value.password, baseUrl: environment.baseUrl, tenantKey: value.tenantKey || '', savedAt: new Date().toISOString() }));
  } catch { throw new Error('钥匙串写入失败；未回退到文件或环境变量'); }
}

function identityFromResponse(response, body) {
  const userId = response.headers.get('employeeId') || body?.currentUser?.employeeId || body?.currentUser?.id || body?.data?.employeeId || body?.data?.id || body?.employeeId;
  const tenantKey = body?.currentTenant?.tenantKey || body?.currentUser?.tenantKey || body?.data?.tenantKey || body?.data?.tenantkey || body?.tenantKey;
  if (!userId || !/^\d+$/.test(String(userId)) || !tenantKey) return null;
  return { userId: String(userId), tenantKey: String(tenantKey) };
}

async function checkSession(environment, sessionData) {
  const cookie = sessionData?.cookies?.ETEAMSID;
  if (!cookie || sessionData.baseUrl !== environment.baseUrl) return null;
  remember(cookie);
  const url = new URL('/api/baseserver/layout/teamsCheck', environment.baseUrl);
  url.search = new URLSearchParams({ clientType: 'not_xinchuang', client: 'WEB', domainName: environment.baseUrl }).toString();
  let response;
  try {
    response = await nativeFetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', eteamsid: cookie, origin: environment.baseUrl }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch { throw new Error('身份校验连接失败；未重复尝试登录'); }
  if ([401, 403, 302, 303, 307, 308].includes(response.status)) return null;
  if (response.status !== 200) throw new Error('身份校验返回异常 HTTP 状态，未尝试密码登录');
  const text = await response.text();
  let body = null;
  try { body = losslessJson(text); } catch { /* 不缓存无法解析的身份。 */ }
  return identityFromResponse(response, body);
}

async function login(environment, cli, context) {
  if (context.loginAttempted) throw new Error('本执行阶段已经进行过一次登录；不反复尝试密码');
  context.loginAttempted = true;
  const { Entry, AuthSession } = await dependencies(cli);
  const slots = entries(environment, Entry);
  const credential = readRecord(slots.credential);
  if (!credential?.account || !credential?.password || credential.baseUrl !== environment.baseUrl) throw new Error('该环境未录入有效钥匙串凭证，请由用户在本机终端执行 enroll.py');
  remember(credential.account); remember(credential.password);
  const allowed = new Map([
    ['GET ' + environment.passportUrl + '/papi/passport/info/getUrlInfo', true],
    ['POST ' + environment.passportUrl + '/papi/passport/login/pclogin', true],
    ['POST ' + environment.baseUrl + '/papi/baseserver/layout/checkTicket', true],
  ]);
  const previousFetch = globalThis.fetch;
  let loginResponseError = false;
  let publicKeyReady = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init.method || input.method || 'GET').toUpperCase();
    if (!allowed.has(method + ' ' + url.origin + url.pathname)) throw new Error('认证实现尝试访问未授权接口');
    if (url.pathname.endsWith('/pclogin') && !publicKeyReady) throw new Error('未取得服务端公钥，禁止使用内置回退公钥发送账号密码');
    const response = await nativeFetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (url.pathname.endsWith('/getUrlInfo')) {
      const value = await response.clone().json().catch(() => null);
      if (response.status !== 200 || value?.code !== 200 || !value?.data?.publicKey) throw new Error('无法取得服务端登录公钥');
      publicKeyReady = true;
    }
    if (url.pathname.endsWith('/pclogin')) {
      const value = await response.clone().json().catch(() => null);
      if (response.status !== 200 || value?.code !== 200 || !value?.status) loginResponseError = true;
    }
    return response;
  };
  const session = new AuthSession({ cookies: {}, userId: '', tenantKey: credential.tenantKey || '', baseUrl: environment.baseUrl, passportUrl: environment.passportUrl });
  try { await session.rsaLogin(credential.account, credential.password); }
  catch {
    throw new Error(loginResponseError ? '自动登录被服务端拒绝；请核对账号有效性、验证码、多因素认证或 SSO 要求。未再次尝试。' : '官方自动登录协议未成功完成；未输出凭证，未重复登录');
  } finally { globalThis.fetch = previousFetch; }
  const candidate = { cookies: session.cookies, baseUrl: environment.baseUrl, passportUrl: environment.passportUrl };
  const identity = await checkSession(environment, candidate);
  if (!identity) throw new Error('登录后未能确认真实员工与租户，不缓存 unknown 身份');
  const data = { ...candidate, ...identity, savedAt: new Date().toISOString() };
  remember(data.cookies.ETEAMSID);
  try { slots.session.setPassword(JSON.stringify(data)); }
  catch { throw new Error('会话钥匙串缓存失败，不写入磁盘 auth 文件'); }
  return data;
}

async function ensureSession(environment, cli, context, force = false) {
  const { Entry } = await dependencies(cli);
  if (!force) {
    const cache = readRecord(entries(environment, Entry).session);
    const identity = await checkSession(environment, cache);
    if (identity) return { ...cache, ...identity };
  }
  return login(environment, cli, context);
}

module.exports = { dependencies, storeCredential, checkSession, ensureSession };

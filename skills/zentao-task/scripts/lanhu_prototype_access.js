#!/usr/bin/env node

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { expandHome, loadRuntimeConfig } = require('./runtime_config');

const RUNTIME_CONFIG = loadRuntimeConfig();
const DEFAULT_CHROME = expandHome(RUNTIME_CONFIG.prototype?.chrome)
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_KEYCHAIN_SERVICE = String(RUNTIME_CONFIG.prototype?.keychainService || 'prototype-platform');
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_VIEWPORT_WIDTH = 1920;
const DEFAULT_VIEWPORT_HEIGHT = 1200;

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 命令行参数
 * @returns {object} 参数对象
 */
function parseArgs(argv) {
  const options = {
    url: '',
    outputDir: '',
    chrome: DEFAULT_CHROME,
    keychainService: DEFAULT_KEYCHAIN_SERVICE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--url') {
      options.url = next || '';
      index += 1;
    } else if (arg === '--output-dir') {
      options.outputDir = next || '';
      index += 1;
    } else if (arg === '--chrome') {
      options.chrome = next || '';
      index += 1;
    } else if (arg === '--keychain-service') {
      options.keychainService = next || '';
      index += 1;
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(next || DEFAULT_TIMEOUT_MS);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  return options;
}

/**
 * 输出使用说明。
 */
function printHelp() {
  process.stdout.write([
    '用法：',
    '  node lanhu_prototype_access.js --url <蓝湖链接> --output-dir <输出目录>',
    '',
    '选项：',
    '  --keychain-service <服务名>  默认读取本机 runtime.json',
    '  --chrome <Chrome 路径>       默认读取本机 runtime.json 或使用 macOS Google Chrome',
    '  --timeout-ms <毫秒>          默认 60000',
    '',
  ].join('\n'));
}

/**
 * 等待指定时长。
 *
 * @param {number} milliseconds 毫秒数
 * @returns {Promise<void>} 等待结果
 */
function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * 对错误消息做脱敏处理。
 *
 * @param {unknown} value 原始错误
 * @returns {string} 脱敏错误文本
 */
function redactSensitiveText(value) {
  return String(value || '')
    .replace(/(password|token|secret|cookie|session|account)\s*[:=]\s*[^,\s}\]]+/gi, '$1=***')
    .replace(/1\d{10}/g, '***');
}

/**
 * 从 macOS 钥匙串读取蓝湖账号和密码。
 *
 * @param {string} service 钥匙串服务名
 * @returns {{account: string, password: string}} 登录凭据
 */
function readLanhuCredentials(service) {
  const metadataResult = childProcess.spawnSync('security', [
    'find-generic-password',
    '-s', service,
  ], {
    encoding: 'utf8',
  });

  if (metadataResult.error || metadataResult.status !== 0) {
    throw new Error(`macOS 钥匙串中不存在服务 ${service}，请先创建专用通用密码条目`);
  }

  const accountMatch = String(metadataResult.stdout || '').match(/"acct"<blob>="([^"]+)"/);
  if (!accountMatch || !accountMatch[1]) {
    throw new Error(`macOS 钥匙串服务 ${service} 缺少账号属性`);
  }

  const passwordResult = childProcess.spawnSync('security', [
    'find-generic-password',
    '-s', service,
    '-w',
  ], {
    encoding: 'utf8',
  });

  if (passwordResult.error || passwordResult.status !== 0) {
    throw new Error(`无法读取 macOS 钥匙串服务 ${service} 的密码`);
  }

  const password = String(passwordResult.stdout || '').replace(/[\r\n]+$/, '');
  if (!password) {
    throw new Error(`macOS 钥匙串服务 ${service} 返回了空密码`);
  }

  return {
    account: accountMatch[1],
    password,
  };
}

/**
 * 等待文件出现。
 *
 * @param {string} filePath 文件路径
 * @param {number} timeoutMs 超时时间
 * @returns {Promise<void>} 等待结果
 */
async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await wait(100);
  }

  throw new Error(`等待 Chrome 调试端口超时：${filePath}`);
}

/**
 * Chrome DevTools Protocol 客户端。
 */
class CdpClient {
  /**
   * @param {string} websocketUrl WebSocket 地址
   */
  constructor(websocketUrl) {
    this.websocketUrl = websocketUrl;
    this.websocket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  /**
   * 建立 CDP 连接。
   *
   * @returns {Promise<void>} 连接结果
   */
  async connect() {
    await new Promise((resolve, reject) => {
      const websocket = new WebSocket(this.websocketUrl);
      this.websocket = websocket;

      websocket.addEventListener('open', () => resolve());
      websocket.addEventListener('error', () => reject(new Error('无法连接 Chrome DevTools Protocol')));
      websocket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data || '{}'));
        if (!message.id || !this.pending.has(message.id)) {
          return;
        }

        const pendingRequest = this.pending.get(message.id);
        this.pending.delete(message.id);

        if (message.error) {
          pendingRequest.reject(new Error(message.error.message || 'CDP 调用失败'));
          return;
        }

        pendingRequest.resolve(message.result || {});
      });
    });
  }

  /**
   * 调用 CDP 方法。
   *
   * @param {string} method 方法名
   * @param {object} params 参数
   * @returns {Promise<object>} 调用结果
   */
  async send(method, params = {}) {
    if (!this.websocket) {
      throw new Error('CDP 尚未连接');
    }

    const id = this.nextId;
    this.nextId += 1;

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.websocket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  /**
   * 关闭 CDP 连接。
   */
  close() {
    if (this.websocket) {
      this.websocket.close();
    }
  }
}

/**
 * 在页面上下文中执行 JavaScript。
 *
 * @param {CdpClient} client CDP 客户端
 * @param {string} expression 表达式
 * @returns {Promise<unknown>} 表达式结果
 */
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    const exceptionDescription = result.exceptionDetails.exception
      && result.exceptionDetails.exception.description;
    throw new Error(exceptionDescription || result.exceptionDetails.text || '页面脚本执行失败');
  }

  return result.result ? result.result.value : undefined;
}

/**
 * 等待页面完成加载并留出异步渲染时间。
 *
 * @param {CdpClient} client CDP 客户端
 * @param {number} timeoutMs 超时时间
 * @returns {Promise<void>} 等待结果
 */
async function waitForPageReady(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await evaluate(client, 'document.readyState');
    if (state === 'complete') {
      await wait(3000);
      return;
    }
    await wait(250);
  }

  throw new Error('等待蓝湖页面加载超时');
}

/**
 * 获取当前页面的安全摘要。
 *
 * @param {CdpClient} client CDP 客户端
 * @returns {Promise<object>} 页面摘要
 */
async function inspectPage(client) {
  return evaluate(client, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const inputList = Array.from(document.querySelectorAll('input'))
      .filter(visible)
      .map((input) => ({
        type: input.type || '',
        name: input.name || '',
        id: input.id || '',
        placeholder: input.placeholder || '',
        className: input.className || '',
      }));
    const buttonList = Array.from(document.querySelectorAll('button, [role="button"], .login_sign'))
      .filter(visible)
      .map((button) => String(button.innerText || button.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 80);
    return {
      url: location.href,
      title: document.title,
      text: String(document.body ? document.body.innerText : '').slice(0, 12000),
      inputs: inputList,
      buttons: buttonList,
      hasLoginButton: Boolean(document.querySelector('.login_sign')),
    };
  })()`);
}

/**
 * 点击页面中的登录入口。
 *
 * @param {CdpClient} client CDP 客户端
 * @returns {Promise<boolean>} 是否点击
 */
async function clickLoginEntry(client) {
  return evaluate(client, `(() => {
    const candidates = [
      document.querySelector('.login_sign'),
      ...Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
        .filter((element) => String(element.innerText || '').trim() === '登录'),
    ].filter(Boolean);
    const target = candidates[0];
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

/**
 * 填写蓝湖登录首页的账号并进入密码步骤。
 *
 * @param {CdpClient} client CDP 客户端
 * @param {string} account 登录账号
 * @returns {Promise<object>} 账号步骤结果
 */
async function submitAccountStep(client, account) {
  const accountPayload = JSON.stringify(account);

  return evaluate(client, `(() => {
    const account = ${accountPayload};
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const setValue = (input, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      descriptor.set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    const accountInput = inputs.find((input) => [
      'text', 'tel', 'number', 'email', '',
    ].includes(input.type));

    if (!accountInput) {
      return { submitted: false, reason: '未找到账号输入框' };
    }

    setValue(accountInput, account);

    // 首次登录必须同意服务协议；只点击未选中的复选框。
    const agreement = document.querySelector('.agreement .checkBox, .checkBox');
    if (agreement) {
      const uncheckedIcon = Array.from(agreement.querySelectorAll('img')).find((image) => {
        return visible(image) && /uncheck/i.test(image.src || '');
      });
      if (uncheckedIcon) agreement.click();
    }

    const submitButton = document.querySelector('.loginButton, .registerButton');
    if (!submitButton || !visible(submitButton)) {
      return { submitted: false, reason: '未找到登录提交按钮' };
    }

    submitButton.click();
    return { submitted: true, reason: '' };
  })()`);
}

/**
 * 填写蓝湖密码并提交登录。
 *
 * @param {CdpClient} client CDP 客户端
 * @param {string} password 登录密码
 * @returns {Promise<object>} 密码步骤结果
 */
async function submitPasswordStep(client, password) {
  const passwordPayload = JSON.stringify(password);

  return evaluate(client, `(() => {
    const password = ${passwordPayload};
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const passwordInput = Array.from(document.querySelectorAll('input'))
      .find((input) => visible(input) && input.type === 'password');
    if (!passwordInput) {
      return { submitted: false, reason: '未找到密码输入框' };
    }

    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor.set.call(passwordInput, password);
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
    passwordInput.dispatchEvent(new Event('blur', { bubbles: true }));

    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
    const submitButton = candidates.find((element) => {
      if (!visible(element)) return false;
      const text = String(element.innerText || element.textContent || '').trim();
      return /^(登录|立即登录|账号登录)$/.test(text);
    });
    if (!submitButton) {
      return { submitted: false, reason: '未找到密码登录按钮' };
    }

    submitButton.click();
    return { submitted: true, reason: '' };
  })()`);
}

/**
 * 同意蓝湖登录页弹出的服务协议确认框。
 *
 * @param {CdpClient} client CDP 客户端
 * @returns {Promise<boolean>} 是否点击确认
 */
async function acceptAgreementDialog(client) {
  return evaluate(client, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
    const agreeButton = candidates.find((element) => {
      return visible(element) && String(element.innerText || element.textContent || '').trim() === '同意';
    });
    if (!agreeButton) return false;
    agreeButton.click();
    return true;
  })()`);
}

/**
 * 保存页面 DOM 和截图。
 *
 * @param {CdpClient} client CDP 客户端
 * @param {string} outputDir 输出目录
 * @param {{redactLoginInputs?: boolean}} options 保存选项
 * @returns {Promise<object>} 输出文件信息
 */
async function savePageArtifacts(client, outputDir, options = {}) {
  fs.mkdirSync(outputDir, { recursive: true });

  if (options.redactLoginInputs) {
    // 登录失败快照只用于维护页面选择器，必须先清除可见凭据。
    await evaluate(client, `(() => {
      Array.from(document.querySelectorAll('input')).forEach((input) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        descriptor.set.call(input, '***');
        input.setAttribute('value', '***');
      });
      return true;
    })()`);
  }

  const rawHtml = await evaluate(client, 'document.documentElement.outerHTML');
  const html = String(rawHtml || '')
    .replace(/1\d{10}/g, '***')
    .replace(/(value=")[^"]*(")/gi, '$1***$2');
  const layoutMetrics = await client.send('Page.getLayoutMetrics');
  const contentSize = layoutMetrics.cssContentSize || layoutMetrics.contentSize || {};
  const clip = {
    x: 0,
    y: 0,
    width: Math.max(DEFAULT_VIEWPORT_WIDTH, Math.min(Number(contentSize.width || 0), 10000)),
    height: Math.max(DEFAULT_VIEWPORT_HEIGHT, Math.min(Number(contentSize.height || 0), 20000)),
    scale: 1,
  };
  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip,
  });

  const htmlPath = path.join(outputDir, 'page.html');
  const screenshotPath = path.join(outputDir, 'page.png');
  fs.writeFileSync(htmlPath, String(html || ''), 'utf8');
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data || '', 'base64'));

  return {
    htmlPath,
    screenshotPath,
  };
}

/**
 * 执行蓝湖登录和原型抓取。
 *
 * @param {object} options 命令行参数
 * @returns {Promise<object>} 执行结果
 */
async function run(options) {
  if (!options.url) {
    throw new Error('缺少 --url');
  }
  if (!options.outputDir) {
    throw new Error('缺少 --output-dir');
  }
  if (!fs.existsSync(options.chrome)) {
    throw new Error(`未找到 Google Chrome：${options.chrome}`);
  }

  const credentials = readLanhuCredentials(options.keychainService);
  const browserProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-task-lanhu-'));
  const devtoolsPortFile = path.join(browserProfileDir, 'DevToolsActivePort');
  const chromeProcess = childProcess.spawn(options.chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${browserProfileDir}`,
    `--window-size=${DEFAULT_VIEWPORT_WIDTH},${DEFAULT_VIEWPORT_HEIGHT}`,
    'about:blank',
  ], {
    stdio: 'ignore',
  });

  let client;
  try {
    await waitForFile(devtoolsPortFile, options.timeoutMs);
    const [port] = fs.readFileSync(devtoolsPortFile, 'utf8').trim().split(/\r?\n/);
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    const pageTarget = targets.find((target) => target.type === 'page');
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error('Chrome 未返回可用的页面调试目标');
    }

    client = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');
    await client.send('Page.navigate', { url: options.url });
    await waitForPageReady(client, options.timeoutMs);

    let page = await inspectPage(client);
    let loginAttempted = false;
    let loginSubmitted = false;

    if (page.hasLoginButton || /请重新登录|登录后/.test(page.text)) {
      loginAttempted = true;
      const clicked = await clickLoginEntry(client);
      if (!clicked) {
        throw new Error('检测到未登录状态，但没有找到蓝湖登录入口');
      }

      await wait(5000);
      page = await inspectPage(client);
      let passwordInputVisible = page.inputs.some((input) => input.type === 'password');

      if (!passwordInputVisible) {
        const accountResult = await submitAccountStep(client, credentials.account);
        if (!accountResult.submitted) {
          await savePageArtifacts(client, options.outputDir, { redactLoginInputs: true });
          throw new Error(`蓝湖自动登录失败：${accountResult.reason}`);
        }

        // 未提前勾选协议时，蓝湖会在账号步骤弹出二次确认框。
        await wait(800);
        await acceptAgreementDialog(client);
        await wait(4000);
        page = await inspectPage(client);
        passwordInputVisible = page.inputs.some((input) => input.type === 'password');
      }

      if (!passwordInputVisible) {
        await savePageArtifacts(client, options.outputDir, { redactLoginInputs: true });
        throw new Error('蓝湖自动登录失败：账号步骤后未进入密码登录页面');
      }

      const passwordResult = await submitPasswordStep(client, credentials.password);
      loginSubmitted = Boolean(passwordResult.submitted);
      if (!loginSubmitted) {
        // 登录页结构变化时保留脱敏后的页面快照，便于维护选择器。
        await savePageArtifacts(client, options.outputDir, { redactLoginInputs: true });
        throw new Error(`蓝湖自动登录失败：${passwordResult.reason}`);
      }

      await wait(8000);
      await client.send('Page.navigate', { url: options.url });
      await waitForPageReady(client, options.timeoutMs);
      page = await inspectPage(client);
    }

    const files = await savePageArtifacts(client, options.outputDir);
    const requiresManualAuthorization = page.hasLoginButton
      || /验证码|扫码登录|需要验证|安全验证/.test(page.text);

    return {
      success: !requiresManualAuthorization,
      loginAttempted,
      loginSubmitted,
      requiresManualAuthorization,
      page: {
        url: page.url,
        title: page.title,
        text: page.text,
        inputs: page.inputs,
        buttons: page.buttons,
      },
      files,
    };
  } finally {
    if (client) {
      client.close();
    }
    chromeProcess.kill('SIGTERM');
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }

    const result = await run(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.success) {
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${redactSensitiveText(error.message)}\n`);
    process.exitCode = 1;
  }
}

main();

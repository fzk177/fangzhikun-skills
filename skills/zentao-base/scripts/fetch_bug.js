#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  cliJson, defaultOptions, getBugEnvelope, normalizeBugEnvelope, redactSensitiveText,
} = require('./zentao_client');
const { loadRuntimeConfig } = require('./runtime_config');

const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

function save(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
}

function safeName(value) {
  return String(value || 'attachment').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 160) || 'attachment';
}

// 附件不携带凭据，且每一次重定向都重新校验同源。
async function download(url, origin) {
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
      throw new Error('附件地址或重定向不属于当前禅道服务');
    }
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('附件重定向缺少地址');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`附件 HTTP ${response.status}`);
    }
    if (Number(response.headers.get('content-length')) > MAX_ATTACHMENT_BYTES) {
      await response.body?.cancel();
      throw new Error('附件超过 64 MiB 限制');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_ATTACHMENT_BYTES) throw new Error('附件超过 64 MiB 限制');
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') || '' };
  }
  throw new Error('附件重定向次数过多');
}

async function main() {
  const [id, output, ...extra] = process.argv.slice(2);
  if (!/^\d+$/.test(id || '') || /^0+$/.test(id) || extra.length) {
    throw new Error('用法: fetch_bug.js <非零纯数字BugID> [系统临时目录]');
  }
  // 写材料前验证调用方创建的临时目录，避免覆盖已有文件或进入业务仓库。
  let directory;
  if (output) {
    if (!fs.lstatSync(output).isDirectory() || fs.lstatSync(output).isSymbolicLink()) {
      throw new Error('输出目录必须是已经创建的普通系统临时目录');
    }
    directory = fs.realpathSync(output);
    const relative = path.relative(fs.realpathSync(os.tmpdir()), directory);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('输出目录必须位于系统临时目录内');
    }
    if (fs.readdirSync(directory).length) throw new Error('输出目录必须为空，不覆盖已有材料');
  }
  const options = defaultOptions();
  const body = getBugEnvelope(options, id);
  if (!directory) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }
  const { bug, actions } = normalizeBugEnvelope(body, id);
  fs.mkdirSync(path.join(directory, 'attachments'), { mode: 0o700 });
  const jsonPath = path.join(directory, `bug-${id}.json`);
  save(jsonPath, `${JSON.stringify(body, null, 2)}\n`);
  save(path.join(directory, `bug-${id}-summary.json`), `${JSON.stringify({
    bug, actionCount: actions.length,
    historyChangeCount: actions.reduce((count, action) => count + (Array.isArray(action.history) ? action.history.length : 0), 0),
    attachmentCount: Object.keys(bug.files || {}).length,
  }, null, 2)}\n`);
  save(path.join(directory, `bug-${id}-actions.jsonl`), actions.map(action => JSON.stringify({
    id: action.id, objectType: action.objectType, objectID: action.objectID,
    product: action.product, project: action.project, execution: action.execution,
    actor: action.actor, action: action.action, date: action.date, comment: action.comment,
    extra: action.extra, history: action.history || [],
  })).join('\n') + (actions.length ? '\n' : ''));

  const files = Object.entries(bug.files || {});
  const steps = String(bug.steps || '');
  const inlineIds = [...new Set([...steps.matchAll(/fileID=(\d+)/g)].map(match => match[1]))];
  if (files.length || inlineIds.length) {
    let server = loadRuntimeConfig().zentao?.server || '';
    try {
      const profile = (cliJson(options, ['profile']).profiles || []).find(item => item.current);
      server = profile?.server || server;
    } catch (_) {
      // 已取得 Bug，Profile 读取受限时保留材料并按实际配置尝试附件。
    }
    let base;
    try {
      base = new URL(server.endsWith('/') ? server : `${server}/`);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('invalid');
    } catch (_) {
      process.stderr.write('当前服务地址不可用，附件和内嵌图片地址未补齐\n');
      if (inlineIds.length) save(path.join(directory, 'inline-files.tsv'), inlineIds.map(fileId => `${fileId}\t`).join('\n') + '\n');
      process.stdout.write(`${jsonPath}\n`);
      return;
    }
    for (const [key, file] of files) {
      const fileId = String(file.id || key);
      if (!file.webPath) {
        process.stderr.write(`附件下载失败，fileID=${safeName(fileId)}，缺少 webPath\n`);
        continue;
      }
      try {
        const title = safeName(file.title || file.name);
        const extension = safeName(file.extension || '').replace(/^attachment$/, '');
        const name = `${safeName(fileId)}-${title}${extension && !title.endsWith(`.${extension}`) ? `.${extension}` : ''}`;
        const result = await download(new URL(file.webPath, base), base.origin);
        const looksHtml = /text\/html/i.test(result.contentType)
          || /^\s*(?:<!doctype html|<html\b)/i.test(result.bytes.subarray(0, 512).toString('utf8'));
        if (looksHtml && !/\.html?$/i.test(name)) throw new Error('返回 HTML，不能作为原附件保存');
        save(path.join(directory, 'attachments', name), result.bytes);
      } catch (error) {
        process.stderr.write(`附件下载失败，fileID=${safeName(fileId)}，${redactSensitiveText(error.message)}\n`);
      }
    }
    if (inlineIds.length) {
      // 优先保留正文中实际给出的链接，不猜测禅道安装子路径。
      const links = [...steps.matchAll(/(?:src|href)=["']([^"']*fileID=\d+[^"']*)["']/gi)].map(match => match[1].replace(/&amp;/g, '&'));
      const lines = inlineIds.map(fileId => {
        const link = links.find(value => new RegExp(`fileID=${fileId}(?:[^0-9]|$)`).test(value));
        if (!link) return `${fileId}\t`;
        try {
          const url = new URL(link, base);
          return `${fileId}\t${url.origin === base.origin && !url.username && !url.password ? url.href : ''}`;
        } catch (_) { return `${fileId}\t`; }
      });
      save(path.join(directory, 'inline-files.tsv'), `${lines.join('\n')}\n`);
    }
  }
  process.stdout.write(`${jsonPath}\n`);
}

main().catch(error => {
  process.stderr.write(`${redactSensitiveText(error.message)}\n`);
  process.exitCode = 1;
});

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 展开配置值开头的用户目录标记。
 *
 * @param {unknown} value 配置值
 * @returns {string} 展开后的路径或空字符串
 */
function expandHome(value) {
  const text = String(value || '');
  if (text === '~') {
    return os.homedir();
  }
  if (text.startsWith('~/')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

/**
 * 读取机器专属运行配置。
 *
 * 配置文件不得包含密码、Token 或 Cookie；敏感凭据继续由钥匙串托管。
 *
 * @returns {object} 运行配置
 */
function loadRuntimeConfig() {
  const defaultPath = path.join(os.homedir(), '.config', 'fangzhikun-skills', 'runtime.json');
  const configPath = expandHome(process.env.FANGZHIKUN_SKILLS_CONFIG || defaultPath);

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const zentao = config.zentao;
    if (!zentao || typeof zentao !== 'object' || Array.isArray(zentao)) {
      throw new Error('本机配置缺少合法的 zentao 节');
    }
    if (Object.keys(zentao).some(key => /password|passwd|token|cookie|secret|session|zentaosid/i.test(key))) {
      throw new Error('zentao 配置不能保存密码、Token、Cookie 或其他秘密字段');
    }
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('缺少本机 Skill 配置，请在本机恢复 runtime.json');
    }
    if (error instanceof SyntaxError) {
      // JSON 解析器可能在错误文本中夹带配置内容，禁止复制其原始报错。
      throw new Error('本机 Skill 配置不是合法 JSON，请在本机修复 runtime.json');
    }
    throw new Error(`无法读取本机 Skill 配置 ${configPath}：${error.message}`);
  }
}

module.exports = {
  expandHome,
  loadRuntimeConfig,
};

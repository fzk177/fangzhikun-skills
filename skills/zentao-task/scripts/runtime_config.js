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
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw new Error(`无法读取本机 Skill 配置 ${configPath}：${error.message}`);
  }
}

module.exports = {
  expandHome,
  loadRuntimeConfig,
};

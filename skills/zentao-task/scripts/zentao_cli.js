'use strict';

const fs = require('fs');
const path = require('path');

// 保留旧导入路径；禅道读取统一由 zentao-base 提供。
const client = require('../../zentao-base/scripts/zentao_client');
const { accountValue, numericValue, objectId } = client;

function normalizeDateTime(value, label) {
  const text = String(value || '').trim().replace('T', ' ').replace(/Z$/, '');
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ \t]+(\d{2}:\d{2})(?::(\d{2}))?)?$/);
  if (!match || !match[2]) {
    throw new Error(`${label} 必须使用 YYYY-MM-DD HH:mm:ss 格式`);
  }
  return `${match[1]} ${match[2]}:${match[3] || '00'}`;
}

function editableTaskSnapshot(task) {
  return {
    name: String(task.name || ''),
    type: String(task.type || ''),
    assignedTo: accountValue(task.assignedTo),
    estStarted: String(task.estStarted || '').slice(0, 10),
    deadline: String(task.deadline || '').slice(0, 10),
    pri: String(task.pri ?? ''),
    estimate: numericValue(task.estimate),
    module: objectId(task.module) || '0',
    story: objectId(task.story || task.storyID || task.storyId) || '0',
    desc: String(task.desc || task.description || ''),
  };
}

function readProjectsFolder(vault, explicitFolder) {
  if (explicitFolder) {
    return explicitFolder;
  }

  const dataFile = path.join(vault, '.obsidian', 'plugins', 'project-manager', 'data.json');
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return data.projectsFolder || '04.项目';
  } catch (error) {
    return '04.项目';
  }
}

module.exports = { ...client, normalizeDateTime, editableTaskSnapshot, readProjectsFolder };

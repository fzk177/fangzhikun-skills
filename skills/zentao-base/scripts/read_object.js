#!/usr/bin/env node
'use strict';

const { defaultOptions, getTask, getStory, getBug, redactSensitiveText } = require('./zentao_client');

try {
  const [type, id, ...extra] = process.argv.slice(2);
  const readers = { task: getTask, story: getStory, bug: getBug };
  if (extra.length || !Object.hasOwn(readers, type) || !/^\d+$/.test(id || '') || /^0+$/.test(id)) {
    throw new Error('用法: read_object.js <task|story|bug> <非零纯数字ID>');
  }
  const object = readers[type](defaultOptions(), id);
  if (!object) throw new Error(`未找到禅道 ${type} #${id}`);
  process.stdout.write(`${JSON.stringify({ type, object }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${redactSensitiveText(error.message)}\n`);
  process.exitCode = 1;
}

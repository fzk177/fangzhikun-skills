'use strict';

const { emit } = require('./common.js');

const idPattern = /^[1-9][0-9]*$/;

function requireId(value, label) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error(label + ' 必须是正整数 ID 字符串');
  return value;
}

function parseReadCommand(args) {
  const values = args[0] === '--json' ? args.slice(1) : args.slice();
  if (values[0] !== 'workflow' || !['operators', 'conditions-read'].includes(values[1])) return null;
  const [, operation, workflowId, ...rest] = values;
  if (workflowId === '--help' && !rest.length) return { operation, help: true };
  requireId(workflowId, 'workflowId');
  if (operation === 'operators') {
    if (rest.length > 1) throw new Error('用法：workflow operators <workflowId> [nodeId]');
    if (rest.length) requireId(rest[0], 'nodeId');
    return { operation, workflowId, nodeId: rest[0] };
  }
  if (rest.length && (rest.length !== 2 || rest[0] !== '--link-id')) throw new Error('用法：workflow conditions-read <workflowId> [--link-id <linkId>]');
  if (rest.length) requireId(rest[1], 'linkId');
  return { operation, workflowId, linkId: rest[1] };
}

function checked(response, label) {
  if (!response || response.code !== 200 || response.status === false || response.data == null) {
    throw new Error(label + ' 读取失败；不能据此判断对象不存在');
  }
  return response.data;
}

function rows(data, label) {
  const result = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(result)) throw new Error(label + ' 响应缺少数组；不能当作空结果');
  return result;
}

function object(data, label) {
  const result = data?.data ?? data;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(label + ' 响应结构不兼容');
  return result;
}

function query(baseUrl, path, parameters) {
  return baseUrl + path + '?' + new URLSearchParams(parameters).toString();
}

async function operators(command, client, baseUrl) {
  const { workflowId, nodeId } = command;
  const nodes = rows(checked(await client.get(query(baseUrl, '/api/bs/workflow/pathdef/nodeBase/getNodeEditTable', { workflowId })), '节点列表'), '节点列表');
  const selected = nodeId ? nodes.filter(node => String(node.id) === nodeId) : nodes;
  if (nodeId && !selected.length) throw new Error('指定 nodeId 不在该流程的可见节点列表中');
  const result = [];
  for (const node of selected) {
    const currentNodeId = requireId(String(node.id), 'nodeId');
    const settings = object(checked(await client.get(query(baseUrl, '/api/bs/workflow/pathdef/nodeBase/getNodeSetForm', { workflowId, nodeId: currentNodeId })), '节点设置'), '节点设置');
    if (!Array.isArray(settings.operator)) throw new Error('节点设置缺少 operator 数组；不能当作无人审批');
    const groups = [];
    for (const group of settings.operator) {
      const groupId = requireId(String(group.id), 'groupId');
      const data = checked(await client.get(query(baseUrl, '/api/bs/workflow/pathdef/nodeOperator/getOperatorGroupList', {
        paramGroupId: groupId, sourceType: '1', nodeId: currentNodeId, refWorkflowId: '',
      })), '操作者组明细');
      groups.push({ ...group, items: rows(data, '操作者组明细') });
    }
    result.push({ nodeId: currentNodeId, nodeName: node.nodeName, nodeType: node.nodeType, nodeSettings: settings, groups });
  }
  emit({ workflowId, queriedAt: new Date().toISOString(), nodes: result,
    evidenceScope: '当前模板配置；动态选人、代理、实际待办及历史审批需另外核实' });
}

async function conditions(command, client, baseUrl) {
  const { workflowId, linkId } = command;
  const links = rows(checked(await client.get(query(baseUrl, '/api/bs/workflow/pathdef/nodeLink/getWfpNodeLinkTable', { workflowId })), '出口列表'), '出口列表');
  if (linkId && !links.some(link => String(link.id) === linkId)) throw new Error('指定 linkId 不在该流程的可见出口列表中');
  const selected = links.filter(link => (!linkId || String(link.id) === linkId) && (link.hasCondition || link.conditionKey?.conditionKey));
  const result = [];
  for (const link of selected) {
    const sourceId = requireId(String(link.id), 'linkId');
    const boundKey = requireId(String(link.conditionKey?.conditionKey || ''), '已绑定 conditionKey');
    const conditionName = link.conditionKey?.sourceName || '';
    const linkName = link.linkName || '';
    // 只查询已有绑定；getConditionSet 按用户明确指示放行并记录观察结果。
    const context = checked(await client.post(baseUrl + '/api/workflow/pathdef/rule/condition/getConditionSet', {
      source: 2, sourceId, workflowId, conditionName, linkName, conditionKey: boundKey,
      needFormfield: true, readOnly: true, templateTokenId: String(Date.now()),
    }), '条件上下文');
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('条件上下文响应结构不兼容');
    if (String(context.conditionKey || '') !== boundKey) {
      throw new Error('条件上下文未回读到同一已有绑定；停止，不能按新条件继续');
    }
    let current = 1;
    const records = [];
    const seenPages = new Set();
    while (true) {
      const data = checked(await client.post(baseUrl + '/api/workflow/pathdef/rule/condition/getConditionList', {
        source: 2, sourceId, workflowId, conditionName, linkName,
        needFormfield: true, readOnly: true, addRight: false, hasQuote: true,
        exitConditionMapBrowserInfo: context.exitConditionMapBrowserInfo,
        relation: context.relation, haveData: context.haveData,
        mapBaseId: context.mapBaseId, conditionKey: context.conditionKey,
        viewRight: true, deleteRight: false, editRight: false,
        conditionMapBrowserBean: context.conditionMapBrowserBean,
        current, pageSize: 100,
      }), '条件列表');
      const page = rows(data, '条件列表');
      if (page.length) {
        const signature = JSON.stringify(page);
        if (seenPages.has(signature)) throw new Error('条件分页重复；无法确认查询完整性');
        seenPages.add(signature);
      }
      records.push(...page);
      const total = data?.total;
      if (typeof total === 'number' && records.length >= total) break;
      if (page.length < 100) {
        if (typeof total === 'number' && records.length < total) throw new Error('条件分页不完整');
        break;
      }
      if (++current > 100) throw new Error('条件分页超过读取上限；不能认定结果完整');
    }
    if (!records.length) throw new Error('出口存在条件绑定但返回空列表；不能判断该出口无条件');
    result.push({ linkId: sourceId, linkName, srcNodeId: link.srcNodeId, destNodeId: link.destNodeId, context, records });
  }
  emit({ workflowId, queriedAt: new Date().toISOString(), links: result });
}

async function runWorkflowRead(command, client, baseUrl) {
  if (command.help) {
    emit({ usage: command.operation === 'operators' ? 'workflow operators <workflowId> [nodeId]' : 'workflow conditions-read <workflowId> [--link-id <linkId>]',
      note: '复用认证及请求守卫；条件上下文 getConditionSet 按用户明确指示放行并记录观察结果' });
    return;
  }
  return command.operation === 'operators' ? operators(command, client, baseUrl) : conditions(command, client, baseUrl);
}

module.exports = { parseReadCommand, runWorkflowRead };

"use strict";

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const NODE_KINDS = new Set([
  "client",
  "frontend",
  "gateway",
  "service",
  "worker",
  "database",
  "cache",
  "message-bus",
  "security",
  "external-system",
  "infrastructure",
]);
const EDGE_KINDS = new Set([
  "request",
  "read",
  "write",
  "query",
  "publish",
  "consume",
  "authenticate",
  "dependency",
  "transfer",
]);
const TRUTH_VALUES = new Set(["verified", "derived", "declared", "unknown"]);
const GROUP_KINDS = new Set(["system", "trust", "deployment", "ownership"]);
const EDGE_MODES = new Set(["synchronous", "asynchronous", "batch"]);
const SCOPES = new Set(["runtime", "module", "business-flow", "deployment"]);
const DIRECTIONS = new Set(["left-to-right", "top-to-bottom"]);

const NODE_WIDTH = 240;
const NODE_HEIGHT = 112;
const COLUMN_GAP = 120;
const ROW_GAP = 64;
const ORIGIN_X = 120;
const ORIGIN_Y = 180;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pushError(errors, path, message) {
  errors.push({ path, message });
}

function pushWarning(warnings, path, message) {
  warnings.push({ path, message });
}

function checkKeys(value, allowed, path, errors) {
  if (!isObject(value)) {
    pushError(errors, path, "必须是对象");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) pushError(errors, `${path}.${key}`, "字段未在契约中定义");
  }
  return true;
}

function checkText(value, path, errors, options = {}) {
  const { required = false, max = 240 } = options;
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim() === "") {
    pushError(errors, path, "必须是非空字符串");
    return;
  }
  if (value.length > max) pushError(errors, path, `长度不能超过 ${max}`);
}

function checkId(value, path, errors) {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || value.length > 64) {
    pushError(errors, path, "必须是以小写字母开头、只含小写字母/数字/连字符的稳定 ID");
  }
}

function checkEvidenceList(value, path, truth, errors, warnings) {
  if (value === undefined) {
    if (truth === "verified") pushError(errors, path, "verified 事实必须包含直接证据");
    if (truth === "derived") pushWarning(warnings, path, "derived 事实建议记录推导依据");
    return;
  }
  if (!Array.isArray(value)) {
    pushError(errors, path, "必须是数组");
    return;
  }
  if (value.length > 5) pushError(errors, path, "每个事实最多保留 5 条关键证据");
  if (truth === "verified" && value.length === 0) {
    pushError(errors, path, "verified 事实必须包含直接证据");
  }
  value.forEach((evidence, index) => {
    const itemPath = `${path}[${index}]`;
    if (!checkKeys(evidence, new Set(["path", "line", "endLine", "symbol", "note"]), itemPath, errors)) return;
    checkText(evidence.path, `${itemPath}.path`, errors, { required: true, max: 240 });
    if (typeof evidence.path === "string") {
      const segments = evidence.path.split(/[\\/]/);
      if (evidence.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(evidence.path) || segments.includes("..")) {
        pushError(errors, `${itemPath}.path`, "必须是仓库内相对路径，不能包含 ..");
      }
    }
    if (!Number.isInteger(evidence.line) || evidence.line < 1) {
      pushError(errors, `${itemPath}.line`, "必须是大于 0 的整数");
    }
    if (evidence.endLine !== undefined) {
      if (!Number.isInteger(evidence.endLine) || evidence.endLine < evidence.line) {
        pushError(errors, `${itemPath}.endLine`, "必须是不小于 line 的整数");
      }
    }
    checkText(evidence.symbol, `${itemPath}.symbol`, errors, { max: 120 });
    checkText(evidence.note, `${itemPath}.note`, errors, { max: 200 });
  });
}

function validateDocument(document) {
  const errors = [];
  const warnings = [];
  if (!checkKeys(
    document,
    new Set(["schemaVersion", "diagramType", "meta", "layoutHints", "nodes", "edges", "groups", "unknowns"]),
    "$",
    errors,
  )) {
    return { ok: false, errors, warnings, stats: {} };
  }

  if (document.schemaVersion !== 1) pushError(errors, "$.schemaVersion", "当前只支持 1");
  if (document.diagramType !== "architecture") pushError(errors, "$.diagramType", "当前只支持 architecture");

  if (checkKeys(document.meta, new Set(["title", "language", "scope", "source", "notes"]), "$.meta", errors)) {
    checkText(document.meta.title, "$.meta.title", errors, { required: true, max: 120 });
    if (document.meta.language !== "zh-CN") pushError(errors, "$.meta.language", "当前固定为 zh-CN");
    if (!SCOPES.has(document.meta.scope)) pushError(errors, "$.meta.scope", "不支持的架构范围");
    if (document.meta.source !== undefined && checkKeys(
      document.meta.source,
      new Set(["type", "repository", "revision", "dirty"]),
      "$.meta.source",
      errors,
    )) {
      if (!new Set(["repository", "description", "mixed"]).has(document.meta.source.type)) {
        pushError(errors, "$.meta.source.type", "必须是 repository、description 或 mixed");
      }
      checkText(document.meta.source.repository, "$.meta.source.repository", errors, { max: 120 });
      if (document.meta.source.revision !== undefined && !/^[a-fA-F0-9]{40}$/.test(document.meta.source.revision)) {
        pushError(errors, "$.meta.source.revision", "必须是 40 位 Git revision");
      }
      if (document.meta.source.dirty !== undefined && typeof document.meta.source.dirty !== "boolean") {
        pushError(errors, "$.meta.source.dirty", "必须是布尔值");
      }
    }
    if (document.meta.notes !== undefined) {
      if (!Array.isArray(document.meta.notes)) {
        pushError(errors, "$.meta.notes", "必须是数组");
      } else {
        document.meta.notes.forEach((note, index) => checkText(note, `$.meta.notes[${index}]`, errors, { required: true }));
      }
    }
  }

  const nodeIds = new Set();
  const edgeIds = new Set();
  const groupIds = new Set();
  const nodeTruth = { verified: 0, derived: 0, declared: 0, unknown: 0 };
  const edgeTruth = { verified: 0, derived: 0, declared: 0, unknown: 0 };

  if (!Array.isArray(document.nodes) || document.nodes.length === 0) {
    pushError(errors, "$.nodes", "至少需要一个架构节点");
  } else {
    if (document.nodes.length > 24) pushError(errors, "$.nodes", "节点超过 24 个，请拆分架构视图");
    if (document.nodes.length > 12) pushWarning(warnings, "$.nodes", "节点超过默认的 12 个，请确认仍保持高层可读性");
    document.nodes.forEach((node, index) => {
      const path = `$.nodes[${index}]`;
      if (!checkKeys(node, new Set(["id", "kind", "label", "technology", "summary", "truth", "evidence", "layout"]), path, errors)) return;
      checkId(node.id, `${path}.id`, errors);
      if (nodeIds.has(node.id)) pushError(errors, `${path}.id`, "节点 ID 重复");
      nodeIds.add(node.id);
      if (!NODE_KINDS.has(node.kind)) pushError(errors, `${path}.kind`, "不支持的节点类型");
      checkText(node.label, `${path}.label`, errors, { required: true, max: 80 });
      checkText(node.technology, `${path}.technology`, errors, { max: 80 });
      checkText(node.summary, `${path}.summary`, errors, { max: 180 });
      if (!TRUTH_VALUES.has(node.truth)) {
        pushError(errors, `${path}.truth`, "不支持的事实等级");
      } else {
        nodeTruth[node.truth] += 1;
      }
      checkEvidenceList(node.evidence, `${path}.evidence`, node.truth, errors, warnings);
      if (node.layout !== undefined && checkKeys(node.layout, new Set(["rank", "lane", "order"]), `${path}.layout`, errors)) {
        if (node.layout.rank !== undefined && (!Number.isInteger(node.layout.rank) || node.layout.rank < 0 || node.layout.rank > 20)) {
          pushError(errors, `${path}.layout.rank`, "必须是 0 到 20 的整数");
        }
        if (node.layout.lane !== undefined) checkId(node.layout.lane, `${path}.layout.lane`, errors);
        if (node.layout.order !== undefined && (!Number.isInteger(node.layout.order) || node.layout.order < 0 || node.layout.order > 100)) {
          pushError(errors, `${path}.layout.order`, "必须是 0 到 100 的整数");
        }
      }
    });
  }

  const edges = document.edges === undefined ? [] : document.edges;
  if (!Array.isArray(edges)) {
    pushError(errors, "$.edges", "必须是数组");
  } else {
    edges.forEach((edge, index) => {
      const path = `$.edges[${index}]`;
      if (!checkKeys(edge, new Set(["id", "from", "to", "kind", "label", "mode", "truth", "evidence"]), path, errors)) return;
      checkId(edge.id, `${path}.id`, errors);
      if (edgeIds.has(edge.id)) pushError(errors, `${path}.id`, "关系 ID 重复");
      edgeIds.add(edge.id);
      checkId(edge.from, `${path}.from`, errors);
      checkId(edge.to, `${path}.to`, errors);
      if (!nodeIds.has(edge.from)) pushError(errors, `${path}.from`, "引用了不存在的节点");
      if (!nodeIds.has(edge.to)) pushError(errors, `${path}.to`, "引用了不存在的节点");
      if (edge.from === edge.to) pushError(errors, path, "关系起点和终点不能相同");
      if (!EDGE_KINDS.has(edge.kind)) pushError(errors, `${path}.kind`, "不支持的关系类型");
      checkText(edge.label, `${path}.label`, errors, { max: 120 });
      if (edge.mode !== undefined && !EDGE_MODES.has(edge.mode)) pushError(errors, `${path}.mode`, "不支持的交互模式");
      if (!TRUTH_VALUES.has(edge.truth)) {
        pushError(errors, `${path}.truth`, "不支持的事实等级");
      } else {
        edgeTruth[edge.truth] += 1;
      }
      checkEvidenceList(edge.evidence, `${path}.evidence`, edge.truth, errors, warnings);
    });
  }

  const groups = document.groups === undefined ? [] : document.groups;
  if (!Array.isArray(groups)) {
    pushError(errors, "$.groups", "必须是数组");
  } else {
    groups.forEach((group, index) => {
      const path = `$.groups[${index}]`;
      if (!checkKeys(group, new Set(["id", "kind", "label", "members", "truth", "evidence"]), path, errors)) return;
      checkId(group.id, `${path}.id`, errors);
      if (groupIds.has(group.id)) pushError(errors, `${path}.id`, "分组 ID 重复");
      groupIds.add(group.id);
      if (!GROUP_KINDS.has(group.kind)) pushError(errors, `${path}.kind`, "不支持的分组类型");
      checkText(group.label, `${path}.label`, errors, { required: true, max: 80 });
      if (!Array.isArray(group.members) || group.members.length === 0) {
        pushError(errors, `${path}.members`, "至少包含一个节点");
      } else {
        const seenMembers = new Set();
        group.members.forEach((member, memberIndex) => {
          checkId(member, `${path}.members[${memberIndex}]`, errors);
          if (!nodeIds.has(member)) pushError(errors, `${path}.members[${memberIndex}]`, "引用了不存在的节点");
          if (seenMembers.has(member)) pushError(errors, `${path}.members[${memberIndex}]`, "分组成员重复");
          seenMembers.add(member);
        });
      }
      if (!TRUTH_VALUES.has(group.truth)) pushError(errors, `${path}.truth`, "不支持的事实等级");
      checkEvidenceList(group.evidence, `${path}.evidence`, group.truth, errors, warnings);
    });
  }

  let primaryPath = [];
  if (document.layoutHints !== undefined && checkKeys(document.layoutHints, new Set(["direction", "primaryPath"]), "$.layoutHints", errors)) {
    if (document.layoutHints.direction !== undefined && !DIRECTIONS.has(document.layoutHints.direction)) {
      pushError(errors, "$.layoutHints.direction", "不支持的布局方向");
    }
    if (document.layoutHints.primaryPath !== undefined) {
      if (!Array.isArray(document.layoutHints.primaryPath)) {
        pushError(errors, "$.layoutHints.primaryPath", "必须是数组");
      } else {
        primaryPath = document.layoutHints.primaryPath;
        const seen = new Set();
        primaryPath.forEach((id, index) => {
          checkId(id, `$.layoutHints.primaryPath[${index}]`, errors);
          if (!nodeIds.has(id)) pushError(errors, `$.layoutHints.primaryPath[${index}]`, "引用了不存在的节点");
          if (seen.has(id)) pushError(errors, `$.layoutHints.primaryPath[${index}]`, "主要路径节点重复");
          seen.add(id);
        });
        for (let index = 1; index < primaryPath.length; index += 1) {
          const from = primaryPath[index - 1];
          const to = primaryPath[index];
          if (!edges.some((edge) => edge.from === from && edge.to === to)) {
            pushWarning(warnings, `$.layoutHints.primaryPath[${index}]`, `主要路径缺少 ${from} -> ${to} 的有向关系`);
          }
        }
      }
    }
  }

  const unknowns = document.unknowns === undefined ? [] : document.unknowns;
  if (!Array.isArray(unknowns)) {
    pushError(errors, "$.unknowns", "必须是数组");
  } else {
    const unknownIds = new Set();
    unknowns.forEach((unknown, index) => {
      const path = `$.unknowns[${index}]`;
      if (!checkKeys(unknown, new Set(["id", "question", "subject"]), path, errors)) return;
      checkId(unknown.id, `${path}.id`, errors);
      if (unknownIds.has(unknown.id)) pushError(errors, `${path}.id`, "待确认项 ID 重复");
      unknownIds.add(unknown.id);
      checkText(unknown.question, `${path}.question`, errors, { required: true, max: 240 });
      if (unknown.subject !== undefined && !nodeIds.has(unknown.subject) && !edgeIds.has(unknown.subject) && !groupIds.has(unknown.subject)) {
        pushError(errors, `${path}.subject`, "引用了不存在的节点、关系或分组");
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      nodes: Array.isArray(document.nodes) ? document.nodes.length : 0,
      edges: Array.isArray(edges) ? edges.length : 0,
      groups: Array.isArray(groups) ? groups.length : 0,
      unknowns: Array.isArray(unknowns) ? unknowns.length : 0,
      nodeTruth,
      edgeTruth,
    },
  };
}

function defaultLane(node) {
  const lanes = {
    client: "client",
    frontend: "experience",
    gateway: "edge",
    security: "security",
    service: "application",
    worker: "application",
    cache: "data",
    database: "data",
    "message-bus": "async",
    "external-system": "external",
    infrastructure: "infrastructure",
  };
  return lanes[node.kind] || "application";
}

function computeRanks(document) {
  const ranks = new Map();
  const locked = new Set();
  const primaryPath = document.layoutHints?.primaryPath || [];
  primaryPath.forEach((id, index) => {
    ranks.set(id, index);
    locked.add(id);
  });
  document.nodes.forEach((node) => {
    if (Number.isInteger(node.layout?.rank)) {
      ranks.set(node.id, node.layout.rank);
      locked.add(node.id);
    }
  });
  document.nodes.forEach((node) => {
    if (!ranks.has(node.id) && ["client", "external-system"].includes(node.kind)) ranks.set(node.id, 0);
  });
  for (let pass = 0; pass < document.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of document.edges || []) {
      if (!ranks.has(edge.from)) continue;
      const candidate = ranks.get(edge.from) + 1;
      if (!locked.has(edge.to) && (!ranks.has(edge.to) || ranks.get(edge.to) < candidate)) {
        ranks.set(edge.to, Math.min(candidate, document.nodes.length));
        changed = true;
      }
    }
    if (!changed) break;
  }
  document.nodes.forEach((node) => {
    if (!ranks.has(node.id)) ranks.set(node.id, 0);
  });
  return ranks;
}

function computeLayout(document, existingPositions = new Map(), reflow = false) {
  const ranks = computeRanks(document);
  const lanes = [];
  const laneNodes = new Map();
  const preferred = ["client", "experience", "edge", "security", "application", "async", "data", "external", "infrastructure"];
  const nodeLanes = new Map();
  for (const node of document.nodes) {
    const lane = node.layout?.lane || defaultLane(node);
    nodeLanes.set(node.id, lane);
    if (!laneNodes.has(lane)) laneNodes.set(lane, []);
    laneNodes.get(lane).push(node);
  }
  for (const lane of preferred) if (laneNodes.has(lane)) lanes.push(lane);
  for (const lane of [...laneNodes.keys()].sort()) if (!lanes.includes(lane)) lanes.push(lane);

  const laneBase = new Map();
  let nextY = ORIGIN_Y;
  for (const lane of lanes) {
    const byRank = new Map();
    for (const node of laneNodes.get(lane)) {
      const rank = ranks.get(node.id);
      byRank.set(rank, (byRank.get(rank) || 0) + 1);
    }
    const maxPerRank = Math.max(1, ...byRank.values());
    laneBase.set(lane, nextY);
    nextY += maxPerRank * (NODE_HEIGHT + ROW_GAP) + 72;
  }

  const positions = new Map();
  const counters = new Map();
  const sortedNodes = [...document.nodes].sort((a, b) => {
    const rankDiff = ranks.get(a.id) - ranks.get(b.id);
    if (rankDiff !== 0) return rankDiff;
    const laneDiff = lanes.indexOf(nodeLanes.get(a.id)) - lanes.indexOf(nodeLanes.get(b.id));
    if (laneDiff !== 0) return laneDiff;
    const orderDiff = (a.layout?.order ?? 1000) - (b.layout?.order ?? 1000);
    return orderDiff !== 0 ? orderDiff : a.id.localeCompare(b.id);
  });

  const direction = document.layoutHints?.direction || "left-to-right";
  for (const node of sortedNodes) {
    if (!reflow && existingPositions.has(node.id)) {
      positions.set(node.id, existingPositions.get(node.id));
      continue;
    }
    const rank = ranks.get(node.id);
    const lane = nodeLanes.get(node.id);
    const counterKey = `${rank}:${lane}`;
    const offset = counters.get(counterKey) || 0;
    counters.set(counterKey, offset + 1);
    const logicalX = ORIGIN_X + rank * (NODE_WIDTH + COLUMN_GAP);
    const logicalY = laneBase.get(lane) + offset * (NODE_HEIGHT + ROW_GAP);
    positions.set(node.id, direction === "top-to-bottom"
      ? { x: logicalY, y: logicalX, width: NODE_WIDTH, height: NODE_HEIGHT }
      : { x: logicalX, y: logicalY, width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  return positions;
}

function nodeText(node) {
  const lines = [node.label];
  if (node.technology) lines.push(node.technology);
  if (node.summary) lines.push(node.summary);
  const evidenceCount = Array.isArray(node.evidence) ? node.evidence.length : 0;
  const truthLabels = { verified: "已验证", derived: "已推导", declared: "已说明", unknown: "待确认" };
  lines.push(`${truthLabels[node.truth] || node.truth}${evidenceCount ? ` · SRC ${evidenceCount}` : ""}`);
  return lines.join("\n");
}

function styleForNode(kind) {
  const styles = {
    client: ["#1e1e1e", "#f1f3f5"],
    frontend: ["#1971c2", "#d0ebff"],
    gateway: ["#5f3dc4", "#e5dbff"],
    service: ["#087f5b", "#d3f9d8"],
    worker: ["#087f5b", "#b2f2bb"],
    database: ["#9c36b5", "#f3d9fa"],
    cache: ["#e67700", "#ffec99"],
    "message-bus": ["#0b7285", "#c5f6fa"],
    security: ["#c92a2a", "#ffe3e3"],
    "external-system": ["#495057", "#e9ecef"],
    infrastructure: ["#364fc7", "#dbe4ff"],
  };
  return styles[kind] || styles.service;
}

function applyElementTag(id, sourcePath, role, entityId) {
  if (!id || !ea.elementsDict[id]) return;
  ea.elementsDict[id].customData = {
    ...(ea.elementsDict[id].customData || {}),
    systemMap: { sourcePath, role, entityId },
  };
}

function connectionSides(fromBox, toBox) {
  const dx = toBox.x - fromBox.x;
  const dy = toBox.y - fromBox.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function buildExcalidrawElements(document, sourcePath, positions) {
  const boxIds = new Map();
  ea.style.roughness = 1;
  ea.style.strokeWidth = 2;
  ea.style.fontFamily = 1;

  ea.style.strokeColor = "#1e1e1e";
  ea.style.fontSize = 28;
  const titleId = ea.addText(ORIGIN_X, 56, document.meta.title);
  applyElementTag(titleId, sourcePath, "title", "title");

  for (const group of document.groups || []) {
    const boxes = group.members.map((id) => positions.get(id)).filter(Boolean);
    if (boxes.length === 0) continue;
    const minX = Math.min(...boxes.map((box) => box.x)) - 44;
    const minY = Math.min(...boxes.map((box) => box.y)) - 54;
    const maxX = Math.max(...boxes.map((box) => box.x + box.width)) + 44;
    const maxY = Math.max(...boxes.map((box) => box.y + box.height)) + 44;
    ea.style.strokeColor = group.kind === "trust" ? "#c92a2a" : "#868e96";
    ea.style.backgroundColor = "transparent";
    ea.style.strokeStyle = "dashed";
    const groupBoxId = ea.addRect(minX, minY, maxX - minX, maxY - minY);
    applyElementTag(groupBoxId, sourcePath, "group-box", group.id);
    ea.style.strokeStyle = "solid";
    ea.style.fontSize = 16;
    const groupTextId = ea.addText(minX + 14, minY + 10, group.label);
    applyElementTag(groupTextId, sourcePath, "group-label", group.id);
  }

  for (const node of document.nodes) {
    const box = positions.get(node.id);
    const [stroke, background] = styleForNode(node.kind);
    ea.style.strokeColor = stroke;
    ea.style.backgroundColor = background;
    ea.style.fillStyle = "solid";
    ea.style.strokeStyle = node.truth === "unknown" ? "dashed" : "solid";
    const boxId = ea.addRect(box.x, box.y, box.width, box.height);
    applyElementTag(boxId, sourcePath, "node-box", node.id);
    ea.style.strokeStyle = "solid";
    ea.style.fontSize = 17;
    ea.style.textAlign = "center";
    ea.style.verticalAlign = "middle";
    const textId = ea.addText(box.x + 12, box.y + 10, nodeText(node), {
      width: box.width - 24,
      height: box.height - 20,
      textAlign: "center",
      verticalAlign: "middle",
    });
    applyElementTag(textId, sourcePath, "node-text", node.id);
    ea.addToGroup([boxId, textId]);
    boxIds.set(node.id, boxId);
  }

  for (const edge of document.edges || []) {
    const fromBox = positions.get(edge.from);
    const toBox = positions.get(edge.to);
    if (!fromBox || !toBox) continue;
    const [fromSide, toSide] = connectionSides(fromBox, toBox);
    ea.style.strokeColor = edge.truth === "unknown" ? "#868e96" : "#343a40";
    ea.style.strokeStyle = edge.mode === "asynchronous" ? "dashed" : "solid";
    ea.style.startArrowHead = null;
    ea.style.endArrowHead = "arrow";
    const before = new Set(Object.keys(ea.elementsDict));
    ea.connectObjects(boxIds.get(edge.from), fromSide, boxIds.get(edge.to), toSide, {
      numberOfPoints: 2,
      startArrowHead: null,
      endArrowHead: "arrow",
      padding: 8,
    });
    const arrowId = Object.keys(ea.elementsDict).find((id) => !before.has(id));
    applyElementTag(arrowId, sourcePath, "edge", edge.id);
    if (edge.label) {
      ea.style.strokeColor = "#343a40";
      ea.style.fontSize = 14;
      const labelX = (fromBox.x + fromBox.width / 2 + toBox.x + toBox.width / 2) / 2 - 70;
      const labelY = (fromBox.y + fromBox.height / 2 + toBox.y + toBox.height / 2) / 2 - 18;
      const labelId = ea.addText(labelX, labelY, edge.label, { width: 140, textAlign: "center" });
      applyElementTag(labelId, sourcePath, "edge-label", edge.id);
    }
  }

  if ((document.unknowns || []).length > 0) {
    const maxY = Math.max(...[...positions.values()].map((box) => box.y + box.height));
    ea.style.strokeColor = "#e67700";
    ea.style.backgroundColor = "#fff3bf";
    ea.style.fillStyle = "solid";
    const questions = document.unknowns.map((item, index) => `${index + 1}. ${item.question}`).join("\n");
    const noteId = ea.addText(ORIGIN_X, maxY + 100, `待确认\n${questions}`, {
      width: 520,
      textAlign: "left",
      box: true,
      boxPadding: 16,
    });
    applyElementTag(noteId, sourcePath, "unknowns", "unknowns");
  }
}

async function runObsidian() {
  if (!ea.verifyMinimumPluginVersion || !ea.verifyMinimumPluginVersion("1.5.21")) {
    new Notice("system-map 需要 Excalidraw 插件 1.5.21 或更高版本。", 8000);
    return;
  }
  const files = app.vault.getFiles().filter((file) => file.path.endsWith(".system-map.json"));
  if (files.length === 0) {
    new Notice("当前 Vault 中没有 *.system-map.json 文件。", 8000);
    return;
  }
  const selected = await utils.suggester(files.map((file) => file.path), files, "选择架构 JSON");
  if (!selected) return;

  let document;
  try {
    document = JSON.parse(await app.vault.read(selected));
  } catch (error) {
    new Notice(`无法读取架构 JSON：${error.message}`, 10000);
    return;
  }
  const receipt = validateDocument(document);
  if (!receipt.ok) {
    console.error("system-map 校验失败", receipt);
    new Notice(`架构 JSON 校验失败：${receipt.errors[0].path} ${receipt.errors[0].message}`, 12000);
    return;
  }

  const hasActiveDrawing = Boolean(ea.getExcalidrawAPI && ea.getExcalidrawAPI());
  const labels = hasActiveDrawing
    ? ["新建 Excalidraw 图", "同步当前图并保留节点位置", "重新布局当前图"]
    : ["新建 Excalidraw 图"];
  const values = hasActiveDrawing ? ["new", "sync", "reflow"] : ["new"];
  const mode = await utils.suggester(labels, values, "选择绘制方式");
  if (!mode) return;

  const existingPositions = new Map();
  let managedElements = [];
  if (mode !== "new") {
    const viewElements = ea.getViewElements();
    managedElements = viewElements.filter((element) => element.customData?.systemMap?.sourcePath === selected.path);
    for (const element of managedElements) {
      const marker = element.customData.systemMap;
      if (marker.role === "node-box") {
        existingPositions.set(marker.entityId, {
          x: element.x,
          y: element.y,
          width: element.width || NODE_WIDTH,
          height: element.height || NODE_HEIGHT,
        });
      }
    }
  }

  ea.reset();
  const positions = computeLayout(document, existingPositions, mode === "reflow");
  try {
    buildExcalidrawElements(document, selected.path, positions);
  } catch (error) {
    ea.reset();
    console.error("system-map 绘制失败", error);
    new Notice(`生成 Excalidraw 元素失败：${error.message}`, 12000);
    return;
  }

  if (mode === "new") {
    const baseName = selected.basename.replace(/\.system-map$/, "");
    const folder = selected.parent?.path === "/" ? "" : (selected.parent?.path || "");
    await ea.create({ filename: `${baseName}-架构图`, foldername: folder, onNewPane: true });
  } else {
    if (managedElements.length > 0) await ea.deleteViewElements(managedElements);
    await ea.addElementsToView(false, false);
  }

  if (receipt.warnings.length > 0) {
    new Notice(`架构图已生成，存在 ${receipt.warnings.length} 条建模警告，请查看控制台。`, 8000);
    console.warn("system-map 建模警告", receipt.warnings);
  } else {
    new Notice("架构图已生成。", 5000);
  }
}

function createSkeleton(title) {
  return {
    schemaVersion: 1,
    diagramType: "architecture",
    meta: {
      title,
      language: "zh-CN",
      scope: "runtime",
      source: { type: "repository", dirty: false },
      notes: [],
    },
    layoutHints: {
      direction: "left-to-right",
      primaryPath: [],
    },
    nodes: [],
    edges: [],
    groups: [],
    unknowns: [],
  };
}

function cliUsage() {
  return [
    "用法：",
    "  node system_map.js init <输出>.system-map.json [标题]",
    "  node system_map.js validate <输入>.system-map.json [--json]",
    "",
    "同一脚本复制到 Obsidian Excalidraw Scripts 目录后，可在命令面板中绘制。",
  ].join("\n");
}

function runCli(argv) {
  const fs = require("node:fs");
  const path = require("node:path");
  const [command, inputPath, ...rest] = argv;
  if (command === "init") {
    if (!inputPath) throw new Error(cliUsage());
    if (!inputPath.endsWith(".system-map.json")) throw new Error("输出文件名必须以 .system-map.json 结尾");
    if (fs.existsSync(inputPath)) throw new Error(`拒绝覆盖已有文件：${inputPath}`);
    const title = rest.filter((item) => item !== "--json").join(" ") || "系统架构";
    fs.mkdirSync(path.dirname(path.resolve(inputPath)), { recursive: true });
    fs.writeFileSync(inputPath, `${JSON.stringify(createSkeleton(title), null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, command: "init", output: path.resolve(inputPath) })}\n`);
    return;
  }
  if (command === "validate") {
    if (!inputPath) throw new Error(cliUsage());
    const document = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const receipt = validateDocument(document);
    process.stdout.write(`${JSON.stringify(receipt, null, rest.includes("--json") ? 2 : 0)}\n`);
    if (!receipt.ok) process.exitCode = 1;
    return;
  }
  throw new Error(cliUsage());
}

if (typeof module !== "undefined") {
  module.exports = { createSkeleton, validateDocument, computeLayout };
}

if (typeof ea !== "undefined" && typeof app !== "undefined" && typeof utils !== "undefined") {
  void runObsidian();
} else if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

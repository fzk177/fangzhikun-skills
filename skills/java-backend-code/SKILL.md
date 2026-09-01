---
name: java-backend-code
description: 显式调用 $java-backend-code，或由已声明依赖它的开发型 Skill 进入 Java 后端代码修改阶段时，按照个人 Java 编码、分层和最小改动规范实施修改。覆盖类注释、中文注释、Controller Req/Resp、枚举和方法拆分；不用于前端开发、问题排查或数据库操作。
version: 1.0.0
---

# Java 后端编码

## 启用条件

- 仅在用户显式调用 `$java-backend-code`、明确要求使用本 Skill，或 `$req-governance`、`$zentao-task`、`$vesselhub-problem-analyze`、`$zentao-debug` 已进入用户授权的 Java 后端代码修改阶段时启用。
- 分析、定位、排查、评估或代码阅读不授权修改代码，也不自动启用本 Skill。
- 同时遵守适用的 `AGENTS.md` 和上游 Skill。上游 Skill 的修改范围、确认门禁和禁止事项更严格时，以更严格的规则为准。

## 类与注释

- 创建新的 class 文件时，类文档注释必须包含 `@author fangzhikun` 和执行当天的 `@since yyyy-MM-dd`。
- 优先使用必要且准确的中文注释；涉及稍复杂的逻辑时，必须先用中文注释说明处理思路。
- 不同的大逻辑之间适当保留空行，避免把相互独立的处理挤在一起。
- 注释中不得添加 HTML 标签，也不得残留 `</p >` 一类无效字符。

## Java 写法

- 不使用 `var`，应显式声明对象和变量类型。
- 可以通过 import 引入类或 package 时，不使用全路径类名创建对象或调用类型。
- 不新增未经定义的魔法值。优先复用系统已有常量或枚举。
- 是否开票、开票类型等标记字段没有合适的现有定义时，使用语义明确的枚举处理。
- 没有复用场景时不新建 private 方法；确需新增 private 方法时，在方法头添加中文注释说明用途。

## 分层约束

- Controller 对外接口的入参必须使用 Req 对象。
- Controller 返回前端的业务模型必须使用 Resp 对象，禁止直接返回 DTO。
- Controller 只负责参数接收、校验、转换和调用，业务逻辑应放在 Service 或对应业务层中。

## 完成检查

- 结合本次差异进行静态复核，确认修改范围、上下游映射、枚举取值和接口模型保持一致。
- 不调整本次任务无关的格式、排版、注释或 import，不覆盖用户已有和人工维护的内容。
- 测试、构建和 Git 操作继续遵守适用的 `AGENTS.md` 及上游 Skill，不因完成编码自动扩大执行权限。

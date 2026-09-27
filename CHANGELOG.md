# Changelog

## Unreleased

- 修复“删除全部会话”只遍历工作区账目的问题：现在按项目目录枚举全部会话，覆盖未登记进工作区的子代理会话与已脱钩会话。
- `POST /dsh-session-delete/delete-all` 响应新增 `scanned` 字段，返回本次实际扫描到的会话数。

## 0.3.1 - 2026-08-29

- 修复从 `node:fs` 错误导入 `dirname` 导致 dsh web 启动失败的问题。

## 0.3.0 - 2026-08-29

- 新增“会话管理”设置页：查看已归档会话、恢复、物理删除。
- 归档会话时同步备份工作区信息（工作区 id、路径、标题、归档时间）。
- 恢复会话时优先使用备份的工作区信息；原工作区已删除则按路径/标题自动重建。
- Host 新增 `POST /dsh-session-delete/archive`、`POST /dsh-session-delete/list-archived`。

## 0.2.0 - 2026-08-29

- 新增恢复归档会话功能。
- 会话行菜单增加“恢复全部已归档会话”。
- 工作区行菜单增加“恢复归档会话”。
- 恢复时自动放回原工作区；如果原工作区注册已删除，按会话 cwd 自动重建工作区。
- Host 新增 `POST /dsh-session-delete/restore` 与 `POST /dsh-session-delete/restore-all`。

## 0.1.0 - 2026-08-26

- 从 [vtxf/dsh-session-delete](https://github.com/vtxf/dsh-session-delete) fork 到 `wenhao4126/dsh-session-delete`。
- 保留完整功能：侧边栏单会话删除、工作区级归档全部 / 删除全部。
- 补齐 MIT LICENSE，并标注 fork 来源。
- 增加 screenshots / 基础测试 / 维护文档。

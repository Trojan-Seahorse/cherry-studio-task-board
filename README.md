# Cherry Studio 任务看板

Bun + TypeScript + SQLite + MCP 协议的任务管理系统。为 Cherry Studio Agent 提供 Kanban / Gantt / 列表 / 多项目 / 归档等完整任务管理能力。

## 架构

```
┌─────────────────────┐     MCP (stdio)     ┌──────────────────┐
│  Cherry Studio      │ ◄──────────────────► │  mcp-server.ts   │
│  Agent (Claude)     │                      │  16 tools:       │
│  Mini App (HTML)    │                      │  create_task     │
│                     │                      │  list_tasks      │
└─────────┬───────────┘                      │  update_task     │
          │                                  │  move_task       │
          │  HTTP :17850                     │  delete_task     │
          ▼                                  │  list_projects   │
┌─────────────────────┐                      │  create_project  │
│  standalone-        │                      │  get_task_context│
│  kanban.html        │                      │  add_comment     │
│                     │                      │  list_comments   │
│  Kanban · Gantt     │                      │  link_dependency │
│  List · 标签筛选    │                      │  list_dependencies│
│  多项目 · 归档      │                      │  unlink_dependency│
│  Activity Log       │                      │  archive_project │
│                     │                      │  unarchive_project│
└─────────────────────┘                      │  backup_database │
                                             └────────┬─────────┘
                                                      │
                                                      │ SQLite (WAL)
                                                      ▼
                                             ┌──────────────────┐
                                             │  tasks.db        │
                                             │  6 表 · 外键 ·   │
                                             │  活动日志 · 评论   │
                                             └──────────────────┘
```

## 特性

| 功能 | 说明 |
|------|------|
| **Kanban 看板** | Backlog → Todo → In Progress → Done 四列拖拽 |
| **Gantt 甘特图** | 时间线视图，支持日期范围缩放 |
| **列表视图** | 表格 + 高级筛选（状态/优先级/日期/标签） |
| **标签筛选** | 预设筛选器 + 自定义标签组合 |
| **多项目管理** | 创建/切换项目，每项目独立任务集 |
| **项目归档** | 软归档/恢复，归档后任务只读 |
| **活动日志** | 每项操作记录（创建/更新/移动/评论/依赖） |
| **任务依赖** | blocks / branches / merges / sync 四种依赖类型 |
| **自动备份** | SQLite 数据库一键备份 |
| **全文搜索** | 标题 + 描述 + 评论全文检索 |

## 快速开始

```bash
# 安装依赖
bun install

# 启动 MCP + HTTP 一体服务器（端口 17850）
bun run mcp-server.ts

# 浏览器打开看板
# http://localhost:17850/kanban
```

## 数据库

SQLite (WAL 模式)。数据库文件位于 `../data/tasks.db`（相对于 task-board 目录）。
环境变量 `TASK_BOARD_DB` 可自定义路径。

首次启动自动创建表结构（schema.sql）并迁移 archived_at 列。

### 数据表

| 表 | 说明 |
|----|------|
| `projects` | 项目（含 archived_at 软归档） |
| `tasks` | 任务卡片（标题/状态/优先级/进度/标签/日期/负责人） |
| `task_dependencies` | 任务依赖关系 |
| `activity_log` | 操作审计日志 |
| `comments` | 任务评论/Markdown |
| `backups` | 自动备份记录 |

## MCP 工具（16 个）

### 任务操作
| 工具 | 说明 |
|------|------|
| `create_task` | 创建任务（title 必填，支持 project_id / parent_id / tags / due_date） |
| `list_tasks` | 列表查询（status / priority / search / project_id / parent_id / dependency_status） |
| `update_task` | 更新字段（title / description / priority / progress / due_date / assigned_to / tags） |
| `move_task` | 移动状态列（backlog → todo → in-progress → done，done 自动 100%） |
| `delete_task` | 删除任务及关联日志/评论（归档项目禁止） |
| `get_task_context` | 获取任务完整上下文（详情 + 评论 + 依赖 + 子任务 + 活动日志） |

### 评论
| 工具 | 说明 |
|------|------|
| `add_comment` | 给任务添加评论/Markdown |
| `list_comments` | 查看任务评论列表 |

### 依赖
| 工具 | 说明 |
|------|------|
| `link_dependency` | 创建任务依赖（blocks / branches / merges / sync） |
| `list_dependencies` | 查询依赖关系 |
| `unlink_dependency` | 删除依赖 |

### 项目
| 工具 | 说明 |
|------|------|
| `list_projects` | 列出项目（支持 include_archived） |
| `create_project` | 创建新项目 |
| `archive_project` | 归档项目（任务变只读） |
| `unarchive_project` | 恢复已归档项目 |

### 运维
| 工具 | 说明 |
|------|------|
| `backup_database` | 备份 SQLite 数据库 |

## 文件说明

| 文件 | 用途 |
|------|------|
| `mcp-server.ts` | MCP + HTTP 一体服务器（16 tools + REST API） |
| `standalone-kanban.html` | 单文件前端（Kanban / Gantt / List / 多项目 / 归档） |
| `schema.sql` | 数据库 DDL（6 表 + 索引） |
| `package.json` | 项目配置与依赖 |
| `test-mcp.ts` | MCP 工具测试脚本 |
| `test-update.ts` | update_task / move_task 测试 |
| `verify-db.ts` | 数据库完整性验证 |
| `kanban-prototype.html` | 看板 UI 原型 |
| `gantt-prototype.html` | 甘特图原型 |

## 技术栈

- **Runtime**: [Bun](https://bun.sh) — JavaScript/TypeScript 运行时
- **Database**: SQLite (WAL 模式, bun:sqlite)
- **Protocol**: [MCP (Model Context Protocol)](https://modelcontextprotocol.io) — stdio 传输
- **HTTP Server**: Bun.serve (内置于 mcp-server.ts，端口 17850)
- **Frontend**: Vanilla HTML/CSS/JS (standalone-kanban.html)
- **Schema Validation**: [Zod](https://zod.dev)

## License

MIT

## 作者

Xi Ewell

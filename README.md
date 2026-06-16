# Cardo

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

## 部署说明

本看板由两部分组成：**MCP Server**（供 Agent 调用）和 **看板前端**（Mini App）。MCP Server 启动后会同时提供 HTTP 服务（端口 17850），前端通过 HTTP API 读写数据。

> 参考：[Cherry Studio 官方文档 — 配置和使用 MCP](https://docs.cherry-ai.com/advanced-basic/mcp/config)、[小程序（Mini App）](https://docs.cherry-ai.com/cherry-studio/preview/app)

### 1. 下载项目

```powershell
git clone https://github.com/Trojan-Seahorse/cardo.git
cd cardo
```

或者直接下载 ZIP 解压到本地目录。

### 2. 安装依赖

Cherry Studio 在首次启用 MCP 时已自动安装 Bun 到 `C:\Users\<用户名>\.cherrystudio\bin\bun.exe`，直接用它安装依赖：

```powershell
C:\Users\<用户名>\.cherrystudio\bin\bun.exe install
```

如果还没启用过任何 MCP，先打开 Cherry Studio → `设置` → `MCP 服务器`，点击右上角的 `安装` 按钮即可自动下载 Bun。

### 3. 在 Cherry Studio 中配置 MCP 服务器（主推荐：JSON）

打开 `设置` → `MCP 服务器` → 点右上角 `编辑 JSON`，粘贴以下内容（**把两处 `<用户名>` 换成你的 Windows 用户名**）：

```json
{
  "mcpServers": {
    "cardo": {
      "command": "C:\\Users\\<用户名>\\.cherrystudio\\bin\\bun.exe",
      "args": [
        "run",
        "D:\\Cherry Studio\\task-board\\mcp-server.ts"
      ],
      "env": {
        "TASK_BOARD_DB": "D:\\Cherry Studio\\data\\tasks.db"
      }
    }
  }
}
```

点 `确定` 保存，Cherry Studio 会自动启动 MCP Server。点击服务器条目可查看运行状态。

> **路径说明**：上面以 `D:\Cherry Studio\` 为例。如果你把项目放到了其他位置，把 `args` 和 `TASK_BOARD_DB` 改成实际路径。`TASK_BOARD_DB` 也可以不设，默认在项目上级的 `data\tasks.db`。

### 4. 启用 MCP 工具

- **对话模式**：聊天框下方找到 MCP 工具图标 → 勾选 `cardo`
- **Agent 模式**：Agent 编辑 → `工具` → MCP 分组下勾选 `cardo`

### 5. 添加看板前端为 Mini App（推荐）

MCP Server 启动后自动开启 HTTP 服务（端口 17850）。把看板加到 Cherry Studio 的 Mini App：

1. Cherry Studio 顶部 `+` → **启动台** → `小程序`
2. 滑到底部点 `自定义`：

| 字段 | 值 |
|------|----|
| 名称 | `任务看板` |
| URL | `http://localhost:17850/kanban` |
| 图标 | 留空即可 |

3. 保存后在 Mini App 网格中打开看板
4. 右键图标 → `添加到启动台`，固定到顶部 Tab 方便随时切换

> **关于 `data:` URL**：项目中 `data-url.txt` 包含 HTML 的 base64 编码，但**不推荐**——`data:` URL 的 webview 受同源策略限制，**无法 `fetch` 到 `localhost:17850`**，看板会没有数据。

### 6. 验证

在 Cherry Studio 聊天框输入：

> 列出所有任务

Agent 调用了 `list_tasks` 则 MCP 连接正常。打开 Mini App 看板也能看到数据。

---

### 备选方案：MCPB 一键安装包

Cherry Studio 支持导入 MCPB（MCP Bundle，原名 DXT）文件，可实现**免配置一键安装**。

#### 制作 MCPB 包

先用 Bun 编译为独立 `.exe`（含 Bun 运行时 + SQLite + 全部依赖）：

```powershell
C:\Users\<用户名>\.cherrystudio\bin\bun.exe build --compile mcp-server.ts --outfile server/mcp-server.exe
```

创建 `manifest.json`：

```json
{
  "manifest_version": "0.3",
  "name": "cardo",
  "version": "0.2.0",
  "description": "Cardo · Kanban / Gantt / 多项目 / 归档",
  "author": { "name": "Xi Ewell" },
  "server": {
    "type": "binary",
    "mcp_config": {
      "command": "${__dirname}/server/mcp-server.exe",
      "args": [],
      "env": {
        "TASK_BOARD_DB": "${__dirname}/../data/tasks.db"
      }
    }
  },
  "license": "MIT",
  "compatibility": { "platforms": ["win32"] }
}
```

打包为 `.mcpb`（本质是 zip）：

```powershell
# 确保目录结构为：
#   task-board/
#     manifest.json
#     server/mcp-server.exe
Compress-Archive -Path manifest.json, server -DestinationPath cardo.mcpb
```

#### 安装

Cherry Studio → `设置` → `MCP 服务器` → `添加服务器` → 选择 `DXT/MCPB 导入` → 选中 `.mcpb` 文件。

> ⚠️ Cherry Studio 的 MCPB 导入目前有部分已知问题（路径变量替换、配置表单），导入后建议检查 `命令` 和 `参数` 是否正确。如遇问题，回退到上方的 JSON 方式。

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

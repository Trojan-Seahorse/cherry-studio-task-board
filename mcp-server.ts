/**
 * Cherry Studio 任务看板 · MCP Server
 * Bun + TypeScript + SQLite + @modelcontextprotocol/sdk
 *
 * 提供 4 个 MCP 工具:
 *   create_task  - 创建任务
 *   list_tasks   - 列出任务
 *   update_task  - 更新任务
 *   move_task    - 移动任务到不同状态列
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── 数据库初始化 ──────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.TASK_BOARD_DB || join(__dirname, "..", "data", "tasks.db");

function initDB(): Database {
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");
  return db;
}

const db = initDB();

// ── Schema 迁移：archived_at ─────────────────────────────
try {
  db.run("ALTER TABLE projects ADD COLUMN archived_at TEXT");
  console.log("[migrate] 已添加 projects.archived_at 列");
} catch {
  // 列已存在，忽略
}

// ── 辅助函数 ──────────────────────────────────────────────

function now(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function newId(): string {
  return randomUUID().replace(/-/g, "").substring(0, 16);
}

function logActivity(db: Database, taskId: string, action: string, field: string | null, oldVal: string | null, newVal: string | null, actor?: string) {
  const a = actor || "agent"; // 调用者一定是 Agent，不再用 'system'
  db.run(
    "INSERT INTO activity_log (task_id, action, field, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?, ?)",
    [taskId, action, field, oldVal, newVal, a]
  );
}

// 解析 updated_since 参数：支持相对时间 "7d"/"3h"/"1w" 和 ISO 日期 "2026-06-10"
function parseUpdatedSince(val: string): string {
  const rel = /^(\d+)([hdwm])$/i.exec(val);
  if (rel) {
    const num = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const msMap: Record<string, number> = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 };
    const cutoff = new Date(Date.now() - num * (msMap[unit] || 86400000));
    return cutoff.toISOString().replace("T", " ").substring(0, 19);
  }
  // ISO 日期 or datetime
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
    return val.length === 10 ? val + " 00:00:00" : val;
  }
  // fallback: 当作天数
  const n = parseInt(val, 10);
  if (!isNaN(n)) {
    const cutoff = new Date(Date.now() - n * 86400000);
    return cutoff.toISOString().replace("T", " ").substring(0, 19);
  }
  throw new Error(`无法解析 updated_since: ${val}（支持 "7d"/"3h"/"1w"/"2026-06-10"）`);
}

// 尝试从 MCP extra 中获取 agent 身份（Cherry Studio 可能传递）
function getActorFromRequest(extra?: any): string {
  // Cherry Studio Mcp_CallTool IPC 可能在 requestInfo 中传递 agent 名称
  if (extra?.requestInfo?.agentName) return extra.requestInfo.agentName;
  if (extra?.sessionId) return extra.sessionId.substring(0, 8);
  return "agent";
}

// 检查项目是否已归档（返回 null = 活跃，返回错误信息 = 已归档）
function isArchivedError(projectId: string): string | null {
  const p = db.query("SELECT archived_at FROM projects WHERE id = ?").get(projectId) as any;
  if (p && p.archived_at) {
    return `项目 "${projectId}" 已于 ${p.archived_at} 归档，不能修改其任务`;
  }
  return null;
}

// ── 数据库备份 ────────────────────────────────────────────

const BACKUP_DIR = join(__dirname, "..", "data", "backups");

function ensureBackupDir() {
  try { require("node:fs").mkdirSync(BACKUP_DIR, { recursive: true }); } catch {}
}

function performBackup(): string {
  ensureBackupDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
  const bkPath = join(BACKUP_DIR, `tasks-${ts}.db`);

  // VACUUM INTO creates a clean, consistent snapshot (SQLite 3.27+)
  db.run(`VACUUM INTO '${bkPath.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`);

  // 保留最近 10 个备份，清理旧的
  try {
    const fs = require("node:fs");
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f: string) => f.startsWith("tasks-") && f.endsWith(".db"))
      .map((f: string) => ({ name: f, time: fs.statSync(join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a: any, b: any) => b.time - a.time);
    for (let i = 10; i < files.length; i++) {
      fs.unlinkSync(join(BACKUP_DIR, files[i].name));
    }
  } catch {}

  const size = require("node:fs").statSync(bkPath).size;
  return `✅ 备份完成: ${bkPath} (${(size / 1024).toFixed(1)} KB)`;
}

// ── 编码校验：杜绝 U+FFFD / 控制字符写入数据库 ──────────────

const CORRUPTION_MARKER = "\uFFFD"; // 替换字符，编码错误标志

function hasEncodingCorruption(s: string): string | null {
  if (typeof s !== "string") return null;
  if (s.includes(CORRUPTION_MARKER)) return `含编码损坏标记 (U+FFFD): ${JSON.stringify(s).substring(0, 80)}`;
  // 检测非 UTF-8 典型乱码模式：Latin-1 高字节区被当作合法字符
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    if (cp >= 0x80 && cp <= 0x9F) {
      return `含异常控制字符 U+${cp.toString(16).toUpperCase().padStart(4, "0")}，疑似编码错误`;
    }
  }
  return null;
}

function checkTextField(value: unknown, fieldName: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") throw new Error(`${fieldName} 必须为字符串`);
  const err = hasEncodingCorruption(value);
  if (err) throw new Error(`${fieldName}: ${err}`);
}

// ── 近期待办扫描（写操作钩子）────────────────────────────

function getDeadlineAlerts(): string | null {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const todayStr = `${y}-${m}-${d}`;

  const future = new Date(today);
  future.setDate(future.getDate() + 3);
  const fy = future.getFullYear();
  const fm = String(future.getMonth() + 1).padStart(2, "0");
  const fd = String(future.getDate()).padStart(2, "0");
  const futureStr = `${fy}-${fm}-${fd}`;

  const tasks = db.query(
    `SELECT id, title, due_date, priority, status
     FROM tasks
     WHERE due_date BETWEEN ? AND ?
       AND status != 'done'
     ORDER BY due_date ASC, priority DESC`
  ).all(todayStr, futureStr) as any[];

  if (tasks.length === 0) return null;

  const lines = tasks.map((t: any) => {
    const icon = t.priority >= 4 ? "🔴" : t.priority >= 3 ? "🟡" : "🟢";
    const isToday = t.due_date === todayStr;
    return `  ${icon} [${t.status}] ${t.title}${isToday ? " ⚡今天!" : ` → ${t.due_date}`}`;
  });

  return `⚠️ 未来3天截止提醒 (${tasks.length}个):\n${lines.join("\n")}`;
}

function withDeadlineAlert(result: any): any {
  const alert = getDeadlineAlerts();
  if (!alert) return result;
  const content = Array.isArray(result.content) ? result.content : [result.content];
  return { ...result, content: [...content, { type: "text", text: alert }] };
}

// ── MCP Server ────────────────────────────────────────────

const server = new McpServer({
  name: "cherry-studio-task-board",
  version: "0.1.0",
});

// ── Tool: create_task ─────────────────────────────────────

server.tool(
  "create_task",
  "创建新的任务卡片。标题必填，其余选填。",
  {
    title: z.string().describe("任务标题"),
    status: z.enum(["backlog", "todo", "in-progress", "done"]).default("backlog").describe("任务状态"),
    priority: z.number().min(0).max(5).default(3).describe("优先级 0-5, 数字越大越紧急"),
    description: z.string().optional().describe("任务描述/Markdown"),
    start_date: z.string().optional().describe("开始日期 YYYY-MM-DD"),
    due_date: z.string().optional().describe("截止日期 YYYY-MM-DD"),
    assigned_to: z.string().optional().describe("负责人"),
    tags: z.string().optional().describe("标签，逗号分隔"),
    project_id: z.string().default("default").describe("所属项目ID"),
    progress: z.number().min(0).max(100).default(0).describe("进度百分比 0-100"),
    parent_id: z.string().optional().describe("父任务ID，用于创建子任务"),
  },
  async (params, extra) => {
    const archErr = isArchivedError(params.project_id);
    if (archErr) return { content: [{ type: "text", text: `错误: ${archErr}` }], isError: true };
    checkTextField(params.title, "title");
    checkTextField(params.description, "description");
    checkTextField(params.assigned_to, "assigned_to");
    checkTextField(params.tags, "tags");
    const actor = getActorFromRequest(extra);
    const id = newId();
    const tags = params.tags ? JSON.stringify(params.tags.split(",").map((t: string) => t.trim())) : "[]";

    // 验证 parent_id 指向的任务存在
    if (params.parent_id) {
      const parent = db.query("SELECT id FROM tasks WHERE id = ?").get(params.parent_id);
      if (!parent) {
        return { content: [{ type: "text", text: `错误: 父任务 ${params.parent_id} 不存在` }], isError: true };
      }
    }

    db.run(
      `INSERT INTO tasks (id, project_id, title, description, status, priority,
        start_date, due_date, sort_order, assigned_to, progress, tags, parent_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, params.project_id, params.title, params.description || null,
        params.status, params.priority, params.start_date || null,
        params.due_date || null, Date.now() / 1000, params.assigned_to || null,
        params.progress, tags, params.parent_id || null, actor, now(), now(),
      ]
    );

    logActivity(db, id, "created", null, null, params.title, actor);

    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
    return withDeadlineAlert({
      content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    });
  }
);

// ── Tool: list_tasks ──────────────────────────────────────

server.tool(
  "list_tasks",
  "列出任务卡片。可按状态、项目、优先级筛选，支持全文搜索（标题+描述+评论）、父任务筛选、依赖状态筛选、时间范围筛选。",
  {
    status: z.enum(["backlog", "todo", "in-progress", "done", "all"]).default("all").describe("按状态筛选"),
    project_id: z.string().optional().describe("按项目筛选"),
    priority_min: z.number().min(0).max(5).optional().describe("最低优先级"),
    search: z.string().optional().describe("全文关键词搜索（标题+描述+评论）"),
    limit: z.number().default(50).describe("返回数量上限"),
    parent_id: z.string().optional().describe("按父任务筛选（查子任务）"),
    dependency_status: z.enum(["blocked", "blocking", "ready"]).optional().describe("按依赖状态筛选"),
    updated_since: z.string().optional().describe("更新时间筛选：'7d'/'3h'/'1w' 或 ISO 日期"),
  },
  async (params) => {
    // dependency_status 需要 JOIN，特殊处理
    if (params.dependency_status) {
      const ds = params.dependency_status;
      let sql = "";
      const bindings: any[] = [];

      if (ds === "blocked") {
        // 有未完成的依赖
        sql = `SELECT DISTINCT t.* FROM tasks t
               JOIN task_dependencies d ON t.id = d.task_id
               JOIN tasks dep ON d.depends_on_id = dep.id
               WHERE dep.status != 'done'`;
      } else if (ds === "blocking") {
        // 阻塞了其他未完成任务
        sql = `SELECT DISTINCT t.* FROM tasks t
               JOIN task_dependencies d ON t.id = d.depends_on_id
               JOIN tasks blocked ON d.task_id = blocked.id
               WHERE blocked.status != 'done'`;
      } else if (ds === "ready") {
        // 无依赖或所有依赖已完成
        sql = `SELECT t.* FROM tasks t
               WHERE t.id NOT IN (
                 SELECT d.task_id FROM task_dependencies d
                 JOIN tasks dep ON d.depends_on_id = dep.id
                 WHERE dep.status != 'done'
               ) AND t.status != 'done'`;
      }

      if (params.project_id) { sql += " AND t.project_id = ?"; bindings.push(params.project_id); }
      if (params.search) {
        sql += " AND (t.title LIKE ? OR t.description LIKE ? OR t.id IN (SELECT task_id FROM comments WHERE content LIKE ?))";
        const p = `%${params.search}%`; bindings.push(p, p, p);
      }
      if (params.updated_since) { sql += " AND t.updated_at >= ?"; bindings.push(parseUpdatedSince(params.updated_since)); }
      sql += " ORDER BY t.sort_order ASC, t.priority DESC, t.created_at DESC LIMIT ?";
      bindings.push(params.limit);
      const tasks = db.query(sql).all(...(bindings as [any]));
      return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
    }

    let sql = "SELECT * FROM tasks WHERE 1=1";
    const bindings: any[] = [];

    if (params.status && params.status !== "all") {
      sql += " AND status = ?";
      bindings.push(params.status);
    }
    if (params.project_id) {
      sql += " AND project_id = ?";
      bindings.push(params.project_id);
    }
    if (params.priority_min !== undefined) {
      sql += " AND priority >= ?";
      bindings.push(params.priority_min);
    }
    if (params.search) {
      sql += " AND (title LIKE ? OR description LIKE ? OR id IN (SELECT task_id FROM comments WHERE content LIKE ?))";
      const pattern = `%${params.search}%`;
      bindings.push(pattern, pattern, pattern);
    }
    if (params.parent_id) {
      sql += " AND parent_id = ?";
      bindings.push(params.parent_id);
    }
    if (params.updated_since) {
      sql += " AND updated_at >= ?";
      bindings.push(parseUpdatedSince(params.updated_since));
    }

    sql += " ORDER BY sort_order ASC, priority DESC, created_at DESC LIMIT ?";
    bindings.push(params.limit);

    const tasks = db.query(sql).all(...(bindings as [any]));
    return {
      content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
    };
  }
);

// ── Tool: update_task ─────────────────────────────────────

server.tool(
  "update_task",
  "更新任务字段：标题、描述、优先级、进度、日期、负责人、标签。",
  {
    id: z.string().describe("任务ID"),
    title: z.string().optional().describe("新标题"),
    description: z.string().optional().describe("新描述"),
    priority: z.number().min(0).max(5).optional().describe("新优先级"),
    progress: z.number().min(0).max(100).optional().describe("新进度"),
    start_date: z.string().optional().describe("开始日期"),
    due_date: z.string().optional().describe("截止日期"),
    assigned_to: z.string().optional().describe("负责人"),
    tags: z.string().optional().describe("标签(逗号分隔)"),
  },
  async (params) => {
    checkTextField(params.title, "title");
    checkTextField(params.description, "description");
    checkTextField(params.assigned_to, "assigned_to");
    checkTextField(params.tags, "tags");
    const old = db.query("SELECT * FROM tasks WHERE id = ?").get(params.id) as any;
    if (!old) {
      return { content: [{ type: "text", text: `错误: 任务 ${params.id} 不存在` }], isError: true };
    }
    const archErr = isArchivedError(old.project_id);
    if (archErr) return { content: [{ type: "text", text: `错误: ${archErr}` }], isError: true };

    const fields: string[] = [];
    const bindings: any[] = [];

    const updatable = ["title", "description", "priority", "progress", "start_date", "due_date", "assigned_to", "sort_order"];
    for (const f of updatable) {
      if ((params as any)[f] !== undefined) {
        fields.push(`${f} = ?`);
        bindings.push((params as any)[f]);
        logActivity(db, params.id, "updated", f, String((old as any)[f] ?? ""), String((params as any)[f]));
      }
    }

    if (params.tags !== undefined) {
      fields.push("tags = ?");
      const tagArr = params.tags.split(",").map((t: string) => t.trim());
      bindings.push(JSON.stringify(tagArr));
      logActivity(db, params.id, "updated", "tags", (old as any).tags || "[]", JSON.stringify(tagArr));
    }

    if (fields.length === 0) {
      return { content: [{ type: "text", text: "没有需要更新的字段" }] };
    }

    fields.push("updated_at = ?");
    bindings.push(now());
    bindings.push(params.id);

    db.run(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`, bindings);

    const updated = db.query("SELECT * FROM tasks WHERE id = ?").get(params.id);
    return withDeadlineAlert({
      content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
    });
  }
);

// ── Tool: move_task ───────────────────────────────────────

server.tool(
  "move_task",
  "将任务移动到不同的状态列 (backlog / todo / in-progress / done)。移到 done 时自动设进度 100%。",
  {
    id: z.string().describe("任务ID"),
    status: z.enum(["backlog", "todo", "in-progress", "done"]).describe("目标状态列"),
  },
  async (params) => {
    const old = db.query("SELECT * FROM tasks WHERE id = ?").get(params.id) as any;
    if (!old) {
      return { content: [{ type: "text", text: `错误: 任务 ${params.id} 不存在` }], isError: true };
    }
    const archErr = isArchivedError(old.project_id);
    if (archErr) return { content: [{ type: "text", text: `错误: ${archErr}` }], isError: true };

    const oldStatus = (old as any).status;
    const completedAt = params.status === "done" ? now() : null;
    const progress = params.status === "done" ? 100 : (old as any).progress;

    db.run(
      "UPDATE tasks SET status = ?, completed_at = ?, progress = ?, updated_at = ? WHERE id = ?",
      [params.status, completedAt, progress, now(), params.id]
    );

    logActivity(db, params.id, "moved", "status", oldStatus, params.status);

    if (params.status === "done") {
      logActivity(db, params.id, "moved", "progress", String((old as any).progress ?? "0"), "100");
      logActivity(db, params.id, "moved", "completed_at", "null", completedAt!);
    }

    const updated = db.query("SELECT * FROM tasks WHERE id = ?").get(params.id);
    return withDeadlineAlert({
      content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
    });
  }
);

// ── Tool: delete_task ─────────────────────────────────────

server.tool(
  "delete_task",
  "删除任务及其活动日志。返回被删除任务的最后状态。",
  {
    id: z.string().describe("任务ID"),
  },
  async (params) => {
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(params.id) as any;
    if (!task) {
      return { content: [{ type: "text", text: `错误: 任务 ${params.id} 不存在` }], isError: true };
    }
    const archErr = isArchivedError(task.project_id);
    if (archErr) return { content: [{ type: "text", text: `错误: ${archErr}` }], isError: true };

    db.run("DELETE FROM activity_log WHERE task_id = ?", [params.id]);
    db.run("DELETE FROM tasks WHERE id = ?", [params.id]);

    return withDeadlineAlert({
      content: [{ type: "text", text: `已删除: ${task.title}\n${JSON.stringify(task, null, 2)}` }],
    });
  }
);

// ── Tool: list_projects ──────────────────────────────────

server.tool(
  "list_projects",
  "列出所有项目。默认不返回已归档项目。",
  {
    include_archived: z.boolean().default(false).describe("是否包含已归档项目"),
  },
  async (params) => {
    const sql = params.include_archived
      ? "SELECT * FROM projects ORDER BY created_at ASC"
      : "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC";
    const projects = db.query(sql).all();
    return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
  }
);

// ── Tool: create_project ─────────────────────────────────

server.tool(
  "create_project",
  "创建新项目。",
  {
    name: z.string().describe("项目名称"),
    description: z.string().optional().describe("项目描述"),
    color: z.string().default("#6366f1").describe("项目颜色(hex)"),
  },
  async (params) => {
    checkTextField(params.name, "name");
    checkTextField(params.description, "description");
    const id = newId();
    db.run(
      "INSERT INTO projects (id, name, description, color) VALUES (?, ?, ?, ?)",
      [id, params.name, params.description || null, params.color]
    );
    const project = db.query("SELECT * FROM projects WHERE id = ?").get(id);
    return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
  }
);

// ── Tool: archive_project ─────────────────────────────────

server.tool(
  "archive_project",
  "归档项目。项目归档后所有任务变为只读，默认在列表中隐藏。可随时用 unarchive_project 恢复。",
  {
    id: z.string().describe("要归档的项目ID"),
  },
  async (params) => {
    const project = db.query("SELECT * FROM projects WHERE id = ?").get(params.id) as any;
    if (!project) return { content: [{ type: "text", text: `错误: 项目 ${params.id} 不存在` }], isError: true };
    if (project.archived_at) return { content: [{ type: "text", text: `项目 "${project.name}" 已于 ${project.archived_at} 归档，无需重复操作` }] };
    const n = now();
    db.run("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?", [n, n, params.id]);
    // 统计该项目的任务数
    const count = (db.query("SELECT COUNT(*) as c FROM tasks WHERE project_id = ?").get(params.id) as any).c;
    return { content: [{ type: "text", text: `✅ 项目 "${project.name}" 已归档（含 ${count} 个任务，全部只读）` }] };
  }
);

// ── Tool: unarchive_project ───────────────────────────────

server.tool(
  "unarchive_project",
  "取消归档，恢复项目为活跃状态。",
  {
    id: z.string().describe("要恢复的项目ID"),
  },
  async (params) => {
    const project = db.query("SELECT * FROM projects WHERE id = ?").get(params.id) as any;
    if (!project) return { content: [{ type: "text", text: `错误: 项目 ${params.id} 不存在` }], isError: true };
    if (!project.archived_at) return { content: [{ type: "text", text: `项目 "${project.name}" 未归档，无需恢复` }] };
    db.run("UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?", [now(), params.id]);
    return { content: [{ type: "text", text: `✅ 项目 "${project.name}" 已恢复为活跃状态` }] };
  }
);

// ── Tool: backup_database ────────────────────────────────

server.tool(
  "backup_database",
  "备份 SQLite 数据库到 backups 目录。返回备份文件路径。",
  {},
  async () => {
    const result = performBackup();
    return { content: [{ type: "text", text: result }] };
  }
);

// ── Tool: add_comment ──────────────────────────────────────

server.tool(
  "add_comment",
  "给任务添加评论/备注。",
  {
    task_id: z.string().describe("任务ID"),
    content: z.string().describe("评论内容/Markdown"),
    author: z.string().optional().describe("评论者（默认取 agent 身份）"),
  },
  async (params, extra) => {
    checkTextField(params.content, "content");
    const existing = db.query("SELECT id, project_id FROM tasks WHERE id = ?").get(params.task_id) as any;
    if (!existing) return { content: [{ type: "text", text: `错误: 任务 ${params.task_id} 不存在` }], isError: true };
    const archErr = isArchivedError(existing.project_id);
    if (archErr) return { content: [{ type: "text", text: `错误: ${archErr}` }], isError: true };
    const actor = params.author || getActorFromRequest(extra);
    db.run(
      "INSERT INTO comments (task_id, content, author) VALUES (?, ?, ?)",
      [params.task_id, params.content, actor]
    );
    logActivity(db, params.task_id, "comment_added", null, null, params.content.substring(0, 100), actor);
    return { content: [{ type: "text", text: `✅ 评论已添加` }] };
  }
);

// ── Tool: list_comments ────────────────────────────────────

server.tool(
  "list_comments",
  "查看任务的评论列表。",
  {
    task_id: z.string().describe("任务ID"),
    limit: z.number().default(20).describe("返回数量上限"),
  },
  async (params) => {
    const comments = db.query(
      "SELECT * FROM comments WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(params.task_id, params.limit);
    return { content: [{ type: "text", text: JSON.stringify(comments, null, 2) }] };
  }
);

// ── Tool: link_dependency ──────────────────────────────────

server.tool(
  "link_dependency",
  "创建任务依赖关系。B 依赖于 A 意味着 A 完成后 B 才能开始。",
  {
    task_id: z.string().describe("依赖方任务ID（被阻塞的任务）"),
    depends_on_id: z.string().describe("被依赖任务ID（必须先完成的任务）"),
    dependency_type: z.enum(["blocks", "branches", "merges", "sync"]).default("blocks").describe("依赖类型"),
  },
  async (params, extra) => {
    if (params.task_id === params.depends_on_id) {
      return { content: [{ type: "text", text: "错误: 任务不能依赖于自身" }], isError: true };
    }
    // 归档保护：两个任务都必须在活跃项目中
    for (const tid of [params.task_id, params.depends_on_id]) {
      const t = db.query("SELECT id, project_id FROM tasks WHERE id = ?").get(tid) as any;
      if (!t) return { content: [{ type: "text", text: `错误: 任务 ${tid} 不存在` }], isError: true };
      const archErr = isArchivedError(t.project_id);
      if (archErr) return { content: [{ type: "text", text: `错误: ${archErr}` }], isError: true };
    }
    // 循环依赖检测：depends_on_id 是否已经(直接或间接)依赖于 task_id
    const visited = new Set<string>();
    const stack = [params.task_id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === params.depends_on_id) {
        return { content: [{ type: "text", text: "错误: 此操作会创建循环依赖" }], isError: true };
      }
      if (visited.has(current)) continue;
      visited.add(current);
      const deps = db.query(
        "SELECT depends_on_id FROM task_dependencies WHERE task_id = ?"
      ).all(current) as any[];
      for (const d of deps) stack.push(d.depends_on_id);
    }
    try {
      db.run(
        "INSERT INTO task_dependencies (task_id, depends_on_id, dependency_type) VALUES (?, ?, ?)",
        [params.task_id, params.depends_on_id, params.dependency_type]
      );
      const actor = getActorFromRequest(extra);
      logActivity(db, params.task_id, "dependency_added", null, null, `${params.dependency_type}: ${params.depends_on_id}`, actor);
      return { content: [{ type: "text", text: `✅ 依赖已创建: ${params.task_id} → depends on → ${params.depends_on_id} (${params.dependency_type})` }] };
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) {
        return { content: [{ type: "text", text: "此依赖关系已存在" }], isError: true };
      }
      return { content: [{ type: "text", text: `错误: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: list_dependencies ────────────────────────────────

server.tool(
  "list_dependencies",
  "查询任务的依赖关系。可按任务ID或依赖类型筛选。",
  {
    task_id: z.string().optional().describe("任务ID（不填则返回所有依赖关系）"),
    dependency_type: z.enum(["blocks", "branches", "merges", "sync"]).optional().describe("按依赖类型筛选"),
  },
  async (params) => {
    let sql = `SELECT d.*,
               t.title as task_title, t.status as task_status,
               dep.title as depends_on_title, dep.status as depends_on_status
               FROM task_dependencies d
               LEFT JOIN tasks t ON d.task_id = t.id
               LEFT JOIN tasks dep ON d.depends_on_id = dep.id
               WHERE 1=1`;
    const bindings: any[] = [];
    if (params.task_id) {
      sql += " AND (d.task_id = ? OR d.depends_on_id = ?)";
      bindings.push(params.task_id, params.task_id);
    }
    if (params.dependency_type) {
      sql += " AND d.dependency_type = ?";
      bindings.push(params.dependency_type);
    }
    sql += " ORDER BY d.created_at DESC LIMIT 100";
    const deps = db.query(sql).all(...(bindings as [any]));
    return { content: [{ type: "text", text: JSON.stringify(deps, null, 2) }] };
  }
);

// ── Tool: unlink_dependency ────────────────────────────────

server.tool(
  "unlink_dependency",
  "删除任务依赖关系。",
  {
    task_id: z.string().describe("依赖方任务ID"),
    depends_on_id: z.string().describe("被依赖任务ID"),
  },
  async (params, extra) => {
    const result = db.run(
      "DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?",
      [params.task_id, params.depends_on_id]
    );
    if (result.changes === 0) {
      return { content: [{ type: "text", text: "依赖关系不存在" }], isError: true };
    }
    const actor = getActorFromRequest(extra);
    logActivity(db, params.task_id, "dependency_removed", null, params.depends_on_id, null, actor);
    return { content: [{ type: "text", text: `✅ 依赖已删除` }] };
  }
);

// ── Tool: get_task_context ─────────────────────────────────

server.tool(
  "get_task_context",
  "获取任务完整上下文：任务详情 + 评论 + 依赖 + 子任务 + 活动日志。一次调用替代多次查询。",
  {
    id: z.string().describe("任务ID"),
  },
  async (params) => {
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(params.id) as any;
    if (!task) return { content: [{ type: "text", text: `错误: 任务 ${params.id} 不存在` }], isError: true };

    const comments = db.query(
      "SELECT * FROM comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 5"
    ).all(params.id);

    const blockedBy = db.query(
      `SELECT d.*, t.title as title, t.status as status, t.priority as priority
       FROM task_dependencies d JOIN tasks t ON d.depends_on_id = t.id
       WHERE d.task_id = ?`
    ).all(params.id);

    const blocking = db.query(
      `SELECT d.*, t.title as title, t.status as status, t.priority as priority
       FROM task_dependencies d JOIN tasks t ON d.task_id = t.id
       WHERE d.depends_on_id = ?`
    ).all(params.id);

    const children = db.query(
      "SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC"
    ).all(params.id);

    const recentActivity = db.query(
      `SELECT a.*, t.title as task_title
       FROM activity_log a LEFT JOIN tasks t ON a.task_id = t.id
       WHERE a.task_id = ?
       ORDER BY a.id DESC LIMIT 10`
    ).all(params.id);

    const context = {
      task,
      comments,
      dependencies: { blocked_by: blockedBy, blocking },
      children,
      recent_activity: recentActivity,
    };

    return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }] };
  }
);

// ── HTTP Server（Mini App 展示层）──────────────────────────

const PORT = 17850;

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveFile(filePath: string): Response | null {
  try {
    const file = Bun.file(join(__dirname, filePath));
    if (file.size === 0) return null;
    const ext = filePath.substring(filePath.lastIndexOf("."));
    return new Response(file, {
      headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
    });
  } catch {
    return null;
  }
}

async function handleHTTP(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // GET /api/tasks
  if (path === "/api/tasks" && req.method === "GET") {
    const status = url.searchParams.get("status");
    const projectId = url.searchParams.get("project_id");
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: any[] = [];
    if (status && status !== "all") { sql += " AND status = ?"; params.push(status); }
    if (projectId) { sql += " AND project_id = ?"; params.push(projectId); }
    const updatedSince = url.searchParams.get("updated_since");
    if (updatedSince) { sql += " AND updated_at >= ?"; params.push(parseUpdatedSince(updatedSince)); }
    const searchQ = url.searchParams.get("search");
    if (searchQ) {
      sql += " AND (title LIKE ? OR description LIKE ? OR id IN (SELECT task_id FROM comments WHERE content LIKE ?))";
      const p = `%${searchQ}%`; params.push(p, p, p);
    }
    sql += " ORDER BY sort_order ASC, priority DESC, created_at DESC";
    const tasks = db.query(sql).all(...params as [any]);
    return json(tasks);
  }

  // POST /api/tasks
  if (path === "/api/tasks" && req.method === "POST") {
    try {
      const body = await req.json();
      checkTextField(body.title, "title");
      checkTextField(body.description, "description");
      checkTextField(body.assigned_to, "assigned_to");
      if (body.tags) {
        const arr = Array.isArray(body.tags) ? body.tags : [];
        for (const t of arr) checkTextField(t, "tags[]");
      }
      const id = newId();
      const tags = Array.isArray(body.tags) ? JSON.stringify(body.tags) : "[]";
      db.run(
        `INSERT INTO tasks (id, project_id, title, description, status, priority,
          start_date, due_date, sort_order, assigned_to, progress, tags, parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, body.project_id || "default", body.title, body.description || null,
         body.status || "backlog", body.priority || 3, body.start_date || null,
         body.due_date || null, Date.now() / 1000, body.assigned_to || null,
         body.progress || 0, tags, body.parent_id || null, now(), now()]
      );
      const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
      return json(task, 201);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // PATCH /api/tasks/:id
  const patchMatch = path.match(/^\/api\/tasks\/(.+)$/);
  if (patchMatch && req.method === "PATCH") {
    try {
      const id = patchMatch[1];
      const existing = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
      if (!existing) return json({ error: "任务不存在" }, 404);
      const body = await req.json();
      checkTextField(body.title, "title");
      checkTextField(body.description, "description");
      checkTextField(body.assigned_to, "assigned_to");
      const fields: string[] = [];
      const bindings: any[] = [];
      const updatable = ["title", "description", "status", "priority", "progress", "start_date", "due_date", "assigned_to"];
      for (const f of updatable) {
        if (body[f] !== undefined) {
          fields.push(`${f} = ?`);
          bindings.push(body[f]);
        }
      }
      if (body.tags !== undefined) {
        fields.push("tags = ?");
        bindings.push(JSON.stringify(body.tags));
      }
      if (body.status === "done" && existing.status !== "done") {
        fields.push("completed_at = ?");
        bindings.push(now());
        if (body.progress === undefined) { fields.push("progress = ?"); bindings.push(100); }
      }
      if (fields.length === 0) return json({ error: "无更新字段" }, 400);
      fields.push("updated_at = ?");
      bindings.push(now());
      bindings.push(id);
      db.run(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`, bindings);
      const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
      return json(task);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // DELETE /api/tasks/:id
  if (patchMatch && req.method === "DELETE") {
    const id = patchMatch[1];
    const existing = db.query("SELECT id FROM tasks WHERE id = ?").get(id);
    if (!existing) return json({ error: "任务不存在" }, 404);
    db.run("DELETE FROM tasks WHERE id = ?", [id]);
    return json({ success: true });
  }

  // GET /api/stats
  if (path === "/api/stats" && req.method === "GET") {
    const stats = db.query(
      "SELECT status, COUNT(*) as count FROM tasks WHERE project_id = 'default' GROUP BY status"
    ).all();
    const total = db.query("SELECT COUNT(*) as c FROM tasks WHERE project_id = 'default'").get() as any;
    return json({ stats, total: total?.c || 0 });
  }

  // GET /api/activity-log
  if (path === "/api/activity-log" && req.method === "GET") {
    const projectId = url.searchParams.get("project_id");
    const limit = parseInt(url.searchParams.get("limit") || "100");
    let sql = `SELECT a.*, t.title as task_title, t.project_id
               FROM activity_log a
               LEFT JOIN tasks t ON a.task_id = t.id
               WHERE 1=1`;
    const params: any[] = [];
    if (projectId) { sql += " AND t.project_id = ?"; params.push(projectId); }
    sql += " ORDER BY a.id DESC LIMIT ?";
    params.push(limit);
    const log = db.query(sql).all(...params as [any]);
    return json(log);
  }

  // POST /api/backup
  if (path === "/api/backup" && req.method === "POST") {
    try {
      const result = performBackup();
      return json({ success: true, message: result });
    } catch (e: any) {
      return json({ success: false, error: e.message }, 500);
    }
  }

  // GET /api/tasks/:id/comments
  const commentMatch = path.match(/^\/api\/tasks\/(.+)\/comments$/);
  if (commentMatch && req.method === "GET") {
    const comments = db.query(
      "SELECT * FROM comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(commentMatch[1]);
    return json(comments);
  }

  // POST /api/tasks/:id/comments
  if (commentMatch && req.method === "POST") {
    try {
      const body = await req.json();
      checkTextField(body.content, "content");
      if (!body.content) return json({ error: "评论内容必填" }, 400);
      const existing = db.query("SELECT id FROM tasks WHERE id = ?").get(commentMatch[1]);
      if (!existing) return json({ error: "任务不存在" }, 404);
      db.run(
        "INSERT INTO comments (task_id, content, author) VALUES (?, ?, ?)",
        [commentMatch[1], body.content, body.author || "human"]
      );
      return json({ success: true }, 201);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // GET /api/tasks/:id/dependencies
  const depMatch = path.match(/^\/api\/tasks\/(.+)\/dependencies$/);
  if (depMatch && req.method === "GET") {
    const deps = db.query(
      `SELECT d.*, t.title as task_title, t.status as task_status,
              dep.title as depends_on_title, dep.status as depends_on_status
       FROM task_dependencies d
       LEFT JOIN tasks t ON d.task_id = t.id
       LEFT JOIN tasks dep ON d.depends_on_id = dep.id
       WHERE d.task_id = ? OR d.depends_on_id = ?
       ORDER BY d.created_at DESC`
    ).all(depMatch[1], depMatch[1]);
    return json(deps);
  }

  // POST /api/tasks/:id/dependencies
  if (depMatch && req.method === "POST") {
    try {
      const body = await req.json();
      if (!body.depends_on_id) return json({ error: "depends_on_id 必填" }, 400);
      if (depMatch[1] === body.depends_on_id) return json({ error: "不能依赖自身" }, 400);
      db.run(
        "INSERT INTO task_dependencies (task_id, depends_on_id, dependency_type) VALUES (?, ?, ?)",
        [depMatch[1], body.depends_on_id, body.dependency_type || "blocks"]
      );
      return json({ success: true }, 201);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return json({ error: "依赖已存在" }, 409);
      return json({ error: e.message }, 400);
    }
  }

  // DELETE /api/tasks/:id/dependencies/:depId
  const depDelMatch = path.match(/^\/api\/tasks\/(.+)\/dependencies\/(.+)$/);
  if (depDelMatch && req.method === "DELETE") {
    db.run(
      "DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?",
      [depDelMatch[1], depDelMatch[2]]
    );
    return json({ success: true });
  }

  // GET /api/tasks/:id/context
  const ctxMatch = path.match(/^\/api\/tasks\/(.+)\/context$/);
  if (ctxMatch && req.method === "GET") {
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(ctxMatch[1]);
    if (!task) return json({ error: "任务不存在" }, 404);
    const comments = db.query(
      "SELECT * FROM comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 5"
    ).all(ctxMatch[1]);
    const blockedBy = db.query(
      `SELECT d.*, t.title as title, t.status as status
       FROM task_dependencies d JOIN tasks t ON d.depends_on_id = t.id
       WHERE d.task_id = ?`
    ).all(ctxMatch[1]);
    const blocking = db.query(
      `SELECT d.*, t.title as title, t.status as status
       FROM task_dependencies d JOIN tasks t ON d.task_id = t.id
       WHERE d.depends_on_id = ?`
    ).all(ctxMatch[1]);
    const children = db.query(
      "SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC"
    ).all(ctxMatch[1]);
    const recentActivity = db.query(
      "SELECT * FROM activity_log WHERE task_id = ? ORDER BY id DESC LIMIT 10"
    ).all(ctxMatch[1]);
    return json({ task, comments, dependencies: { blocked_by: blockedBy, blocking }, children, recent_activity: recentActivity });
  }

  // GET /api/tasks/dep-summary — 批量依赖+子任务计数
  if (path === "/api/tasks/dep-summary" && req.method === "GET") {
    const projectId = url.searchParams.get("project_id") || "default";
    // 阻塞计数：每个任务被多少个未完成的依赖阻塞
    const blocked = db.query(
      `SELECT d.task_id as id, COUNT(*) as count
       FROM task_dependencies d JOIN tasks dep ON d.depends_on_id = dep.id
       WHERE dep.status != 'done'
       GROUP BY d.task_id`
    ).all() as any[];
    // 阻塞中计数：每个任务阻塞了多少个未完成的任务
    const blocking = db.query(
      `SELECT d.depends_on_id as id, COUNT(*) as count
       FROM task_dependencies d JOIN tasks t ON d.task_id = t.id
       WHERE t.status != 'done'
       GROUP BY d.depends_on_id`
    ).all() as any[];
    // 子任务计数
    const children = db.query(
      `SELECT parent_id as id, COUNT(*) as count
       FROM tasks WHERE parent_id IS NOT NULL AND project_id = ?
       GROUP BY parent_id`
    ).all(projectId) as any[];
    const map: Record<string, any> = {};
    const allIds = new Set([...blocked.map(r=>r.id), ...blocking.map(r=>r.id), ...children.map(r=>r.id)]);
    for (const id of allIds) {
      map[id] = {
        blocked: Number(blocked.find(r=>r.id===id)?.count||0),
        blocking: Number(blocking.find(r=>r.id===id)?.count||0),
        children: Number(children.find(r=>r.id===id)?.count||0)
      };
    }
    return json(map);
  }

  // GET /api/projects
  if (path === "/api/projects" && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const showArchived = url.searchParams.get("archived") === "1";
    const sql = showArchived
      ? "SELECT * FROM projects WHERE archived_at IS NOT NULL ORDER BY archived_at DESC"
      : "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC";
    const projects = db.query(sql).all();
    return json(projects);
  }

  // POST /api/projects
  if (path === "/api/projects" && req.method === "POST") {
    try {
      const body = await req.json();
      checkTextField(body.name, "name");
      if (!body.name) return json({ error: "项目名称必填" }, 400);
      const id = newId();
      db.run(
        "INSERT INTO projects (id, name, description, color) VALUES (?, ?, ?, ?)",
        [id, body.name, body.description || null, body.color || "#6366f1"]
      );
      const project = db.query("SELECT * FROM projects WHERE id = ?").get(id);
      return json(project, 201);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // PATCH /api/projects/:id
  if (path.startsWith("/api/projects/") && req.method === "PATCH") {
    try {
      const pid = path.split("/").pop()!;
      const body = await req.json();
      const fields: string[] = [];
      const bindings: any[] = [];
      const updatable = ["name", "description", "color"];
      for (const f of updatable) {
        if (body[f] !== undefined) { fields.push(`${f} = ?`); bindings.push(body[f]); }
      }
      if (fields.length === 0) return json({ error: "无更新字段" }, 400);
      fields.push("updated_at = ?");
      bindings.push(now());
      bindings.push(pid);
      db.run(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`, bindings);
      const project = db.query("SELECT * FROM projects WHERE id = ?").get(pid);
      return json(project);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  }

  // POST /api/projects/:id/archive
  if (path.match(/^\/api\/projects\/[^/]+\/archive$/) && req.method === "POST") {
    try {
      const pid = path.split("/")[3];
      const project = db.query("SELECT * FROM projects WHERE id = ?").get(pid) as any;
      if (!project) return json({ error: "项目不存在" }, 404);
      if (project.archived_at) return json({ error: "项目已归档" }, 400);
      const n = now();
      db.run("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?", [n, n, pid]);
      return json({ ...project, archived_at: n, updated_at: n });
    } catch (e: any) { return json({ error: e.message }, 400); }
  }

  // POST /api/projects/:id/unarchive
  if (path.match(/^\/api\/projects\/[^/]+\/unarchive$/) && req.method === "POST") {
    try {
      const pid = path.split("/")[3];
      const project = db.query("SELECT * FROM projects WHERE id = ?").get(pid) as any;
      if (!project) return json({ error: "项目不存在" }, 404);
      if (!project.archived_at) return json({ error: "项目未归档" }, 400);
      db.run("UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?", [now(), pid]);
      return json({ ...project, archived_at: null, updated_at: now() });
    } catch (e: any) { return json({ error: e.message }, 400); }
  }

  // Static files
  let filePath = path === "/" ? "/standalone-kanban.html" : path;
  const staticRes = serveFile(filePath);
  if (staticRes) return staticRes;
  const fallback = serveFile("/standalone-kanban.html");
  if (fallback) return fallback;

  return new Response("Not Found", { status: 404 });
}

// ── 启动 ──────────────────────────────────────────────────

// HTTP 服务：端口冲突时不崩溃，仅降级
let httpServer: any = null;
try {
  httpServer = Bun.serve({ port: PORT, fetch: handleHTTP });
  console.error(`[TaskBoard] HTTP server → http://localhost:${PORT}`);
} catch (e: any) {
  console.error(`[TaskBoard] HTTP server failed (port ${PORT} in use?): ${e.message}`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[TaskBoard] MCP server → stdio (ready)`);

// 自动备份：启动时执行一次，之后每 6 小时执行
ensureBackupDir();
try { const r = performBackup(); console.error(`[TaskBoard] ${r}`); } catch (e: any) { console.error(`[TaskBoard] Backup failed: ${e.message}`); }
setInterval(() => {
  try { const r = performBackup(); console.error(`[TaskBoard] ${r}`); } catch {}
}, 6 * 60 * 60 * 1000);

// 防止 Bun 过早退出
process.on("SIGINT", () => {
  if (httpServer) httpServer.stop();
  db.close();
  process.exit(0);
});

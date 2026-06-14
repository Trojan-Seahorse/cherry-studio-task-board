-- Cherry Studio 任务看板 · 数据库 Schema
-- Phase 1: 核心骨架

CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    color       TEXT DEFAULT '#6366f1',
    created_at  TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL DEFAULT 'default',
    title         TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'backlog'
                  CHECK(status IN ('backlog','todo','in-progress','done')),
    priority      INTEGER DEFAULT 0,
    start_date    TEXT,
    due_date      TEXT,
    completed_at  TEXT,
    sort_order    REAL DEFAULT 0.0,
    parent_id     TEXT,
    skill_name    TEXT,
    assigned_to   TEXT,
    progress      INTEGER DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
    tags          TEXT DEFAULT '[]',
    created_by    TEXT DEFAULT 'human',
    created_at    TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at    TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id           TEXT NOT NULL,
    depends_on_id     TEXT NOT NULL,
    dependency_type   TEXT DEFAULT 'blocks',
    created_at        TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_id) REFERENCES tasks(id) ON DELETE CASCADE,
    UNIQUE(task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS activity_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    action      TEXT NOT NULL,
    field       TEXT,
    old_value   TEXT,
    new_value   TEXT,
    actor       TEXT DEFAULT 'system',
    created_at  TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    content     TEXT NOT NULL,
    author      TEXT DEFAULT 'human',
    created_at  TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- 默认项目
INSERT OR IGNORE INTO projects (id, name, description) VALUES ('default', '默认项目', 'Cherry Studio 任务看板默认项目');

-- 索引
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_activity_task ON activity_log(task_id);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);

/**
 * 数据库完整性验证
 * 用法: bun run verify-db.ts
 */

import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.TASK_BOARD_DB || join(__dirname, "..", "data", "tasks.db");

const db = new Database(DB_PATH);

console.log("═══ 数据库完整性验证 ═══\n");
console.log(`路径: ${DB_PATH}\n`);

// Tables
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[];
console.log(`表数量: ${tables.length}`);
tables.forEach((t: any) => {
  const count = (db.query(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as any).c;
  console.log(`  ${t.name}: ${count} 行`);
});

// Tasks by status
console.log("\n— 任务分布 —");
const byStatus = db.query("SELECT status, COUNT(*) as c FROM tasks GROUP BY status").all() as any[];
byStatus.forEach((r: any) => console.log(`  ${r.status}: ${r.c}`));

// Tasks with dates
const withDates = (db.query("SELECT COUNT(*) as c FROM tasks WHERE start_date IS NOT NULL OR due_date IS NOT NULL").get() as any).c;
console.log(`\n带日期的任务: ${withDates}`);

// Integrity check
const integrity = db.query("PRAGMA integrity_check").get() as any;
console.log(`\n完整性检查: ${integrity.integrity_check}`);

db.close();
console.log("\n✅ 验证完成");

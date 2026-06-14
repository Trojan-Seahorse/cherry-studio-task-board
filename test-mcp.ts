/**
 * MCP 工具测试 — 验证 create_task / list_tasks / move_task
 * 用法: bun run test-mcp.ts
 */

const API = "http://localhost:17850/api/tasks";

interface Task {
  id: string;
  title: string;
  status: string;
  priority: number;
  due_date: string | null;
  progress: number;
}

async function api(path: string, method = "GET", body?: any) {
  const opts: any = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}

async function main() {
  console.log("═══ Task Board MCP Test ═══\n");

  // 1. List existing tasks
  console.log("1. 列出所有任务:");
  const before = await api(API + "?status=all");
  console.log(`   共 ${before.length} 条\n`);

  // 2. Create a test task
  console.log("2. 创建测试任务:");
  const created = await api(API, "POST", {
    title: "测试: MCP 集成验证",
    status: "todo",
    priority: 4,
    description: "验证 create_task → list_tasks → move_task 全流程",
    due_date: "2026-06-20",
    tags: "test,mcp",
  });
  console.log(`   ID: ${created.id}`);
  console.log(`   标题: ${created.title}`);
  console.log(`   状态: ${created.status}\n`);

  // 3. Move to in-progress
  console.log("3. 移动到 In Progress:");
  const moved = await api(API + "/" + created.id, "PATCH", { status: "in-progress" });
  console.log(`   状态: ${moved.status}\n`);

  // 4. Update progress
  console.log("4. 更新进度到 50%:");
  const updated = await api(API + "/" + created.id, "PATCH", { progress: 50 });
  console.log(`   进度: ${updated.progress}%\n`);

  // 5. Move to done
  console.log("5. 移动到 Done:");
  const done = await api(API + "/" + created.id, "PATCH", { status: "done" });
  console.log(`   状态: ${done.status}`);
  console.log(`   进度: ${done.progress}%`);
  console.log(`   完成时间: ${done.completed_at}\n`);

  // 6. Cleanup
  console.log("6. 删除测试任务:");
  await api(API + "/" + created.id, "DELETE");
  console.log("   已删除\n");

  // 7. Verify
  console.log("7. 验证 — 当前任务数:");
  const after = await api(API + "?status=all");
  console.log(`   共 ${after.length} 条`);

  if (after.length === before.length) {
    console.log("\n✅ 所有测试通过!");
  } else {
    console.log(`\n⚠ 任务数不一致 (before=${before.length}, after=${after.length})`);
  }
}

main().catch(e => {
  console.error("测试失败:", e.message);
  process.exit(1);
});

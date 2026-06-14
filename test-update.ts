/**
 * update_task / move_task 边界测试
 * 用法: bun run test-update.ts
 */

const API = "http://localhost:17850/api/tasks";

async function api(path: string, method = "GET", body?: any) {
  const opts: any = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  console.log("═══ update_task / move_task 边界测试 ═══\n");

  // Setup: create test tasks
  console.log("— 准备测试数据 —");
  const t1 = (await api(API, "POST", {
    title: "边界测试: 无日期高优先级",
    status: "backlog",
    priority: 5,
  })).data;

  const t2 = (await api(API, "POST", {
    title: "边界测试: 有日期低优先级",
    status: "todo",
    priority: 1,
    start_date: "2026-06-14",
    due_date: "2026-06-20",
    progress: 30,
  })).data;

  console.log(`  创建 t1=${t1.id} (P5, backlog)`);
  console.log(`  创建 t2=${t2.id} (P1, todo, 有日期)\n`);

  // Test 1: Update non-existent task
  console.log("— 测试 1: 更新不存在的任务 —");
  const r1 = await api(API + "/nonexistent", "PATCH", { title: "xxx" });
  console.log(`  Status ${r1.status}: ${r1.data.error}\n`);

  // Test 2: Update multiple fields at once
  console.log("— 测试 2: 批量更新字段 —");
  const r2 = await api(API + "/" + t1.id, "PATCH", {
    title: "边界测试: 已更新标题",
    priority: 3,
    description: "批量更新测试说明",
    assigned_to: "测试员",
  });
  const u1 = r2.data;
  console.log(`  标题: ${u1.title}`);
  console.log(`  优先级: ${u1.priority}`);
  console.log(`  负责人: ${u1.assigned_to}\n`);

  // Test 3: Move to done auto-completes
  console.log("— 测试 3: 移到 done 自动完成 —");
  const r3 = await api(API + "/" + t2.id, "PATCH", { status: "done" });
  const u2 = r3.data;
  console.log(`  状态: ${u2.status}`);
  console.log(`  进度: ${u2.progress}% (应为 100)`);
  console.log(`  完成时间: ${u2.completed_at}`);
  console.log(`  ${u2.progress === 100 ? "✅ 自动设 100%" : "❌ 进度未自动设置"}\n`);

  // Test 4: Progress boundary
  console.log("— 测试 4: 进度边界值 —");
  const r4a = await api(API + "/" + t1.id, "PATCH", { progress: 0 });
  console.log(`  设 0%: ${r4a.data.progress}%`);
  const r4b = await api(API + "/" + t1.id, "PATCH", { progress: 100 });
  console.log(`  设 100%: ${r4b.data.progress}%\n`);

  // Test 5: Status transitions
  console.log("— 测试 5: 状态流转 —");
  for (const s of ["todo", "in-progress", "done", "backlog"]) {
    const r = await api(API + "/" + t1.id, "PATCH", { status: s });
    console.log(`  → ${s}: ${r.data.status === s ? "✅" : "❌"}`);
  }

  // Cleanup
  console.log("\n— 清理 —");
  await api(API + "/" + t1.id, "DELETE");
  await api(API + "/" + t2.id, "DELETE");
  console.log("  测试数据已删除\n");
  console.log("✅ 边界测试完成!");
}

main().catch(e => console.error("失败:", e.message));

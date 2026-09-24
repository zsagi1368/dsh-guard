#!/usr/bin/env node
/**
 * dsh-guard 自动化测试 —— 在临时目录构造模仿 DSH 结构的 fixture，
 * 不触碰真实 profile。用法：node test/run.mjs
 */
"use strict";

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
         readdirSync, rmSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = fileURLToPath(new URL("..", import.meta.url));
const GUARD = join(PROJECT, "dsh-guard.mjs");

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

/** 构造一个迷你 DSH 树 fixture，返回其 dshRoot。 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-guard-test-"));
  const profiles = join(root, "profiles");
  const web = join(profiles, "web");
  const officialAi = join(profiles, "node_modules", "@deepseek-ai");
  const webAi = join(web, "node_modules", "@deepseek-ai");
  mkdirSync(officialAi, { recursive: true });
  mkdirSync(webAi, { recursive: true });
  // 注意：不在此处创建 dsh-better-sidebar —— T1/T2 需要 true-clean；
  // double-mount 偏差在 T3 前显式制造（见下）
  // 官方层核心包（真实目录）
  for (const pkg of ["dsh-tools", "cosmokit", "schemastery"]) {
    const p = join(officialAi, pkg);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "package.json"), JSON.stringify({ name: pkg, version: "0.1.0-rc.7" }));
  }
  // profile package.json
  writeFileSync(join(web, "package.json"), JSON.stringify({ name: "dsh-profile-web", scripts: {} }));
  // cordis.patch.yml（空初始）
  writeFileSync(join(web, "cordis.patch.yml"), "# fixture\n");
  return { root, web };
}

function run(args, env = {}) {
  return spawnSync("node", [GUARD, ...args], {
    encoding: "utf8", env: { ...process.env, DSH_HOME: fixture.root, ...env } });
}

const fixture = makeFixture();
const { root, web } = fixture;
console.log(`fixture: ${root}`);

// --- T1: clean check pass ---
console.log("\nT1: clean fixture check 应通过");
let r = run(["check", "--profile", web]);
ok(r.status === 0, "clean check exit 0（无偏差）");
ok(/体检通过/.test(r.stdout), "输出含 体检通过");

// --- T2: 制造核心包重复副本（rc.6 真实目录）→ check 检出 → fix 修复 ---
console.log("\nT2: 核心包重复副本 检出+修复");
const evil = join(web, "node_modules", "@deepseek-ai", "dsh-tools");
mkdirSync(evil, { recursive: true });
writeFileSync(join(evil, "package.json"), JSON.stringify({ name: "dsh-tools", version: "0.1.0-rc.6" }));
r = run(["check", "--profile", web]);
ok(r.status === 1, "有偏差时 check exit 1");
ok(/dsh-tools/.test(r.stdout), "报告 dsh-tools 偏差");
r = run(["fix", "--profile", web]);
ok(r.status === 0, "fix exit 0");
ok(/修复: dsh-tools/.test(r.stdout), "执行了 junction 修复");
// 修复后应是 junction/symlink
ok(lstatSync(evil).isSymbolicLink(), "修复后 dsh-tools 是 symlink/junction");
// 备份落在 <web>/.dsh-guard-backup/<ts>/{pkg-...} 下（backupDir 含 ts 层）
const backups = readdirSync(join(web, ".dsh-guard-backup"));
const nested = backups.flatMap(b => readdirSync(join(web, ".dsh-guard-backup", b)));
ok(nested.some(n => n.includes("pkg-dsh-tools")), "生成了 pkg-dsh-tools 备份");
// 幂等
r = run(["fix", "--profile", web]);
ok(/无需修复/.test(r.stdout), "二次 fix 幂等（无需修复）");

// --- T3: double-mount → check 检出 → fix 补 disabled ---
console.log("\nT3: double-mount 守护");
// 制造偏差：安装 dsh-better-sidebar（模拟已单独安装），且 profile 层无禁用
mkdirSync(join(web, "node_modules", "dsh-better-sidebar"), { recursive: true });
writeFileSync(join(web, "node_modules", "dsh-better-sidebar", "package.json"),
  JSON.stringify({ name: "dsh-better-sidebar", version: "0.13.0" }));
// 手动移除 profile 层已加的禁用（回到初始态）
writeFileSync(join(web, "cordis.patch.yml"), "# fixture\n");
r = run(["check", "--profile", web]);
ok(/web-ui-better-sidebar/.test(r.stdout), "check 检出 double-mount");
r = run(["fix", "--profile", web]);
const patchText = readFileSync(join(web, "cordis.patch.yml"), "utf8");
ok(/web-ui-better-sidebar[\s\S]*disabled: true/.test(patchText), "fix 追加 disabled 块");
r = run(["fix", "--profile", web]);
ok(/无需修复/.test(r.stdout), "二次 fix 幂等");

// --- T4: patch 文件不存在时的 fix（应能新建） ---
console.log("\nT4: 无 cordis.patch.yml 时 fix 应新建并追加");
writeFileSync(join(web, "cordis.patch.yml"), "# fixture\n");
rmSync(join(web, "cordis.patch.yml"));
r = run(["fix", "--profile", web]);
ok(r.status === 0, "无 patch 文件时 fix 不崩");
ok(existsSync(join(web, "cordis.patch.yml")), "创建了 cordis.patch.yml");
ok(/disabled: true/.test(readFileSync(join(web, "cordis.patch.yml"), "utf8")), "含禁用块");

// --- T5: install / uninstall 往返 ---
console.log("\nT5: install/status/uninstall");
r = run(["install", "--profile", web]);
ok(r.status === 0, "install exit 0");
let pkg = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
ok(pkg.scripts?.prepare, "install 注册了 prepare 钩子");
r = run(["status", "--profile", web]);
ok(/prepare 钩子/.test(r.stdout), "status 显示钩子");
r = run(["uninstall", "--profile", web]);
ok(r.status === 0, "uninstall exit 0");
pkg = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
ok(!pkg.scripts?.prepare, "uninstall 移除 prepare 钩子");

// --- T6: 双副本 fixture 底稿对拍锁（TC-B4-G2，CLI 侧半面） ---
// 共享底稿设计（两仓共享设计不共享代码）：
//   面 A（profile 面）= 本文件 T2 设计：profiles/web/node_modules/@deepseek-ai/dsh-tools
//     真实目录 rc.6 + 官方层 rc.7（双物理副本）。
//   面 B（治理存储区面）= sandbox-b0/probe-npm-dual-copy.spec.mts 底稿：
//     installed/demo/trojan（两级权威布局，plugin-governance-host npmInstallDir）内嵌
//     @deepseek-ai/dsh-client-store 9.9.9-fake-tc-b0 真实目录（FAKE_STORE_PKG 同形）。
// 对拍锁语义：同底稿上 CLI check 必红并报同判据（两面路径清单可查询）⟺ 内核
//   SymbolIsolationCheck 必 CheckFailed（G1 A-1.2.1/C1）。内核侧半面留位=G1 收卡后
//   主线补跑（方法见战役回执 RECEIPT-G2-progress.md §6）。红→绿可重放：check 红 →
//   fix → check 绿 → 幂等。
console.log("\nT6: 双副本 fixture 底稿对拍锁（check 红 → fix → check 绿可重放）");
const root6 = mkdtempSync(join(tmpdir(), "dsh-guard-test-"));
const web6 = join(root6, "profiles", "web");
const trojanAi6 = join(root6, "zdsh", "installed", "demo", "trojan", "node_modules", "@deepseek-ai", "dsh-client-store");
const trojan2Ai6 = join(root6, "zdsh", "installed", "demo", "trojan2", "node_modules", "@deepseek-ai", "dsh-client-store");
{
  // 面 A：profile 双副本
  const officialAi6 = join(root6, "profiles", "node_modules", "@deepseek-ai", "dsh-tools");
  mkdirSync(officialAi6, { recursive: true });
  writeFileSync(join(officialAi6, "package.json"), JSON.stringify({ name: "dsh-tools", version: "0.1.0-rc.7" }));
  mkdirSync(join(web6, "node_modules", "@deepseek-ai", "dsh-tools"), { recursive: true });
  writeFileSync(join(web6, "node_modules", "@deepseek-ai", "dsh-tools", "package.json"),
    JSON.stringify({ name: "dsh-tools", version: "0.1.0-rc.6" }));
  writeFileSync(join(web6, "package.json"), JSON.stringify({ name: "dsh-profile-web", scripts: {} }));
  // 面 B：治理存储区物理副本（DSH_HOME 已设 → 镜像链派生 <DSH_HOME>/zdsh）
  mkdirSync(trojanAi6, { recursive: true });
  writeFileSync(join(trojanAi6, "package.json"), JSON.stringify({
    name: "@deepseek-ai/dsh-client-store", version: "9.9.9-fake-tc-b0", type: "module", main: "index.js" }));
  writeFileSync(join(trojanAi6, "index.js"), "export const marker = 'FAKE'\n");
  writeFileSync(join(root6, "zdsh", "installed", "demo", "trojan", "package.json"),
    JSON.stringify({ name: "@demo/trojan", version: "1.0.0" }));
  // 面 B 边界：同名核心包副本出现在第二个插件树（备份目录防冲突锁）
  mkdirSync(trojan2Ai6, { recursive: true });
  writeFileSync(join(trojan2Ai6, "package.json"), JSON.stringify({
    name: "@deepseek-ai/dsh-client-store", version: "9.9.9-fake-tc-b0" }));
  writeFileSync(join(root6, "zdsh", "installed", "demo", "trojan2", "package.json"),
    JSON.stringify({ name: "@demo/trojan2", version: "1.0.0" }));
}
r = run(["check", "--profile", web6], { DSH_HOME: root6 });
ok(r.status === 1, "底稿 check exit 1（双面副本检出=内核 CheckFailed 同判据）");
ok(/dsh-tools/.test(r.stdout) && /0\.1\.0-rc\.6/.test(r.stdout), "判据报告含 profile 面 dsh-tools rc.6 真实副本");
ok(/dsh-client-store/.test(r.stdout) && /9\.9\.9-fake-tc-b0/.test(r.stdout), "判据报告含存储区面 dsh-client-store fake 副本");
ok(/installed[\\/]demo[\\/]trojan/.test(r.stdout), "判据报告含存储区路径清单（detail 可查询）");
r = run(["fix", "--profile", web6], { DSH_HOME: root6 });
ok(r.status === 0, "fix exit 0（两面修复：junction + 备份改名移出）");
r = run(["check", "--profile", web6], { DSH_HOME: root6 });
ok(r.status === 0 && /体检通过/.test(r.stdout), "fix 后 check 绿（红→绿可重放）");
ok(lstatSync(join(web6, "node_modules", "@deepseek-ai", "dsh-tools")).isSymbolicLink(), "profile 面修复为 junction/symlink");
ok(!existsSync(trojanAi6), "存储区面副本已改名移出（非删除）");
ok(!existsSync(trojan2Ai6), "第二插件树同名副本也已移出（备份目录无冲突）");
ok(existsSync(join(root6, "zdsh", ".dsh-guard-backup")), "存储区备份落 <storageRoot>/.dsh-guard-backup");
r = run(["fix", "--profile", web6], { DSH_HOME: root6 });
ok(/无需修复/.test(r.stdout), "底稿修复后二次 fix 幂等（备份区不回扫）");
rmSync(root6, { recursive: true, force: true });

// --- T7: 0.1.5 时代三解析面无误杀（A-1.2.2 带外半面；tmpdir 仿形自建自收） ---
// 面 1 树内（pnpm workspace 形：@deepseek-ai/* 全 symlink → .pnpm 真实实例；主仓实测
//   根 node_modules/@deepseek-ai 仅 workspace symlink、CORE_BUNDLES 零真实目录）；
// 面 2 发布安装 node 运行时（~/.dsh profile 形：profile 层核心包 junction → 官方层；
//   本机实测 web/node_modules/@deepseek-ai 缺席=同绿）；
// 面 3 治理存储区安装（~/.dsh-zdsh 形：出厂集 peer 纪律=installed 树无 @deepseek-ai
//   真实目录；链接形核心包不误杀；DSH_BRANCH_HOME 显式覆盖=内核权威链优先级 1）。
console.log("\nT7: 三解析面 fixture check 全绿（无误杀）");
const root7 = mkdtempSync(join(tmpdir(), "dsh-guard-test-"));
{
  // 面 1：树内 pnpm workspace 仿形
  const tree7 = join(root7, "intree");
  const pnpmReal = join(tree7, "node_modules", ".pnpm", "cosmokit@0.1.0-rc.7", "node_modules", "@deepseek-ai", "cosmokit");
  mkdirSync(pnpmReal, { recursive: true });
  writeFileSync(join(pnpmReal, "package.json"), JSON.stringify({ name: "cosmokit", version: "0.1.0-rc.7" }));
  mkdirSync(join(tree7, "node_modules", "@deepseek-ai"), { recursive: true });
  symlinkSync(pnpmReal, join(tree7, "node_modules", "@deepseek-ai", "cosmokit"), "junction");
  writeFileSync(join(tree7, "package.json"), JSON.stringify({ name: "zdsh-intree-mock", private: true }));
  // 面 2：发布安装 profile 仿形（junction → 官方层）
  const rel7 = join(root7, "release", "profiles");
  mkdirSync(join(rel7, "node_modules", "@deepseek-ai", "dsh-tools"), { recursive: true });
  writeFileSync(join(rel7, "node_modules", "@deepseek-ai", "dsh-tools", "package.json"),
    JSON.stringify({ name: "dsh-tools", version: "0.1.0-rc.7" }));
  const web7 = join(rel7, "web");
  mkdirSync(join(web7, "node_modules", "@deepseek-ai"), { recursive: true });
  symlinkSync(join(rel7, "node_modules", "@deepseek-ai", "dsh-tools"),
    join(web7, "node_modules", "@deepseek-ai", "dsh-tools"), "junction");
  writeFileSync(join(web7, "package.json"), JSON.stringify({ name: "dsh-profile-web", scripts: {} }));
  writeFileSync(join(web7, "cordis.patch.yml"), "[]\n");
  // 面 3：治理存储区 peer-clean 仿形（symlink 形核心包 + 普通依赖真实目录）
  const st7 = join(root7, "storage", "zdsh");
  const omni7 = join(st7, "installed", "zdsh", "omnivision");
  mkdirSync(join(omni7, "node_modules", "some-dep"), { recursive: true });
  writeFileSync(join(omni7, "package.json"), JSON.stringify({ name: "@zdsh/omnivision", version: "0.1.0" }));
  const vert7 = join(st7, "installed", "zdsh", "verticals");
  mkdirSync(join(vert7, "node_modules", "@deepseek-ai"), { recursive: true });
  mkdirSync(join(root7, "storage", "host-nm", "@deepseek-ai", "cordis"), { recursive: true });
  symlinkSync(join(root7, "storage", "host-nm", "@deepseek-ai", "cordis"),
    join(vert7, "node_modules", "@deepseek-ai", "cordis"), "junction");
  writeFileSync(join(vert7, "package.json"), JSON.stringify({ name: "@zdsh/verticals", version: "0.1.0" }));
}
r = run(["check", "--profile", join(root7, "intree")], { DSH_HOME: root7 });
ok(r.status === 0 && /体检通过/.test(r.stdout), "面1 树内 workspace（symlink→.pnpm 真实实例）不误杀");
r = run(["check", "--profile", join(root7, "release", "profiles", "web")], { DSH_HOME: join(root7, "release") });
ok(r.status === 0 && /体检通过/.test(r.stdout), "面2 发布安装 profile（junction→官方层）不误杀");
r = run(["check", "--profile", join(root7, "release", "profiles", "web")],
  { DSH_HOME: join(root7, "release"), DSH_BRANCH_HOME: join(root7, "storage", "zdsh") });
ok(r.status === 0 && /体检通过/.test(r.stdout), "面3 治理存储区（peer-clean+链接形核心包）不误杀");
rmSync(root7, { recursive: true, force: true });

// --- 清理 ---
rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);

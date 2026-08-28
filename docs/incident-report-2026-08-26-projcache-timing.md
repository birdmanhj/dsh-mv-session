# 整改报告:改名迁移后会话加载超时(projcache 时序缺陷)

> 报告编号:DSH-MV-2026-0826-01
> 受影响版本:0.1.1(及之前)
> 涉及事故:2 次生产迁移(2026-08-26)
> 报告方:vibe-workshop 工作区管理会话(management-kb)
> 整改归属:DSH-mv-session 维护会话
> 状态:**已整改(0.1.2,2026-08-28)** —— R1-R4 全部落地,见 §6 整改记录与 CHANGELOG 0.1.2

---

## 1. 事故记录

2026-08-26 当天两次使用本插件改名迁移后,均出现相同故障:

| # | 迁移 | 现象 |
|---|---|---|
| 1 | `hello-deepseek-harness` → `DSH-hello-deepseek-harness`(9 会话) | 重启后所有会话历史加载失败:`signal timed out (internal)` |
| 2 | `composable-embodied-intelligence` → `DSH-modular-robot-lab` | 同上 |

两次均由外部应急脚本(见附录 A)在停服状态下对齐 `session_projcache.json` 后恢复。

## 2. 根因分析(三层)

### 2.1 时序缺陷(主因):活进程写回覆盖了工具刚落盘的修复

- 本插件以**工具形式运行在存活的 dsh 进程内**(工具自身无法重启 dsh,协议是"迁移后用户重启一次");
- 投影缓存(`dsh-session-projection-cache`)是 **整记录替换式**写盘:`checkpointIdentity = { createdAt, cwd }`,每次 checkpoint 写回按"whole-value discipline"整条替换记录;storage 域每次更新把内存快照持久化;
- 迁移期间,**运行迁移工具的那个会话本身仍然存活**并持续产生 checkpoint → 活进程把**内存里的旧 identity** 重新落盘,覆盖了工具刚写好的 projcache 修复;
- 重启后 `identityMatches(record.identity, header)` 永远 false → 缓存整条被判定 `unrelated log identity` 丢弃 → 冷读退化为 `readFrom(id, 0)` **全量重放** → 大日志(实测存在 44948 帧的会话)在超时窗口内重放不完 → 加载超时 `signal timed out (internal)`。

**实证**:hello-deepseek-harness 迁移日志显示 `update_projcache_cwd` 步骤执行了 9 次,而随后 `--verify` 仍报 9 条 `projcache cwd stale`——写入与验证之间唯一能改这个文件的写者就是活进程本身。

### 2.2 验证缺陷:致命问题被降级为"无害" warning

`verifyHome()` 将 projcache 不一致明确标注为无害:

```js
// lib/migrate_session.js:437-441(同 packages/dsh-mv-session/lib/migrate_session.cjs)
warnings.push('projcache cwd stale for ' + s.sid + ' (' + entry.identity.cwd
  + ') — self-heals via cold rebuild on read, harmless');
```

"自愈"假设不成立:自愈的方式是**丢弃缓存 + 全量重放**,对大会话的代价正是超时。函数头注释(第 390-397 行)同样宣称 "A stale cache cwd … is reported as a WARNING (both are harmless and self-healing)"——需要一并改写。

### 2.3 验收缺陷:只验文件一致性,没有可用性冒烟

`--verify` 检查四层文件一致,但从不实际打开一个会话。若有"冷读冒烟"(打开最大会话确认无 timeout),两次事故都能在用户启动 dsh 前被发现。

## 3. 整改要求(按优先级)

- **R1(必修,验证升级)**:`projcache cwd stale`(及 `createdAt` 不一致)从 warning 升级为 **problem**;`--verify` 的 `ok` 必须要求 header cwd 与 projcache identity **全对齐**。
- **R2(必修,时序强制)**:迁移的 projcache 写入必须在 **dsh 停止状态**下完成。落地方式(择一或组合):
  - preflight 检测 dsh web 进程存活,存活时**拒绝实跑**(或强制 dry-run);
  - 把 projcache 对齐拆成可单独重跑的幂等子命令(如 `--fix-projcache`),协议改为:**停服 → 迁移 → `--fix-projcache` → 启动 → 删 symlink → verify**;
  - 工具输出的"剩余人工步骤"中,把"停服后重跑 projcache 对齐"列为必做项,而不是可选项。
- **R3(必修,验收冒烟)**:verify 增加可用性检查:对会话中帧数最多的日志,做 header↔projcache identity 双查,并在人工步骤中要求"启动后打开最大会话确认无 `signal timed out`"。
- **R4(建议,回归测试)**:新增回归用例覆盖本缺陷——迁移期间模拟一次活进程 checkpoint 写回(或至少断言 verify 对 stale projcache 必须失败);用 44948 帧级大日志做冷读冒烟。

## 4. 验收标准(Definition of Done)

1. 迁移全流程可在停服窗口内完成并保证 projcache 与 header 全对齐;
2. `--verify` 对 stale projcache 报 **problem** 且整体 `ok=false`;
3. 迁移后冷读冒烟(打开最大会话)无超时;
4. 两次历史事故的场景可通过回归测试复现"修复前失败/修复后通过"。

## 5. 关联沉淀

- `management-kb/01-rules.md` §9「改名迁移纪律」(2026-08-26 定稿):停服窗口内迁移、三层同时对齐、冷读冒烟验收、stale 一律视为缺陷;
- `management-kb/02-experience.md`「2026-08-26 两次改名迁移后会话加载全部超时」条目;
- 整改完成后请:更新 `CHANGELOG.md`、回写 management-kb 好实践条目(移除 ⚠️ 警示)、并跑通本报告 §3 的回归用例。

---

## 附录 A:应急修复脚本(已两次救场,供整改实现参考)

以 session header 帧的 `cwd`/`createdAt` 为权威,对齐 projcache identity,删除无 header 的孤儿记录;先备份、可回退。核心逻辑:

```js
// 1. 备份 session_projcache.json
// 2. 遍历 ~/.dsh/sessions 下所有 session.jsonl.zstd,解压首帧取 header,
//    得到每个会话的权威 { cwd, createdAt }
// 3. 对 projcache 每条记录:
//    - 无对应 header 的孤儿记录 → 删除
//    - identity.cwd/createdAt 与 header 不一致 → 以 header 为准对齐
// 4. 写回(2 空格缩进 + 末尾换行)
```

关键点:必须在 **dsh 停止后**运行,否则活进程 checkpoint 写回会再次覆盖。

## 附录 B:证据代码位置索引

| 位置 | 内容 |
|---|---|
| `lib/migrate_session.js:584-586` | 迁移计划中的 `update_projcache_cwd` 步骤 |
| `lib/migrate_session.js:692-697` | 该步骤的实现(只改 `identity.cwd`,不校验 `createdAt`) |
| `lib/migrate_session.js:390-397` | verifyHome 注释:宣称 stale projcache "harmless and self-healing" |
| `lib/migrate_session.js:437-441` | stale projcache 降级为 warning 的判断 |
| `packages/dsh-mv-session/lib/migrate_session.cjs` | 上述代码的发布副本(同样需要修) |
| `dsh-session-projection-cache`(DSH 包) | `checkpointIdentity={createdAt,cwd}`;`identityMatches` 不匹配即丢弃整条记录 |

## 6. 整改记录(2026-08-28,0.1.2)

- **R1** ✅ `verifyHome()`:projcache identity 缺失/不一致(cwd 或 createdAt)升级为 **problem**,
  `ok` 要求 header 与缓存全对齐;函数注释与 FAQ 同步改写(不再宣称"harmless and self-healing")。
- **R2** ✅ 时序强制:迁移不再写 projcache(移除 `update_projcache_cwd` 步骤及空会话清理中的
  projcache 删除);新增幂等子命令 `--fix-projcache`(header 权威对齐 cwd+createdAt + 孤儿清理,
  先备份),活进程检测(lsof 3080 / pgrep "dsh web")下**拒绝执行**,`--force` 例外;
  `manual_remaining` 将"停服 → fix → 启动"列为必做步骤。协议更新:
  **演练 → 实跑 → 停服 → `--fix-projcache` → 启动 → 冷读冒烟 → 删 symlink → verify**。
- **R3** ✅ verify 增加可用性验收:报告最大会话(帧数)并输出 `manualChecks`——
  "启动后打开最大会话确认无 signal timed out";header↔projcache 双查覆盖 cwd+createdAt。
- **R4** ✅ 回归测试 `tests/migrate_projcache_timing.js`:45000 帧大日志 × (迁移 → 模拟活进程
  写回 → verify 必失败 → `--fix-projcache` 对齐 → verify 全绿 → 全量冷读冒烟 <30s);
  另覆盖活进程守卫拒绝、幂等重跑;`migrate_edge_cases.js`/`migrate_e2e_scratch.js` 断言同步更新。
- **验收标准**(§4)逐项达成:停服窗口内可保证全对齐、verify 对 stale 报 problem 且 ok=false、
  冷读冒烟无超时、事故场景"修复前失败/修复后通过"可复现。

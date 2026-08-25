# DSH-mv-session

把 DSH 会话/工作区迁移（改名、改项目名、改路径）做成插件。

**输入**：原会话（sessionId 或当前工作区路径）→ 新路径 / 新名称
**输出**：自动执行 DSH 管理更新（会话日志 header、sessions 目录、workspace 注册表、投影缓存、
过渡 symlink），并报告剩余人工步骤（重启 dsh web、删除 symlink、回滚方式）。

## 背景：手工迁移一次要做的事（2026-08-24 实战验证）

目录重命名后 DSH 不会自动迁移会话，会出现：旧会话仍绑旧路径（工具 cwd 失效 ENOENT）、
DSH 自动为新路径创建空工作区 + 空会话。完整迁移需要修改 4 处持久化状态 + 磁盘目录，
详见 [docs/dsh-session-migration-internals.md](docs/dsh-session-migration-internals.md)
（含命名编码、zstd 帧不变式、进程内存行为、风险清单、源码位置）。

**zstd 帧不变式（2026-08-24 boot 崩溃教训，插件核心保证）**：`session.jsonl.zstd` 是多帧流，
第 0 帧必须恰好一行 header，否则 `dsh web` 启动即崩（"first frame is not exactly one header line"）。
本脚本只重写第 0 帧、其余帧字节不动；遇到历史塌缩单帧日志自动修复为每行一帧；写盘前按
boot 同款断言自检（详见 internals §2.5 与 `tests/migrate_e2e_scratch.js`）。

## 当前进度

- [x] `docs/dsh-session-migration-internals.md` —— 迁移内部机制全记录（新会话必读，含 §2.5 帧不变式）
- [x] `lib/migrate_session.js` —— 零依赖核心迁移脚本（dry-run / 备份 / 帧安全重写 / 合并目录 / 自动清理空会话）
- [x] `docs/queued-migrations.md` —— 用户已排队的真实迁移任务（含前置条件与注意事项）
- [x] 动态 Cordis 插件封装（Host 工具 `mv_session`，插件 id `mvsess-1`，Package `pkg-4`）
- [x] 端到端测试（真实迁移 `mv-test-old → mv-test-new`；两次重启验证均通过：GUI 列表仅新路径、
      历史完整、工具 cwd 正常、无空会话残留、删除过渡 symlink 后无异常）
- [x] 回归测试：`tests/migrate_e2e_scratch.js`（帧不变式 + 真实 `dsh web` boot 验证）与
      `tests/migrate_edge_cases.js`（合并路径 / from 为 symlink / 无 zstd CLI / `--session` 模式）
- [x] 正式插件包：`packages/dsh-mv-session/`（cordis.patch.yml + npm 形态），
      已通过 `dsh plugin --profile web add` 安装进 web profile（`dsh.profile.bundles` 已含
      `dsh-mv-session`，重启后跨会话可见、跨重启持久）
- [x] 执行排队任务 1：`DSH_wechat_article_downloader` → `DSH-wechat-article-downloader`
      （4583 帧真实会话最小 diff 重写；注册表归一化、空会话与陈旧 wchat 记录/symlink 清理；
      重启后 GUI 确认新工作区与完整历史；过渡 symlink 已删；`--verify` 校验闭环）
- [x] 遗留清理：mv-test 测试工作区、workspace.json.pre-mvtest 备份已删除
- [x] 文档化：`docs/user-manual.md`（使用说明书）、`docs/publishing.md`（发布指南）
- [x] git 版本管理：已推送 [github.com/birdmanhj/dsh-mv-session](https://github.com/birdmanhj/dsh-mv-session)（main + v0.1.0 标签；.gitignore/LICENSE/CHANGELOG 就绪）
- [x] 分发级补强：`--verify` 只读校验（替代第二次重启）、变更前预检（坏日志零改动中止）、
      from/to 同目录守卫、manual 行附闭环校验命令、工具新增 `verify` 参数、包 README 分发化

## 核心脚本用法

```bash
# 演练（不写任何东西；目标目录不存在时加 --mkdir 才允许规划）
node lib/migrate_session.js --from /path/old --to /path/new --title "New Name" --mkdir --dry-run

# 实跑（先备份再执行；--mkdir 允许创建目标目录）
node lib/migrate_session.js --from /path/old --to /path/new --title "New Name" --mkdir --yes

# 目标目录已存在且非空：默认拒绝，加 --merge-dir 显式合并（先查冲突）
node lib/migrate_session.js --from /path/old --to /path/existing --merge-dir --yes

# 按会话 id 定位（自动找到它的 cwd）
node lib/migrate_session.js --session session-xxxx --to /path/new --title "New Name" --dry-run

# 回归测试
node tests/migrate_e2e_scratch.js [真实会话日志] --boot   # 帧不变式 + 真实 dsh web boot
node tests/migrate_edge_cases.js                          # 边界用例
```

执行顺序（脚本内部）：备份 → 建/合并目标目录 → mv 磁盘目录 → 旧路径 symlink 过渡 →
帧安全改写 session header cwd（只换第 0 帧；塌缩日志自动修复；boot 断言自检；tmp+rename 原子替换）→
移动 sessions 目录 + 旧 projectKey symlink → 更新 workspace.json（目标已有记录则合并，否则改 path/title）→
更新 projcache identity.cwd → 清理目标处自动产生的空会话 → 报告剩余人工步骤。

## 插件封装（已完成）

两层实现，工具契约一致（工具名 `mv_session`）：

1. **动态 Cordis 插件**（本会话，`mvsess-1`/`pkg-4`）：Host-only；`inject: ['shell','sandboxPolicy']`；
   `harness.defineTool` + `harness.registerTool`；execute 用 shell 服务跑 `node <工作区>/lib/migrate_session.js`
   （动态沙箱无 require/fs，脚本以子进程运行，node:zlib 原生 zstd 保证帧安全）；
   输出 `{"type":"object"}` + render 报告迁移结果与 remaining steps。
2. **正式插件包** `packages/dsh-mv-session/`：`package.json` 声明
   `dsh.bundle.patch: "./cordis.patch.yml"`，patch 插入一行 `id: mv-session, name: dsh-mv-session`；
   `lib/index.js` 是零外部 import 的 cordis 插件（`ToolDefinition.parameters` 直接用 JSON Schema，
   规避 pnpm `link:` + ESM realpath 解析问题），`ctx.effect(() => ctx.tools.register(tool))` 挂到 fiber；
   脚本以 `lib/migrate_session.cjs` 随包发布（包是 ESM，CLI 用 CJS 子进程执行）。

工具参数：`from`（旧路径，或 `session` 传 sessionId）、`to`（新路径，必填）、`title`、
`dry_run`（默认 false）、`mkdir`、`merge_dir`、`backup_dir`、`cleanup_empty`。

注意：插件**无法替宿主重启** dsh web（插件运行在宿主进程内），所以工具把
"重启 dsh web → 删除过渡 symlink"作为输出中的 remaining steps 明确返回。

## 测试清单（全部通过）

1. [x] 语法：`node --check lib/migrate_session.js`
2. [x] 真实 dry-run：对 `hello-deepseek-harness`（9 个会话）核对发现/计划步骤
3. [x] 真实迁移：`mv-test-old`（headless dsh 生成的真实会话，16 帧/42 行消息历史）→ `mv-test-new`；
      迁移后核验：帧 0 恰一行 header 且 cwd 已改、16 帧全有效、sessions 目录已移、旧 projectKey 为
      symlink、workspace.json 仅新路径、备份已落盘；scratch 场景真实 `dsh web` boot HTTP 200
4. [x] 边界：目标路径已有记录（拒绝/`--merge-dir` 合并 + 空会话清理）、from 是 symlink
      （按记录真实路径定位会话目录）、无 zstd CLI（node:zlib 原生兜底；全后端缺失时报错）、
      `--session` 定位模式

> 任务 1 收尾：重启后 GUI 已确认新工作区与完整历史、旧工作区/会话消失；两个过渡 symlink
> 已删除；`--verify` 只读校验 ok:true（仅 projcache stale 属自愈警告）——迁移闭环，无需再重启。

## 使用方法（速览）

完整说明书见 [docs/user-manual.md](docs/user-manual.md)（含"为什么必须重启一次且只需要一次"的
原理章节）。一句话：安装后重启 dsh web，在任何会话里让 Agent 执行迁移（`mv_session` 工具），
或直接跑 CLI：

```bash
dsh plugin --profile web add /path/to/packages/dsh-mv-session   # 安装（一次）
node lib/migrate_session.js --from /old --to /new --title "New" --mkdir --dry-run  # 演练
node lib/migrate_session.js --from /old --to /new --title "New" --mkdir --yes      # 实跑
# → 重启 dsh web（唯一必需）→ GUI 验证 → 删过渡 symlink
# → node lib/migrate_session.js --verify --from /new   # 只读校验替代第二次重启，闭环
```

发布（npm / GitHub / 本地 / 私服）见 [docs/publishing.md](docs/publishing.md)。

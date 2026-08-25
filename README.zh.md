# dsh-mv-session

[English](README.md) | 中文

[![GitHub tag](https://img.shields.io/github/v/tag/birdmanhj/dsh-mv-session)](https://github.com/birdmanhj/dsh-mv-session/tags)
[![npm](https://img.shields.io/npm/v/dsh-mv-session)](https://www.npmjs.com/package/dsh-mv-session)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0969da)](https://github.com/topics/dsh-plugin)

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：把 DSH 会话/工作区迁移
（改名、改项目名、改路径）做成一条工具调用 + 一次重启 + 一条校验命令。

```
安装 → 会话里说一句"把工作区 X 迁移到 Y" → 重启 dsh web（唯一一次）→ 删 symlink → verify 校验闭环
```

## 痛点：手工迁移一次会话要做的事

目录重命名后 DSH **不会**自动迁移会话，会出现：旧会话仍绑旧路径（工具 cwd 失效 ENOENT）、
DSH 自动为新路径创建**空工作区 + 空会话**、会话 header cwd / sessions 目录 / workspace 注册表 /
投影缓存四处不一致。完整迁移需要修改 4 处持久化状态 + 磁盘目录（2026-08-24 实战验证）。

**输出**：自动执行全部管理更新（含备份），并报告剩余人工步骤（重启 dsh web、删 symlink、回滚方式）。

## 帧安全（核心保证）

`session.jsonl.zstd` 是多帧 zstd 流，boot 时 DSH 要求**第 0 帧恰好一行 header**
（`assertZstdHeaderFrame`）。"整份日志解压→改第一行→整体重压"会把它塌缩成单帧，
`dsh web` 启动即崩（"first frame is not exactly one header line"，2026-08-24 实战踩坑）。
本插件只重写第 0 帧、其余帧字节不动；历史塌缩帧日志自动修复为每行一帧；
写盘前按 boot 同款断言自检 + tmp/rename 原子替换（详见
[docs/dsh-session-migration-internals.md §2.5](docs/dsh-session-migration-internals.md)）。

## 安装

```bash
dsh plugin --profile web add dsh-mv-session          # npm 发布后
dsh plugin --profile web add /path/to/packages/dsh-mv-session   # 本地/源码
# 重启 dsh web 一次，插件生效
```

## 使用（工具形态，推荐）

在任何 DSH 会话里直接说："把工作区 `/path/old` 迁移到 `/path/new`，标题改成 New Name"。
Agent 会先 `dry_run` 演练给你看计划，确认后再实跑；收尾用 `verify` 只读校验。

## 使用（CLI 形态）

```bash
node migrate_session.cjs --from /old --to /new --title "New" --mkdir --dry-run  # 1 演练
node migrate_session.cjs --from /old --to /new --title "New" --mkdir --yes      # 2 实跑（自动备份）
# 3 重启 dsh web（全程唯一必需的重启）→ GUI 确认新工作区/历史/工具 cwd
# 4 删除过渡 symlink（报告 manual 行有具体路径）
node migrate_session.cjs --verify --from /new          # 5 只读校验，闭环
```

## 为什么必须重启一次（且只需要一次）

迁移改的是磁盘，但运行中的 dsh web 持有一整套**内存态**（会话 header cwd、日志追加路径映射、
工作区注册表），重启前不读盘刷新，还会用内存旧值写回注册表/缓存。重启后进程从磁盘重建，
一切指向新路径。过渡 symlink 只服务于"迁移 → 重启"这段窗口；重启后删除即安全。

**不需要第二次重启**：删 symlink 后的确认用 `--verify`（只读）替代——核对注册表记录 ↔
会话 header cwd ↔ 帧不变式 ↔ 会话目录 ↔ 缓存，`ok:true` 即闭环；出现 problem 或 GUI 异常才再重启。
（零重启做不到：DSH 没有"在线改归属"的 API，唯一受支持的内存刷新机制就是重启。）

## 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `from` | string | 二选一 | 当前工作区路径（可为 symlink） |
| `session` | string | 二选一 | 会话 id；自动定位其工作区 |
| `to` | string | ✅ | 目标工作区路径 |
| `title` | string | — | 新标题（默认取 `to` 的 basename） |
| `dry_run` | bool | — | 只打印计划，不写任何东西 |
| `mkdir` | bool | — | 允许创建目标目录 |
| `merge_dir` | bool | — | 目标非空时显式同意合并（默认拒绝） |
| `backup_dir` | string | — | 备份位置（默认 `<dsh-home>/migration-backups/`） |
| `cleanup_empty` | bool | — | 清理目标处自动产生的空会话（默认 true） |
| `verify` | bool | — | 只读一致性校验，替代第二次重启 |

## 安全与回滚

- 变更前预检：坏日志**零改动**中止（连备份都不写）；塌缩但可修复的日志照常放行；
- 同目录守卫、tmp+rename 原子替换、每步先备份；
- 回滚 = 还原备份目录 + 反向执行一次迁移（新路径 → 旧路径）+ 重启。

## 文档

- [docs/user-manual.md](docs/user-manual.md) —— 完整说明书：原理（§5 为什么必须重启一次）、
  流程、场景、输出解读、FAQ、测试
- [docs/publishing.md](docs/publishing.md) —— 发布指南：npm / GitHub / 本地 / 私服 / 插件广场上架
- [docs/dsh-session-migration-internals.md](docs/dsh-session-migration-internals.md) —— DSH 内部机制笔记

## 开发与测试

```bash
node --check lib/migrate_session.js
node tests/migrate_e2e_scratch.js [真实会话日志] --boot   # 帧不变式 + 真实 dsh web boot 验证
node tests/migrate_edge_cases.js                          # 合并/symlink/无zstd/--session/守卫/预检
```

npm 包在 `packages/dsh-mv-session/`；包内 `lib/migrate_session.cjs` 由仓库根
`lib/migrate_session.js` 同步而来（包是 ESM，CLI 以 CJS 子进程执行）。

## 当前进度

- [x] 帧不变式修复 + 回归测试（含真实 dsh web boot 验证）
- [x] 动态 Cordis 插件封装（Host 工具 `mv_session`）
- [x] 端到端测试（真实迁移 + 两次重启验证）
- [x] 正式插件包 + `dsh plugin add` 安装 + 跨重启持久
- [x] 排队任务 1 迁移（`DSH-wechat-article-downloader`，`--verify` 闭环）
- [x] 分发级补强（`--verify`/预检/守卫/verify 参数/分发文档）
- [x] git 版本管理 + GitHub 仓库（main + v0.1.0 标签，topic: `dsh-plugin`）
- [x] npm 发布：`dsh-mv-session@0.1.0`（latest 标签，keywords 含 dsh-plugin，仓库/许可元数据齐）

## License

[MIT](LICENSE)

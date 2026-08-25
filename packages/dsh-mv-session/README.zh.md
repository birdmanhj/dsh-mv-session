# dsh-mv-session

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-mv-session)](https://www.npmjs.com/package/dsh-mv-session)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：把 DSH 会话/工作区迁移
（改名、改路径）变成一条 `mv_session` 工具调用 + 一次重启 + 一条校验命令。

```
安装 → 会话里说一句"把工作区 X 迁移到 Y" → 重启 dsh web（唯一一次）→ 删 symlink → verify 校验闭环
```

## 痛点：手工迁移一次会话要做的事

目录改名后 DSH 不会自动迁移会话：旧会话绑旧路径（工具 cwd 失效）、自动生成空工作区/空会话、
四处状态不一致。本插件一步完成（自动备份）。

## 帧安全（核心保证）

`session.jsonl.zstd` 是多帧 zstd 流，boot 时 DSH 要求**第 0 帧恰好一行 header**
（`assertZstdHeaderFrame`）。"整份日志解压→改第一行→整体重压"会把它塌缩成单帧，
`dsh web` 启动即崩（"first frame is not exactly one header line"，2026-08-24 实战踩坑）。
本插件只重写第 0 帧、其余帧字节不动；历史塌缩帧日志自动修复为每行一帧；
写盘前按 boot 同款断言自检 + tmp/rename 原子替换。

## 安装

```bash
dsh plugin --profile web add dsh-mv-session
# 重启 dsh web 一次，插件生效
```

## 使用（工具形态，推荐）

在任何 DSH 会话里说："把工作区 `/path/old` 迁移到 `/path/new`，标题改成 New Name"。
Agent 会先 `dry_run` 演练给你看计划，确认后再实跑；收尾用 `verify` 只读校验。

参数：`from`/`session`（二选一）、`to`（必填）、`title`、`dry_run`、`mkdir`、`merge_dir`、
`backup_dir`、`cleanup_empty`、`verify`（只读闭环校验）。

## 使用（CLI 形态）

```bash
node migrate_session.cjs --from /old --to /new --title "New" --mkdir --dry-run  # 演练
node migrate_session.cjs --from /old --to /new --title "New" --mkdir --yes      # 实跑（自动备份）
# 重启 dsh web（全程唯一必需的重启）→ GUI 确认新工作区/历史/工具 cwd
# 删除过渡 symlink（报告 manual 行有具体路径）
node migrate_session.cjs --verify --from /new          # 只读校验，闭环
```

## 为什么必须重启一次（且只需要一次）

迁移改的是磁盘，但运行中的 dsh web 持有一整套**内存态**（会话 header cwd、日志追加路径映射、
工作区注册表），重启前不读盘刷新，还会用内存旧值写回注册表/缓存。重启后进程从磁盘重建。
过渡 symlink 只服务于"迁移 → 重启"这段窗口；重启后删除即安全。

**不需要第二次重启**：删 symlink 后的确认用 `--verify`（只读）替代——核对注册表记录 ↔
会话 header cwd ↔ 帧不变式 ↔ 会话目录 ↔ 缓存，`ok:true` 即闭环；出现 problem 或 GUI 异常才再重启。
（零重启做不到：DSH 没有"在线改归属"的 API，唯一受支持的内存刷新机制就是重启。）

## 回滚

每次实跑都先备份（workspace.json / 会话日志 / 投影缓存，目录在输出 `backup` 行）。
回滚 = 还原备份 + 反向执行一次迁移（新路径 → 旧路径）+ 重启。

## 完整文档

完整说明书、发布指南、内部机制笔记在
[上游仓库](https://github.com/birdmanhj/dsh-mv-session)：`docs/user-manual.en.md`、`docs/user-manual.md`、
`docs/publishing.md`、`docs/dsh-session-migration-internals.md`。

`lib/migrate_session.cjs` 由仓库根 `lib/migrate_session.js` 同步而来
（包是 ESM，CLI 以 `node <file>` 子进程执行，必须用 CJS 副本）。

## License

[MIT](LICENSE)

# DSH 会话/工作区迁移 —— 内部机制与实战笔记

> 来源：2026-08-24 在 `DSH_wchat_article_downloader → DSH_wechat_article_downloader` 迁移中，
> 通过阅读 DSH 源码（`@deepseek-ai/dsh-*` 包）与实际操作验证得到。开发 `mv-session` 插件前必读。

## 1. 持久化布局（`~/.dsh/`）

```
~/.dsh/
├── storages/
│   ├── workspace.json          # 工作区注册表（id → {path,title,sessionIds,createdAt,updatedAt}）
│   ├── session_projcache.json  # 会话投影缓存（identity{createdAt,cwd} + title/stats 等 rows）
│   └── message_feedback.json   # 消息反馈（按 session 引用，一般无需迁移）
└── sessions/
    └── <projectKey(cwd)>/           # 目录名由 cwd 编码（见 §2）
        └── <encodeSegment(sessionId)>/
            └── session.jsonl.zstd   # append-only 会话日志（第一行是 header）
```

关键事实：

- **workspace 记录只持久化在 `workspace.json`**；`sessionPath` 映射是**纯内存 Map**，
  重启后由 `workspaceRegistry` 从 `sessionPersistence.list()`（读各会话 header 的 cwd）重建。
  因此改会话归属 = 改 header cwd + 改 workspace.json，两处必须一致。
- **会话 header 的第一行**是 `{"type":"session","version":0,"id":...,"createdAt":...,"cwd":"...",...}`。
  cwd 字段决定：① 会话日志文件所在目录（`projectKey(cwd)`）；② 工作区归属（`attachSession`
  校验 `realpath(header.cwd) === record.path`）。
- `session.jsonl.zstd` 是**多帧** zstd 流（帧级结构见 §2.5）：第 0 帧必须是**恰好一行 header**，
  其余每帧是一个 durable append 批次（可含任意多行）。系统 `zstd` CLI 与 `node:zlib`
  （Node ≥ 22.15）均可互操作。
  ⚠️ **严禁「整体解压 → 改第一行 → 整体重压成单帧」**：这会把整个日志塌缩进第 0 帧，
  `dsh web` 启动即崩（"first frame is not exactly one header line"）。2026-08-24 已在
  `DSH_wechat_article_downloader/session-7f4ed6a0` 实战踩坑并修复（见 §2.5）。
- `session_projcache.json` 的缓存校验：`identityMatches = stored.createdAt === expected.createdAt && stored.cwd === expected.cwd`。
  若 header cwd 改了而缓存没改，重启时缓存**自动失效并冷重建**（从日志重放，无损但慢）。
  运行中的 DSH 进程会周期性把内存中的旧 cwd **写回** cache，所以"先改缓存再被覆盖"是正常现象，无害。

## 2. 目录命名编码（`dsh-session-persistence-jsonl/lib/index.js`）

```js
projectKey(cwd)  // '/'、'\\'、':' → '-'（连续分隔符压缩为一个）；其余非 [A-Za-z0-9._-] → ~XXXX 转义
                 // 前后加 `--`，截断 251 字符
encodeSegment(id) // 类似，`~` 转义为 ~007E，`..`/`.` 特殊处理
```

例：`/Users/huangjian/vibe-workshop/DSH_wechat_article_downloader`
→ `--Users-huangjian-vibe-workshop-DSH~005Fwechat~005Farticle~005Fdownloader--`
（注意：本项目实际观察到的目录名里 `_` 保持原样，说明该版本编码规则允许 `_`；
**迁移脚本必须直接复刻 `projectKey` 的实现，不要自己猜**，或在运行时以"实际存在的目录"为准做匹配。）

`locate(meta)` = `logPath(root, meta.cwd, meta.id)` —— **纯路径拼接，不做磁盘校验**。

## 2.5. zstd 帧不变式（2026-08-24 boot 崩溃教训，迁移脚本必须遵守）

来源：`dsh-session-persistence-jsonl/lib/index.js` 的 `encodeMaterialization` / `encodeEventBatch`
/ `assertZstdHeaderFrame` / `scanZstdFrames`，以及 2026-08-24 `dsh web` 启动崩溃的实战排查。

- **物理布局**：`session.jsonl.zstd` = 若干独立可解码 zstd 帧直接拼接。
  - 第 0 帧 = header 帧：内容**恰好一行**（`JSON.stringify(toHeaderLine(meta)) + "\n"`）。
  - 第 1..n 帧 = 每次 append 的一个批次帧（`eventLines(events) + "\n"`，可含任意多行 JSONL）。
  - 每个帧都带校验位（`ZSTD_c_checksumFlag=1`），DSH 读端逐帧解压并验校验和。
- **boot 校验**：`assertZstdHeaderFrame` 要求第 0 帧解压后
  `text.length > 0 && text.indexOf('\n') === text.length - 1` —— 即**有且仅有一个换行且位于末尾**。
  不满足 → 抛 `corrupt Zstandard session log: first frame is not exactly one header line`，**整个 `dsh web` 启动失败**。
- **损坏形态**（本次事故）：旧的 `zstd -dc | 编辑 | zstd -q -c` 整文件往返会把 4582 行压成**一个**巨帧，
  帧 0 不再是一行 → boot 崩溃。数据本身完好，只是帧结构错位。
- **修复工具**：`~/.hermes/skills/autonomous-ai-agents/deepseek-harness/scripts/fix_dsh_frames_node.mjs`
  —— 解压全量 → 按行拆分 → 每行重压成独立校验帧（`node:zlib` zstd，无 maxBuffer 上限；
  `execFileSync("zstd", ...)` 在 >1MB 输出时会 ENOBUFS，所以不用 CLI）。
- **迁移脚本的正确做法**（`lib/migrate_session.js` 已实现）：
  1. 结构性帧扫描（`scanZstdFrames`，从 DSH 源码移植）定位帧边界，**不靠 magic 字节猜**；
  2. 快速路径：只解压第 0 帧 → 改 `cwd` → 只重压第 0 帧 → 与其余帧**字节级原样**拼接
     （最小 diff，事件帧零改动、零风险）；
  3. 修复路径：若第 0 帧已被旧工具塌缩（含多行）→ 全量解压 → 按行拆 → header 行单帧 +
     其余每行独立校验帧（与 fix 脚本同布局，boot 已验证可过）；
  4. 写盘前自检（`verifyMigratedLog`）：按 boot 同一断言复查第 0 帧恰好一行且 cwd 已更新、
     所有帧可独立解压，通过后 tmp 写入 + rename 原子替换；
  5. 回归测试 `tests/migrate_e2e_scratch.js`：两种布局（正常多帧 / 塌缩单帧）走完整 CLI 迁移，
     断言 boot 不变式 + 事件帧字节一致性 + `zstd -t`，`--boot` 模式还会真的拉起一个
     `dsh web`（临时 DSH_HOME）验证 HTTP 200。
- 结论：**每行一帧与每批一帧都合法**（只有帧 0 受校验）；但迁移改写应保持最小 diff。

## 3. workspace.json 结构

```json
{
  "unit": {"name": "workspace", "version": 2},
  "global": {"initialized": true, "workspaceIds": [...], "archivedSessionIds": []},
  "tables": {"workspaces": {
    "<uuid>": {"path": "...", "title": "...", "sessionIds": ["session-..."], "createdAt": "...", "updatedAt": "..."}
  }}
}
```

- `Workspace.attachSession(id)`：读 header → `realpathNormalize(header.cwd)` → 必须等于 `record.path` 且是目录，否则抛错。
- `Workspace.status()`：`stat(record.path)` 不存在 → `"missing-dir"`。
- 磁盘目录消失时 DSH 的恢复逻辑会自动创建**新 workspace 记录 + 新空会话**（本次实测发生：
  mv 之后 1 分钟内出现了 path=新路径的记录和一个只有 header/policy 事件的新会话）。
  迁移时要识别并清理这类自动产生的空记录/空会话。

## 4. 正确的迁移步骤（实测验证过的顺序）

前提：**先备份**全部将修改的文件。

1. **磁盘目录改名/移动**：`mv <from> <to>`。
2. **过渡 symlink**：`ln -sfn <to> <from>`。
   - 作用：让**正在运行**的 DSH 进程里旧 cwd 立即可用（bash/read/write 工具默认 workdir 恢复），
     也让进程 append 日志经旧路径落到新位置，不产生日志分裂。
3. **改 session header cwd**（对每个受影响会话）：
   ⚠️ 不要用 `zstd -dc ... | 改 | zstd -q -c` 整体往返（会塌缩成单帧、boot 崩溃，见 §2.5）。
   正确做法：只重写第 0 帧（header 帧），其余帧字节不动；若遇到已塌缩的历史文件，
   按 §2.5 修复路径重建为每行一帧。写盘前按 boot 同款断言自检，tmp+rename 原子替换。
4. **移动 sessions 目录**：`<sessions>/<projectKey(from)>/<sid>` → `<sessions>/<projectKey(to)>/<sid>`；
   旧 projectKey 目录删除后在原位置放 symlink 指向新目录（运行中进程过渡）。
5. **清理自动产生的空会话**（mv 后 DSH 自动创建的、无对话内容的 session 目录 + workspace 记录 + projcache 条目）。
6. **更新 workspace.json**：
   - 首选：直接把旧 path 记录的 `path`/`title` 改为新值（sessionIds 不动）；
   - 若目标路径已有自动创建的新记录：把真实 sessionIds 并入目标记录，删除旧记录，
     `global.workspaceIds` 同步增删。
7. **更新 session_projcache.json**：受影响会话的 `identity.cwd`；删除空会话条目。
8. **验证**：workspace.json、header cwd、projcache identity、sessions 目录四处一致。
9. **重启 DSH web**（用户操作，插件无法替宿主重启自己）：
   - 重启后 `workspaceRegistry` 从新 header/记录重建，GUI 显示新工作区 + 完整历史。
   - 若 projcache 的 cwd 与 header 不一致 → 自动失效重建（无损）。
10. **清理 symlink**（重启确认正常后）：`rm <from>` 与旧 projectKey 目录 symlink。

## 5. 运行中进程的行为（为什么需要 symlink + 重启）

- 进程内存中 `Session.header.cwd`、`sessionPaths` Map、workspace registry 实体在重启前**不会**读盘刷新。
- 会话每轮 append 日志：路径由内存 cwd 决定 → 旧 projectKey 路径 → 经 symlink 落到新位置 ✓。
- 投影 cache 周期性 checkpoint：会用**内存中的旧 cwd** 覆盖磁盘上已改的 cache —— 无害
  （重启时校验不匹配则冷重建）。
- 因此：**磁盘层立即生效（靠 symlink），完整生效必须重启**。插件应在完成后明确报告：
  "请重启 dsh web；重启后删除以下 symlink：...；如需回滚：备份在 ..."。

## 6. 风险清单

| 风险 | 缓解 |
|---|---|
| 改坏 zstd 帧 | 先 `cp -p` 备份；改后 `zstd -t` 校验；重压缩帧 DS H 读取已验证兼容 |
| 进程 append 与新目录分裂 | 旧 projectKey 位置放 symlink（§4.4） |
| projcache 被进程覆盖 | 接受覆盖；重启自动失效重建 |
| workspace.json 被进程写回 | 迁移期间避免其他工作区操作；完成后尽快重启 |
| 目标路径已有 workspace 记录 | 合并 sessionIds + 删除旧记录 + 同步 workspaceIds |
| 目标路径已存在磁盘目录 | 拒绝或要求 `--merge-dir` 显式确认 |
| symlink 残留导致 `realpath(header.cwd)` 与 record.path 不匹配 | record.path 用**真实路径**；symlink 仅作过渡并在重启后删除 |
| 无 zstd CLI 的机器 | 脚本优先 `require('@mongodb-js/zstd')`（从 DSH node_modules），回退 CLI，再回退报错 |

## 7. 参考源码位置

- 会话目录编码 / locate / logPath：`dsh-session-persistence-jsonl/lib/index.js`
- workspace 注册表 / attachSession / status / mutate：`dsh-workspace/lib/index.js`
- 投影缓存校验 identityMatches：`dsh-session-projection-cache/lib/index.js`
- shell 服务契约（插件执行命令用）：`dsh-shell/lib/types/types.d.ts`、`dsh-bash-local/lib/index.js`
  （`resolve({command, workdir?, timeoutMs?, stdoutMaxBytes?, env?})` → `run(spec)` →
  `{exitCode, stdout:{text,truncated,spillPath}, stderr:{text,...}}`）

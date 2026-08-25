# mv-session 使用说明书

[English](user-manual.en.md) | 中文

> 适用范围：DSH-mv-session 项目（`lib/migrate_session.js` 核心脚本、`mv_session` 插件工具、
> `packages/dsh-mv-session/` 正式插件包）。本文档面向最终使用者。
>
> **一句话原理（TL;DR）**：迁移改的是磁盘，但运行中的 dsh web 用的是内存（旧路径），
> 重启前不读盘、还会把旧值写回磁盘。所以流程固定为：
> **演练 → 实跑 → 重启一次 → 验证 → 删 symlink → `--verify` 校验闭环**。
> 看不懂原理也能照做；想懂为什么，读 §5。

## 1. 这个插件解决什么问题

在 DSH 中重命名/移动一个工作区目录后，DSH **不会**自动迁移会话，会出现：

- 旧会话仍绑定旧路径（工具 cwd 失效 ENOENT）；
- DSH 自动为新路径创建**空工作区 + 空会话**；
- 会话 header cwd、sessions 目录、workspace 注册表、投影缓存四处不一致。

`mv_session` 一步完成全部迁移（含备份），并告诉你剩下哪些人工步骤。

**核心安全保证**：迁移只重写会话日志的第 0 帧（header 帧），其余帧字节不动，绝不破坏
DSH 的 zstd 帧不变式（第 0 帧必须恰好一行 header）——不会造成 `dsh web` 启动崩溃
（"first frame is not exactly one header line"）；遇到历史塌缩帧的日志还会自动修复。

## 2. 两种使用形态

| 形态 | 入口 | 适用 |
|---|---|---|
| **插件工具** | 在任意 DSH 会话里让 Agent 调用 `mv_session` 工具（自然语言即可） | 日常使用（推荐） |
| **命令行** | `node lib/migrate_session.js ...`（仓库内）或随包分发的 `migrate_session.cjs` | 脚本化、批处理 |

两种形态的参数与行为完全一致。

### 2.1 安装插件（一次性）

```bash
dsh plugin --profile web add /path/to/packages/dsh-mv-session
# 或发布到 npm 后：
dsh plugin --profile web add dsh-mv-session

# 重启 dsh web 后生效；之后在任何会话中让 Agent 执行迁移即可，例如：
#   "把工作区 /path/old 迁移到 /path/new，标题改成 New Name"
```

安装成功标志：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 包含
`dsh-mv-session`；重启后 Agent 的工具列表中出现 `mv_session`。

## 3. 参数说明

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `from` | string | 二选一 | 当前工作区路径（磁盘目录，可为 symlink） |
| `session` | string | 二选一 | 会话 id；脚本自动从投影缓存/注册表定位其工作区 |
| `to` | string | ✅ | 目标工作区路径 |
| `title` | string | — | 新标题（默认取 `to` 的 basename） |
| `dry_run` | bool | — | 只打印计划，不写任何东西（默认 false） |
| `mkdir` | bool | — | 目标目录不存在时允许创建 |
| `merge_dir` | bool | — | 目标目录**已存在且非空**时，显式同意合并内容（默认拒绝） |
| `backup_dir` | string | — | 备份位置（默认 `<dsh-home>/migration-backups/`） |
| `cleanup_empty` | bool | — | 清理目标处自动产生的空会话（默认 true） |
| `verify` | bool | — | 只读一致性校验（工具形态的 `--verify`）：重启 + 删 symlink 后调用，替代第二次重启 |

CLI 形态对应标志：`--from/--session/--to/--title/--dry-run/--mkdir/--merge-dir/--backup-dir/
--no-cleanup-empty/--verify/--yes`。

## 4. 标准迁移流程（一次重启即可闭环）

```bash
# 第 1 步：演练（不写任何东西；目标不存在时加 --mkdir 才允许规划）
node lib/migrate_session.js --from /path/old --to /path/new --title "New Name" --mkdir --dry-run

# 第 2 步：实跑（自动备份；迁移在磁盘层立即生效）
node lib/migrate_session.js --from /path/old --to /path/new --title "New Name" --mkdir --yes

# 第 2.5 步（防写回）：实跑后立即做一次只读校验，确认注册表记录还在——
# 运行中的旧进程可能把内存旧值写回 workspace.json（实测会发生），
# 若报 "discover failed: no workspace record"，说明记录被写回覆盖：
# 重新执行一次第 2 步（幂等安全：symlink 已指向目标会自动跳过重建）
node lib/migrate_session.js --verify --from /path/new
```

```text
第 3 步：重启 dsh web —— 全程唯一必需的重启（原理见 §5.1），三种方式任选：
         ① 仓库自带一键脚本（推荐，双语提示：自动杀旧 → 启动 → 等就绪 → 开浏览器）：
            scripts/dsh-web-restart.command（macOS 双击或 bash 执行；Linux 用 bash 执行；可带端口参数）
         ② 手动命令：kill $(lsof -tiTCP:3080) && dsh web
         ③ 你自己的桌面快捷方式（如 dsh-web 一键脚本）
第 4 步：GUI 验证：
         ✅ 工作区列表只有新路径        ✅ 历史消息完整
         ✅ 会话里工具 cwd 正常          ✅ 无空会话/空工作区残留
第 5 步：删除过渡 symlink（此时已安全——重启后新进程只引用新路径，见 §5.2）：
         rm <旧工作区目录的 symlink>
         rm ~/.dsh/sessions/<旧 projectKey 的 symlink>
第 6 步：只读校验替代第二次重启（原理见 §5.3）：
         node lib/migrate_session.js --verify --from /path/new
         → ok:true 且 problems 为空 = 闭环；warnings 属正常自愈现象（见 §7）；
         → 出现 problem 或 GUI 异常，再重启一次排查（此时重启只是排查手段，不是必需步骤）
```

> 说明：早期版本的流程是"重启两次"。第二次重启本质是"删除 symlink 后确认系统无残留依赖"
> 的验证手段，并非机制必需；现在用第 6 步的 `--verify` 只读校验替代它。

## 5. 原理：为什么必须重启一次（且只需要一次）

### 5.1 为什么重启是必需的

迁移改的是**磁盘**，但正在运行的 dsh web 进程持有一整套**内存态**，重启前不会读盘刷新：

| 内存态 | 影响 |
|---|---|
| `Session.header.cwd`（各会话对象） | 工具（bash/read/write）默认工作目录按内存里的旧 cwd 解析 → 旧路径失效 ENOENT |
| `sessionPaths` Map（会话日志路径映射） | 每轮对话的日志 append 仍写向旧 projectKey 目录 → 经过渡 symlink 落到新位置 |
| workspace 注册表实体（记录列表） | GUI 工作区列表不变；更重要的是它的 checkpoint 会用**内存旧值写回** workspace.json / session_projcache.json，覆盖迁移刚写入的新值（本插件实战中实测遇到两次：注册表记录被覆盖丢失、缓存 cwd 回退） |

重启后进程从磁盘重建：注册表由 `sessionPersistence.list()`（读各会话日志的 header）重建，
header cwd 已指向新路径 → 工作区正确呈现、历史完整；投影缓存身份不匹配 → 自动冷重建（无损）。

**结论：磁盘层立即生效（靠 symlink 支撑旧进程），完整生效必须重启一次。迁移 → 重启之间的
窗口越短越好**（窗口越长，旧进程写回旧值的概率越高；重启前可用 `--verify` 快速确认注册表
记录是否还在，被写回就补一次）。

### 5.2 过渡 symlink 的使命与生命周期

symlink 只服务于"旧进程 → 重启"这段窗口：让旧 cwd 立即可用（工具不报错）、
让日志 append 经旧路径落到新位置（日志不分裂）。**重启完成后新进程只引用新路径，
symlink 使命即结束**，此时删除是安全的（第 5 步）；它不能在重启前删（旧进程还在用它），
也不该永久保留（残留的旧拼写 symlink 会干扰后续迁移与校验）。

### 5.3 为什么第二次重启不是必需的

- 第 3 步重启后，进程内存已全部是新路径：工具 cwd、append 路径、注册表记录都是新的，
  没有任何东西再引用旧路径；
- 删除 symlink（第 5 步）因此不改变任何运行中引用；
- "再重启确认一次"只是防御性验证——用来抓"某个没料到的环节还依赖旧路径"。
  现在 `--verify` 用只读方式做同样的事（见 §6）：核对注册表记录 ↔ 会话 header cwd
  ↔ 帧不变式 ↔ 会话目录 ↔ 投影缓存，并报告 symlink 残留；
- 所以标准协议只有**一次必需重启**；`--verify` 全绿即闭环，出现 problem 或 GUI 异常时
  再重启排查。

### 5.4 能否做到零重启

**现状：不能。** 原因：

1. 内存层（§5.1）没有公开的"在线改归属"接口——`workspaceRegistry` 服务没有 rename/rehome
   类方法，`sessionPaths` 映射也不开放刷新；
2. 在插件里直接改写运行进程的内存对象属于无文档的内部手术（改 Session 对象 header、
   绕过注册表校验直接改实体），脆弱、随 DSH 版本变化失效，且插件无法验证所有下游消费者
   （append 路径、GUI 订阅、缓存 checkpoint）都跟着切走；
3. 唯一被 DSH 支持的"内存层刷新"机制就是进程重启。

**能达到的最小值就是一次重启**（本协议）。如果未来 DSH 提供官方的
`workspaceRegistry.rehome(oldPath, newPath)` 之类 API，插件可以升级为真正的零重启迁移；
在此之前，"迁移 + 一次重启"是可靠性与侵入性的最优平衡。

### 5.5 与早期"两次重启"流程的对应关系

| 早期流程 | 现在 | 性质 |
|---|---|---|
| 第 1 次重启 | 第 3 步（唯一重启） | 必需（刷新内存层） |
| 删除 symlink | 第 5 步（重启后） | 必需（清理过渡装置） |
| 第 2 次重启 | 第 6 步 `--verify` | 验证（替代；异常才重启） |

## 6. 场景示例

### 6.1 普通改名/移动

```
Agent 工具调用：mv_session { from: "/path/old", to: "/path/new", title: "New", dry_run: true }
→ 核对计划 → 再调 mv_session { from: "/path/old", to: "/path/new", title: "New", mkdir: true }
→ 重启 dsh web（唯一必需）→ GUI 验证 → 删 symlink → --verify 校验闭环
```

### 6.2 只知道会话 id

```
mv_session { session: "session-xxxx", to: "/path/new" }
```

### 6.3 目标目录已存在且非空

默认**拒绝**（报错提示加 `--merge-dir`）。确认合并时：

```
mv_session { from: "/path/old", to: "/path/existing", merge_dir: true }
```

脚本会先检查同名冲突（有冲突直接报错列出），再逐项并入目标目录。

### 6.4 --from 本身是 symlink

脚本按**注册表记录里的真实路径**定位会话目录（不会漏迁移），并移动真实目录、
用新的过渡链替换旧 symlink。

## 7. 输出解读

- dry-run：`discovered`（工作区 id/路径/会话数、新旧 projectKey、目标是否已有记录）
  + `plan`（每步动作清单）——**只读，不产生任何修改**。
- 实跑：`migrated`（from/to/title/会话数）+ `actions`：
  - `backup`：备份目录（回滚依据）；
  - `rewrite_header`：每个会话的重写结果（`frameCount` 帧数；`repaired: true` 表示该日志
    曾被旧工具塌缩、本次已修复为每行一帧）；
  - `manual_remaining`：剩余人工步骤（重启、删 symlink）。
- `--verify`（只读，替代第二次重启）：
  - `checks`：逐项通过记录（注册表记录、每个会话的帧不变式与 header cwd）；
  - `problems`：**必须处理**（记录缺失、header cwd 与记录不一致、帧 0 违反不变式、
    日志损坏）——出现即建议重启/回滚排查；
  - `warnings`：**无害自愈**（projcache cwd 陈旧 → 读取时自动冷重建；symlink 残留 → 删掉即可）。
- 工具形态下，这些信息会被渲染成易读报告，并附上回滚提示。

## 8. 安全机制

1. **帧不变式**：只重写第 0 帧；其余帧字节级原样保留；写盘前按 DSH boot 同款断言
   （第 0 帧恰好一行 header、cwd 已更新、所有帧可独立解压）自检；tmp+rename 原子替换。
2. **先备份后修改**：workspace.json、projcache、全部受影响会话日志先复制到备份目录。
3. **显式确认**：非空目标目录默认拒绝；磁盘层任何一步失败都会中止并保留备份。
4. **幂等防护**：symlink 已指向目标时跳过重建；旧记录/空会话清理带集合去重。

## 9. 回滚

1. 数据回滚：备份目录里恢复了迁移前的 workspace.json / session_projcache.json /
   各会话日志；把磁盘目录移回旧路径后，反向执行一次迁移（新路径 → 旧路径）即可；
   或手工还原四件套 + 重启 dsh web。
2. 注意：迁移后**尽快重启** dsh web，避免运行中进程把内存里的旧注册表写回磁盘
   （实测会发生：注册表记录可能被旧进程覆盖，重启前请核对 workspace.json，
   若记录丢失可在重启前补回，重启后进程从磁盘重建即稳定）。

## 10. 常见问题（FAQ）

| 现象 | 原因与处理 |
|---|---|
| `--to path does not exist (use --mkdir to create it)` | 目标目录不存在：dry-run/实跑都加 `--mkdir` |
| `ENOTEMPTY: rename ...` 或 `--to directory exists and is not empty` | 目标目录非空：显式加 `--merge-dir`（先查冲突） |
| `--from and --to resolve to the same directory` | 守卫拦截：from/to 指向同一目录（如重复执行把 symlink 当 from），换一个目标路径 |
| `no workspace record found for path ...` | from 路径没有注册表记录：先用 GUI 打开一次该工作区，或确认路径正确；也可能是旧进程写回覆盖，见下一行 |
| `preflight failed — nothing was modified` | 实跑前预检发现坏日志：**什么都不会改动**（连备份都不写），按列出的日志用备份替换后重跑 |
| 迁移中途失败/被打断 | 预检保证坏日志不会拖到半途；磁盘步骤若中断，用备份目录还原四件套 + 把目录移回旧路径，再重跑 |
| 重启后工作区不见了/记录丢了 | 运行中进程写回旧注册表：重启前核对 workspace.json（第 2.5 步），必要时补记录再重启 |
| 迁移后会话历史缺失 | 检查 sessions 目录是否移动完整、header cwd 是否为新路径；用备份回滚重做 |
| `--verify` 报 projcache cwd stale | **无害自愈**：缓存身份不匹配会在读取时自动冷重建，无需处理 |
| `--verify` 报 header cwd mismatch | 属 problem：header 与注册表不一致，用备份回滚重做迁移 |
| `zstd unavailable` | 升级 Node ≥ 22.15（原生 node:zlib zstd），或安装 @mongodb-js/zstd / zstd CLI |
| 工具执行超时 | 大日志（数百 MB）压缩较慢：把 timeoutMs 调大或直接跑 CLI |
| 第二次重启到底要不要？ | 不需要。`--verify` 全绿即闭环；出现 problem 或 GUI 异常才再重启（见 §5.3） |
| Windows 能用吗？ | 脚本逻辑跨平台，但当前只在 macOS/Linux 实战验证过；Windows 环境建议先在一个测试工作区完整走一遍流程 |

## 11. 测试与回归

```bash
node --check lib/migrate_session.js
node tests/migrate_e2e_scratch.js [真实会话日志] --boot   # 帧不变式 + 真实 dsh web boot 验证
node tests/migrate_edge_cases.js                          # 合并/symlink/无zstd/--session/--verify 边界
```

相关文档：`docs/user-manual.en.md`（English manual）、`docs/dsh-session-migration-internals.md`
（内部机制）、`docs/publishing.md`（发布指南）。

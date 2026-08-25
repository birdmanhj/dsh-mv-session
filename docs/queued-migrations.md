# 已排队的迁移任务（Queue）

> 这些是用户明确提出的真实迁移需求。mv-session 插件完成端到端测试后，按顺序执行。
> **执行任何实跑前先 `--dry-run`，并提醒用户重启 dsh web 与删除过渡 symlink。**

## 任务 1：DSH_wechat_article_downloader → DSH-wechat-article-downloader

- 状态：**已完成**（2026-08-25 用 DSH-mv-session 插件执行：注册表归一化、陈旧 wchat 记录与空会话清理、
  4583 帧会话日志最小 diff 重写；重启后 GUI 确认新工作区与完整历史、旧工作区/会话消失；
  两个过渡 symlink 已删除；`--verify` 只读校验 ok:true（projcache stale 属自愈警告）——
  迁移闭环，无需再重启）。
- 当前路径：`/Users/huangjian/vibe-workshop/DSH-wechat-article-downloader`（真实目录）
- 目标路径：`/Users/huangjian/vibe-workshop/DSH-wechat-article-downloader`（连字符风格）
- 目标标题：`DSH-wechat-article-downloader`
- 涉及会话：`session-7f4ed6a0-d005-46ba-a16f-8bd7f2d3d061`（微信插件开发会话，历史很长，务必保证日志完整）
- ⚠️ 拼写注意：用户消息中写作 `DSH-wechat-artical-downloader`（artical 拼写错误）。
  执行前请与用户确认最终拼写（推荐 `DSH-wechat-article-downloader`）。
- 前置条件（2026-08-24 状态）：
  1. 该项目工作区刚从 `DSH_wchat_article_downloader` 迁移到 `DSH_wechat_article_downloader`
     （数据层已完成：header cwd / sessions 目录 / workspace.json / projcache 均已指向
     `DSH_wechat_article_downloader`），但**用户尚未重启 dsh web**，过渡 symlink 仍在：
     - `/Users/huangjian/vibe-workshop/DSH_wchat_article_downloader` → `DSH_wechat_article_downloader`
     - `~/.dsh/sessions/--Users-huangjian-vibe-workshop-DSH_wchat_article_downloader--` → `--...DSH_wechat_article_downloader--`
  2. 执行任务 1 之前：先确认用户已重启 dsh web（第一次迁移完全生效），并删除上述两个 symlink；
     否则 `--from` 是 symlink 会让真实目录与记录路径不一致（脚本已对 symlink 状态健壮，
     但更干净的做法是先清场）。
  3. 若用户选择在重启前就用插件执行任务 1：脚本会处理 symlink（move_dir 取 realpath），
     但必须提醒：**最终生效仍依赖重启**，且旧 symlink 链会被替换为新链。
- 备注：迁移后用户还计划继续开发微信公众号文章下载插件（该工作区 `HANDOFF.md` 有完整交接）。

## 通用执行清单（每次迁移）

1. `--dry-run` 确认计划（涉及的正确会话、目标无冲突、无意外空会话）。
2. 实跑加 `--yes`（非交互）。备份自动落在 `<dsh-home>/migration-backups/`。
3. 输出中的 `manual_remaining` 步骤转告用户：
   - 重启 dsh web；
   - 重启后删除过渡 symlink；
   - 回滚方式：备份目录 + 反向迁移。

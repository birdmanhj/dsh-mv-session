# Changelog

## 0.1.1 (2026-08-25)

发布级文档治理与脱敏。

- 移除 CLI 中硬编码的机器特定 zstd 回退路径（改为仅从 DSH_HOME 派生候选 + CLI 兜底）
- 双语文档：新增英文使用说明书（docs/user-manual.en.md），publishing/marketplace 指南加英文导览
- 脱敏：删除个人任务队列文档，内部机制笔记真实路径/会话 id 占位符化
- 包 README 双语化（README.md + README.zh.md + i18n 一致性记录）

## 0.1.0 (2026-08-25)

首个可发布版本。

- `mv_session` 工具：dry-run / 实跑 / `--verify` 只读闭环校验三合一
- 帧安全 header 重写：只替换第 0 帧、其余帧字节不动；历史塌缩帧日志自动修复；
  写盘前 boot 同款断言自检 + tmp/rename 原子替换
- 迁移全程自动备份；变更前 preflight 预检（坏日志零改动中止）；from/to 同目录守卫
- 目标非空目录默认拒绝，`--merge-dir` 显式合并（先查冲突）
- 支持 `--from`（含 symlink）与 `--session` 定位；自动清理目标处空会话
- 协议：演练 → 实跑 → 重启一次 → 删 symlink → `--verify` 闭环（无需第二次重启）
- 回归测试：帧不变式 + 真实 dsh web boot 验证；边界用例（合并/symlink/无 zstd/守卫/预检）

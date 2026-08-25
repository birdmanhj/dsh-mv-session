# Changelog

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

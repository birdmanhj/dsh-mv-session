# 插件广场收录 PR 指南与文案

> *EN: Ready-to-submit PR copy and step-by-step guide for listing this plugin in community
> marketplaces (format verified against awesome-dsh-plugin's contributing guide, 2026-08).*
>
> 面向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的收录提交流程
> （格式以其 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 为准，
> 2026-08 实测确认）。其余社区目录流程类似：都是"按各自模板新增一个条目文件 + PR"，
> npm 发布 + GitHub `dsh-plugin` topic 是共同前置（本项目已完成）。

## 1. 提交步骤（一次性约 10 分钟）

```bash
# 1) 在 GitHub 网页上 Fork awesome-dsh-plugin 到你的账号
# 2) 克隆你的 fork 并开分支
git clone git@github.com:<you>/awesome-dsh-plugin.git && cd awesome-dsh-plugin
git checkout -b add-dsh-mv-session

# 3) 新增一个 YAML 条目（一个插件一个文件，文件名 = owner__repo[--子包路径]）
cat > data/plugins/birdmanhj__dsh-mv-session--packages-dsh-mv-session.yml <<'EOF'
url: https://github.com/birdmanhj/dsh-mv-session/tree/main/packages/dsh-mv-session
name: birdmanhj/dsh-mv-session#dsh-mv-session
category: session
description:
  en: 'Migrate DSH sessions/workspaces to a new path or title: frame-safe session-log rewrite, auto-backup, and a one-restart protocol.'
  zh: '把 DSH 会话/工作区迁移到新路径或新标题：帧安全改写会话日志、自动备份、一次重启即可闭环。'
EOF

# 4) 按目录要求重新生成两个 README 并一起提交
npm ci
node scripts/generate-readme.mjs
git add -A && git commit -m "Add birdmanhj/dsh-mv-session (session)"

# 5) 推送并在 GitHub 上开 PR（标题/正文用第 2 节文案）
git push origin add-dsh-mv-session
```

## 2. PR 标题与正文（可直接复制）

**标题：**

```
Add birdmanhj/dsh-mv-session (session)
```

**正文：**

```markdown
Adds [dsh-mv-session](https://github.com/birdmanhj/dsh-mv-session), published on npm
([dsh-mv-session](https://www.npmjs.com/package/dsh-mv-session), v0.1.0).

新增 [dsh-mv-session](https://github.com/birdmanhj/dsh-mv-session)，已发布 npm
（[dsh-mv-session](https://www.npmjs.com/package/dsh-mv-session)，v0.1.0）。

- **What / 功能**: migrate DSH sessions/workspaces to a new path/title in one tool call.
  把 DSH 会话/工作区迁移到新路径/新标题，一条 `mv_session` 工具调用完成。
- **Why it matters / 亮点**: frame-safe session-log rewrite (frame 0 only, byte-identical
  event frames, repairs historically collapsed logs) — avoids the `dsh web` boot crash
  *"first frame is not exactly one header line"*; auto-backup + preflight + read-only
  `--verify` closing check; one-restart protocol.
  帧安全改写会话日志（只改第 0 帧、事件帧字节不动、自动修复历史塌缩帧）——
  规避 `dsh web` 启动崩溃；自动备份 + 变更前预检 + `--verify` 只读闭环校验；
  一次重启协议。
- **Install / 安装**: `dsh plugin --profile web add dsh-mv-session`
- **Qualifies / 收录资质**: the subpackage declares `dsh.bundle.patch`
  (`packages/dsh-mv-session/package.json`), repo tagged `dsh-plugin`; regression-tested
  against a real `dsh web` boot.
  子包声明 `dsh.bundle.patch`；仓库已打 `dsh-plugin` topic；含真实 dsh web boot 回归测试。
- Category `session` is my best guess — happy to move it if a better fit exists.
  分类 `session` 是我的判断，若有更合适的分类请告知，随时调整。
```

## 3. 注意事项

1. `description.en` 含 `: ` 时必须加引号（本条目已加）。
2. 目录 README 是**生成的**，不要手工编辑，只改 YAML + 跑生成脚本。
3. 子包收录用 `url: .../tree/main/packages/dsh-mv-session` 与
   `name: owner/repo#子包名`，文件名用 `--` 连接子包路径（与目录规范一致）。
4. 其他目录（如 dsh-plugins-store、dsh-plugin-marketplace）各有格式：
   提交前先读各自 contributing/README；npm + topic 双轨就绪后，
   radar 类索引（如 dsh-plugin-radar）无需提交也会自动可见。
5. 以后发新版不用改目录条目（条目不绑定版本号）；若换分类或描述再提小 PR 即可。

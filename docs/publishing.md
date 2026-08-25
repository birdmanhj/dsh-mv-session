# mv-session 发布指南

> 把 `packages/dsh-mv-session/` 发布为可安装的 DSH 插件（npm 公开包 / GitHub / 本地路径），
> 供 `dsh plugin add` 安装。

## 1. 发布形态总览

| 形态 | 安装命令 | 适用 |
|---|---|---|
| npm 公开包 | `dsh plugin --profile web add dsh-mv-session` | 公开发布（推荐） |
| GitHub | `dsh plugin --profile web add git+https://github.com/<you>/DSH-mv-session.git#v0.1.0` | 不想上 npm |
| 本地路径 | `dsh plugin --profile web add /abs/path/packages/dsh-mv-session` | 本机/开发调试 |

`dsh plugin add` 底层是「在 profile 目录跑 pnpm add，然后把声明了 `dsh.bundle.patch` 的依赖
自动并入 `dsh.profile.bundles`」——所以任何 pnpm 认识的来源（registry / git / file / link）都能装。

## 2. 包结构（发布单元）

```
packages/dsh-mv-session/
├── package.json          # name/version/main/exports/files + dsh.bundle.patch 声明
├── cordis.patch.yml      # 插入一行宿主组合：id: mv-session, name: dsh-mv-session
├── lib/index.js          # 零外部 import 的 ESM cordis 插件（注册 mv_session 工具）
├── lib/migrate_session.cjs  # 帧安全迁移 CLI（由仓库根 lib/migrate_session.js 同步而来）
└── README.md
```

发布契约要点：

- `package.json` 必须含 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`——
  这是 `dsh plugin` 把依赖识别为 profile bundle 层的唯一标志。
- `lib/index.js` **保持零外部 import**（连 `@deepseek-ai/dsh-tools` 都不引）：`link:` 安装时
  Node ESM 按真实路径解析符号链接，外部包在开发目录下解析不到会直接加载失败。
  `ToolDefinition.parameters` 直接写 JSON Schema 即可（`ToolDefinition extends ToolSchema`）。
- CLI 必须是 `.cjs`：包是 ESM（`type: module`），而脚本以 `node <file>` 子进程执行，
  内部用 CommonJS `require`。

## 3. 发布前检查清单

```bash
cd packages/dsh-mv-session

# 1) 同步脚本（仓库根是唯一源码，改动后必须同步）
diff ../lib/migrate_session.js lib/migrate_session.cjs || cp ../lib/migrate_session.js lib/migrate_session.cjs
node --check lib/migrate_session.cjs

# 2) 冒烟：模块可导入、参数 schema 合法（在 profile 环境解析）
cd ~/.dsh/profiles/web && node --input-type=module -e "const m = await import('dsh-mv-session'); console.log(m.default.name)"

# 3) 回归测试（仓库根）
node tests/migrate_e2e_scratch.js --boot <真实会话日志>
node tests/migrate_edge_cases.js

# 4) 打包内容核对
npm pack --dry-run   # 只应包含 files 清单里的 4 项
```

## 4. npm 发布

```bash
cd packages/dsh-mv-session

# 首次：补元数据（repository 指向 GitHub，便于溯源）
npm version 0.1.0            # 升版本（patch/minor/major 按语义化）
npm login
npm publish --access public  # 若 name 撞名被拒，改 scope，如 @<you>/dsh-mv-session
```

发布后安装与升级：

```bash
dsh plugin --profile web add dsh-mv-session@0.1.0   # 安装指定版本
dsh plugin --profile web add dsh-mv-session@latest  # 升级到最新
# 重启 dsh web 生效；reconcile 会按安装态自动维护 dsh.profile.bundles
```

## 5. GitHub 发布（不上 npm）

```bash
cd <仓库根>
git add packages/dsh-mv-session lib tests docs README.md
git commit -m "release dsh-mv-session v0.1.0"
git tag v0.1.0 && git push origin v0.1.0

# 使用方安装（git 依赖会跑 prepare 脚本，pnpm 首次拦截需在
# ~/.dsh/profiles/web/pnpm-workspace.yaml 的 allowBuilds 放行一次）
dsh plugin --profile web add git+https://github.com/<you>/DSH-mv-session.git#v0.1.0
```

## 6. 本地/私服

```bash
# 本地目录（link 形式，源码改动实时生效，适合开发）
dsh plugin --profile web add /abs/path/packages/dsh-mv-session

# 打 tarball 后离线分发
npm pack                                    # 产出 dsh-mv-session-0.1.0.tgz
dsh plugin --profile web add ./dsh-mv-session-0.1.0.tgz

# 私服：.npmrc 配 registry 后与第 4 节相同
```

## 7. 升级注意事项

1. 插件行 `id: mv-session` 是稳定 id；`cordis.patch.yml` 别改 id，否则新旧行并存。
2. 工具行为变更（参数/默认值）要小版本号（minor），纯修复用 patch；
   破坏性变更（参数改名/移除）用 major 并在 changelog 说明。
3. 升级只改 package 内容：`dsh plugin add dsh-mv-session@latest` 后**重启 dsh web** 生效。
4. 每次发布前跑第 3 节全部检查；特别是帧相关改动必须过 `--boot` 回归（真实 dsh web boot）。

## 8. 插件广场（社区目录）上架

DSH 社区插件的发现/安装通道以 **npm + GitHub 双轨**为主，各"插件广场"从这两处索引：

1. **npm 发布**（§4）是所有广场的安装源基础：`dsh plugin add dsh-mv-session`。
2. **GitHub 仓库**：把本仓库推到 GitHub，并在仓库设置里添加 **topic：`dsh-plugin`**——
   社区 radar/索引工具（如 [dsh-plugin-radar](https://github.com/DshMarketPlace/dsh-plugin-radar)、
   [dsh-community-plugins](https://github.com/HubaKing/dsh-community-plugins)）按该 topic 扫描收录。
3. **社区目录 PR**：按各目录的 contributing 指南提 PR 收录，例如
   [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
   （[贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)）。
4. 应用内商店类插件（如 [dsh-plugins-store](https://github.com/DshMarketPlace/dsh-plugins-store)）多为
   npm/GitHub 数据的聚合展示，无需单独提交，随 1+2 自动可见。

上架前建议核对：`package.json` 的 `description`/`keywords` 可读（已含 `dsh-plugin` 关键词）、
README 自包含、LICENSE 与 CHANGELOG 随包、`repository` 字段在 GitHub 建仓后补上。

## 9. 常见坑

| 坑 | 处理 |
|---|---|
| `link:` 安装后插件加载失败 `Cannot find package ...` | 插件必须零外部 import（见 §2），或改用 tarball/file 安装 |
| pnpm 拦截 git 依赖的构建脚本 | 按提示把 key 加进 `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` |
| 改了仓库脚本忘了同步 | 发布前跑 `diff`（§3 第 1 步）；`migrate_session.cjs` 是发布副本 |
| npm name 撞名 | 换 scope：`@<you>/dsh-mv-session`，`dsh plugin add @<you>/dsh-mv-session` |
| 卸载插件 | `dsh plugin --profile web remove dsh-mv-session`（reconcile 会同步移除 bundle 层） |
| GitHub 建仓后 npm 页缺源码链接 | 在 `package.json` 补 `"repository": {"type":"git","url":"..."}` 后发新版本 |

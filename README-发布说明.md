# 发布指南

配置已经填好了（用户名 `Zephyr-Axis`），直接推到 GitHub 即可。

## 仓库信息

| 项 | 值 |
| --- | --- |
| 仓库名 | `dsh-astrbot-unified` |
| 作者 | `Zephyr-Axis` |
| 许可 | MIT |

## 发布步骤

```shell
cd repo-build

git init
git add -A
git commit -m "feat: AstrBot ↔ DSH unified bridge for dsh-go

- AstrBot 的 LLM 通过 dsh_ask 工具自主调用 DSH 执行任务
- QQ 对话镜像进 DSH 会话，按群/私聊分工作目录
- 支持 /reset 同步、删除同步、孤儿会话清理
- 为 dsh-go（Android proot）适配：UUID 会话 ID、显式 flush、HTTP 通信"

git remote add origin git@github.com:Zephyr-Axis/dsh-astrbot-unified.git
git branch -M main
git push -u origin main
```

## 建议的仓库设置

**About 部分**：

```
AstrBot ↔ DeepSeek Harness 统一桥，为 dsh-go 适配
```

**Topics**：

```
dsh  dsh-plugin  dsh-go  astrbot  onebot  qq  deepseek-harness  mirror  bridge
```

## 发布后检查

| 项 | 确认方式 |
| --- | --- |
| 两个插件目录都在 | GitHub 页面上能看到 `dsh-astrbot-unified/` 和 `astrbot_plugin_dsh_unified/` |
| README 渲染正常 | 表格、代码块、架构图都显示对 |
| 没有敏感信息 | 搜 `token`、`secret`、`api_key` 等关键词，确认没有硬编码 |

## 别人怎么装

根 README 的「安装」章节写了两步：

```shell
# DSH 侧
dsh plugin --profile web add github:Zephyr-Axis/dsh-astrbot-unified/dsh-astrbot-unified
```

AstrBot 侧需要手动拷目录（`astrbot_plugin_dsh_unified/` → `data/plugins/`）。

## 以后想进 AstrBot 插件市场

AstrBot 市场只认「目录名 + metadata.yaml」的结构，要求：

- 仓库根目录就是插件目录（不能套一层）
- 有 `metadata.yaml`，里面的 `name` 和仓库名一致

所以如果以后要上市场，需要给 `astrbot_plugin_dsh_unified/` **单独开一个仓库**
（`Zephyr-Axis/astrbot_plugin_dsh_unified`），内容就是那个子目录。

现在是「一个仓库装两端」，上市场得拆开。两种形态可以并存：

- `dsh-astrbot-unified`（主仓库，两端合一，推荐给用户看）
- `astrbot_plugin_dsh_unified`（镜像仓库，只为上市场）

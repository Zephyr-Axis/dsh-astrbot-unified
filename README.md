# dsh-astrbot-unified

**给 dsh-go 用的 AstrBot 桥**：AstrBot 的 LLM 自主调用 DSH 执行任务，同时把 QQ 对话镜像进 DSH 会话。

一个仓库，两端插件。

| 插件 | 装在哪 | 作用 |
| --- | --- | --- |
| [`dsh-astrbot-unified/`](./dsh-astrbot-unified/) | DSH | 接收消息、建会话、维护映射 |
| [`astrbot_plugin_dsh_unified/`](./astrbot_plugin_dsh_unified/) | AstrBot | 监听对话、推送给 DSH |

两个必须一起装，缺一个不工作。

## 适配 dsh-go

**这个项目的主战场是 dsh-go** —— 在手机上跑 DeepSeek Harness，用 QQ 当遥控器。桌面版 `dsh web` 理论上也能用（同一套插件 API）。

### 环境要求

| 项 | 要求 |
| --- | --- |
| dsh-go | 任意版本（跑在 Android proot 里） |
| DSH 插件 API | `>=0.2.0-rc.1 <0.3.0-0` |
| AstrBot | `>=4.16` |
| QQ 协议端 | NapCat / OneBot v11（走 `aiocqhttp`） |
| 两台是否同机 | 推荐同机，`127.0.0.1` 直连最简单 |

### dsh-go 特有的四个坑

**1. 后台会被系统杀**

dsh-go 跑在 Android 的 proot 里，App 切后台后可能被系统回收。表现是：
QQ 里说话没反应，DSH 那边什么也没发生。

处理：

- 系统设置 → 应用 → dsh-go → 省电策略 → **无限制**
- AstrBot 同样处理，它比 dsh-go 更容易被杀
- 掉线时插件不会报错（设计如此，避免刷屏），重启 App 后自动恢复

**2. 插件用 `link:` 安装时要重启才生效**

改完插件代码后必须重启 dsh-go。热重载只重新执行 `apply()`，
**不会重新 import 模块**，所以改了 `lib/*.js` 必须重启。

排查时可以先看 `/health` 的 `capabilities` 列表，确认新端点有没有加载。

**3. 两个 proot 环境互相看不见**

dsh-go 和 AstrBot 各自是独立的 proot，文件系统隔离。唯一共享的通道是
`/sdcard`（Android 的外部存储）。

所以：

- 插件之间用 HTTP，不共享文件
- 大附件走共享目录 `/sdcard/...`，不走网络传输

**4. 会话 ID 不能靠内建计数器**

DSH 内建的 `session-${++counter}` 计数器在进程内存里，dsh-go 重启后归零。
如果磁盘上已经有 `session-1`，新建就会报 `already exists`。

必须自己生成：

```js
sessionId: `session-${randomUUID()}`
```

### 文件共享：`/sdcard/Download/`

两个容器都挂载了 Android 的外部存储，所以**文件互传不需要人插手**：

| 方向 | 做法 |
| --- | --- |
| AstrBot → DSH | 写到 `/sdcard/Download/`，告诉 DSH 文件名 |
| DSH → AstrBot | 写到同一目录，AstrBot 直接读 |

两边插件都注入了提示词，LLM 知道这个目录的存在，不会问你「放哪」。

**大文件走这里，不要用 base64 或聊天附件**——没有大小限制，也不消耗上下文。

### 推荐配置

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-astrbot-unified
      name: dsh-astrbot-unified
      config:
        host: 127.0.0.1
        port: 3188
        baseCwd: /root/workspace    # 手机上的工作目录
        sourceTag: "QQ · AstrBot"
        asTurn: true
```

AstrBot 侧：

| 配置 | 值 |
| --- | --- |
| `dsh_url` | `http://127.0.0.1:3188` |
| `token` | 从 `~/.dsh/dsh-astrbot-unified/config.json` 抄 |

同机部署时 `127.0.0.1` 直接通，不用配 IP、不用 `host.docker.internal`。

## 它解决什么

两个能力，一个插件搞定。

### 1. AstrBot 的 LLM 自主调用 DSH

AstrBot 主智能体拥有 `dsh_ask` 工具，**自己判断**哪些任务该交给 DSH 执行：

```
你：帮我查一下 /root 下哪个目录最大
     ↓
AstrBot LLM：这需要跑命令，调 dsh_ask
     ↓
DSH agent：du -sh /root/* | sort -h
     ↓
返回结果 → AstrBot 转述给你
```

不需要记命令、不需要加前缀。DSH 能真实读写文件、执行 shell、跑测试。

### 2. DSH 的 agent 也能反过来调 AstrBot

装好插件后，DSH 的 agent 会自动获得一个技能（`dsh-call-astrbot`），学会：

| 能力 | 怎么用 |
| --- | --- |
| 让 AstrBot 的 LLM 回答 | 走它的 `/api/v1/chat`，带人格和工具 |
| 往 QQ 发消息 | 走它的 `/api/v1/im/messages` |
| 查 AstrBot 的会话列表 | 走 `/api/v1/conversations` |

你只需要在 `~/.dsh/dsh-astrbot-unified/config.json` 里填 `astrbot_key`
（在 AstrBot WebUI 里创建，勾 `im` 和 `chat` 权限）。

这样两个 agent 互相可调：

```
AstrBot ──dsh_ask──▶ DSH      执行任务
DSH ────curl─────▶ AstrBot   问它 / 发 QQ
```

### 3. 对话镜像

同时把 QQ 里的聊天同步到 DSH 会话：

- 在 DSH Go / 网页端能看到 QQ 聊了什么
- 对话按群 / 私聊自动分到不同工作目录
- 用户消息渲染成**真正的用户气泡**，助手回复在回合里
- AstrBot 那边 `/reset` 或删除对话，DSH 侧跟着标记 / 归档

**调过 `dsh_ask` 的轮次不会重复记录**——DSH 那边已经有真实回合了，
镜像会自动跳过助手回复，只留用户原话。

```
QQ ──OneBot──▶ AstrBot（主脑）
                   │
                   ├─ LLM 判断需要执行 ──▶ POST /inbound ──▶ DSH agent 执行
                   │                                          ↓
                   │                                    结果回传
                   └─ 每轮对话 ──────────▶ POST /append ──▶ DSH 会话（按群分组）
```

两条路径共用一个 DSH 会话：**执行产生的回合和镜像记录在同一条时间线里。**

## 安装

### 1. 先装 DSH 侧

```shell
dsh plugin --profile web add github:Zephyr-Axis/dsh-astrbot-unified/dsh-astrbot-unified
```

或者在本仓库的 `dsh-astrbot-unified/` 目录里：

```shell
dsh plugin --profile web add ./dsh-astrbot-unified
```

然后在 profile 的 `cordis.patch.yml` 里加配置（模板见 [`dsh-astrbot-unified/cordis.patch.yml`](./dsh-astrbot-unified/cordis.patch.yml)）：

```yaml
- insert:
    - id: dsh-astrbot-unified
      name: dsh-astrbot-unified
      config:
        host: 127.0.0.1
        port: 3188
        baseCwd: /your/workspace
        sourceTag: "QQ · AstrBot"
        asTurn: true
```

重启 `dsh web`，看到 `[unified] listening on http://127.0.0.1:3188` 即可。

**token 会自动生成**在 `~/.dsh/dsh-astrbot-unified/config.json`（权限 0600）。

### 2. 再装 AstrBot 侧

把 [`astrbot_plugin_dsh_unified/`](./astrbot_plugin_dsh_unified/) 整个目录拷进 AstrBot 的 `data/plugins/`，重载插件。

配置两项：

| 配置 | 值 |
| --- | --- |
| `dsh_url` | `http://127.0.0.1:3188` |
| `token` | 从 DSH 的 `~/.dsh/dsh-astrbot-unified/config.json` 抄 |

**改完配置必须重载插件**——AstrBot 把配置读进内存后，改文件不生效。

### 3. 验证

```shell
cd dsh-astrbot-unified
./verify.sh
```

或在 QQ 里说一句话，然后看 `~/.dsh/sessions/` 下有没有新的 `qq-groups-<群号>` 目录。

## 配置

### DSH 侧

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `host` / `port` | `127.0.0.1` / `3188` | 只监听本机 |
| `baseCwd` | 当前目录 | 会话目录的根，见下 |
| `sourceTag` | `QQ · AstrBot` | 消息前缀显示的名字 |
| `asTurn` | `true` | `true` 伪造回合（界面可见）；`false` 只写记录（界面不显示） |

目录结构：

```
<baseCwd>/qq/groups/<群号>/
<baseCwd>/qq/private/<QQ号>/
```

同一个群的不同 conversation **共用**一个目录——agent 应该看到同一批文件。

### AstrBot 侧

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `dsh_url` | `http://127.0.0.1:3188` | DSH 地址 |
| `token` | 空 | 必填 |
| `auto_execute` | `true` | 允许 LLM 调 `dsh_ask` |
| `mirror_enabled` | `true` | 对话镜像总开关 |
| `mirror_user_msg` | `true` | 同步用户消息 |
| `mirror_bot_msg` | `true` | 同步助手回复 |
| `long_result_threshold` | `1500` | 超过这个字符数就原样单独发，LLM 只做简短确认 |
| `timeout_sec` | `900` | 任务超时（秒），按空闲算 |
| `delete_sync_interval_sec` | `300` | 删除同步轮询间隔（秒），最小 30，0 = 关闭 |
| `allow_groups` | `[]` | 允许的群号，空 = 仅管理员 |
| `allow_users` | `[]` | 允许的 QQ 号，空 = 仅管理员 |

## HTTP 接口

除 `/health` 外都需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查 + 能力列表 |
| GET | `/map` | 查映射表（可带 `?umo=`） |
| GET | `/orphans` | 列出孤儿会话（磁盘上有、映射里没有） |
| POST | `/inbound` | 执行任务，SSE 回传：`{umo, text}` |
| POST | `/append` | 写一条消息：`{umo, cid, role, text}` |
| POST | `/reset` | 标记上下文作废：`{umo, cid}` |
| POST | `/archive` | 按映射归档单条：`{umo, cid}` 或 `{sessionId}` |
| POST | `/archive-umo` | **清空整个群**：`{umo}`，含孤儿会话 + 空工作区 |
| POST | `/clean-orphans` | 清理所有孤儿会话 |

## 实现上的坑

这些是实现时必须注意的点，不照做会出问题。

### 1. `sessionId` 必须自己生成

DSH 内建的 ID 是 `session-${++counter}`，**counter 在进程内存里**，重启后归零，会跟磁盘上已有的会话撞车：

```
session "session-1" already exists
```

解决：`sessionId: 'session-' + randomUUID()`。

### 2. 写完必须 flush

`session.append()` 只进内存缓冲。不调 `ctx.sessions.flush(session)` 的话，磁盘上只有 `session.lock`，没有 `session.v4.jsonl.zstd`——界面上表现为「有目录没数据」，重启后数据消失。

### 3. `surfaceOp` 标记

surface 事件必须带 `surfaceOp: 'append'`，且要在**第三参数**传：

```js
session.append('user/message', data, { surfaceOp: 'append' })
```

放 `data` 里会被拒：`requires a surfaceOp marker`。

### 4. `assistant/message` 强制 model source

校验要求：

```js
source: { kind: 'model', provider: '...', model: '...' },
turn: 数字, step: 数字, stream: []
```

**不能标成外部来源。** 所以助手回复会被 DSH 当成「astrbot 这个模型说的」。

### 5. 用户气泡靠 `rpcId`

用户消息要带：

```js
source: { kind: 'user', rpcId: randomUUID() }
```

没有 `rpcId` 的消息**不会渲染成用户气泡**。同一条会话里对比：无 rpcId 的显示为普通文本，有的正常显示气泡。

### 6. 界面只显示有回合的会话

只有 `user/message` 的会话在列表里不显示。助手回复要包成完整回合：

```
turn/start → step/start → assistant/message → step/end → turn/end
```

### 7. `on_astrbot_loaded` 重载不触发

轮询任务不能挂在它上面——那个钩子只在 AstrBot 启动时跑一次。用 `on_plugin_loaded`，每次加载（含重载）都触发。

### 8. 删除同步要区分「换会话」和「删会话」

AstrBot 换 conversation（`/new`、`/reset`）时旧 cid 会消失，但**不代表用户删了对话**。只有当整个 umo 一条 conversation 都不剩时才该归档。

同时要跳过 `webchat:*`——那是程序调 API 产生的，不是真实聊天。

### 9. 会话不在内存时不能重建

`ctx.sessions.get()` 只查内存。重启后所有会话都不在内存里，直接重建会撞 `already exists`。正确做法是先 `ctx.agents.resume({ resumeSessionId })`。

### 10. 归档 ≠ 删除工作区

`workspaceRegistry.archiveSession()` 只往 `archivedSessionIds` 加标记，**不动 `sessionIds`**，
也不删工作区实体。而界面列表读的是 `sessionIds`，所以会出现「归档了但还显示」。

三层都要清：

```js
archiveSession(id)                        // 1. 会话进归档
ws.detachSession(id)                      // 2. 从 sessionIds 摘掉
workspaceRegistry.delete(ws.id)           // 3. 工作区空了就删注册
```

`delete()` 只删注册，保留目录和日志，不会丢数据。

### 11. 删除同步不能用「基线 + 差异」

基线只在插件启动时建一次，之后新建的映射永远不在比对范围内，删除同步会静默失效。
正确做法是**每轮全量对比**：拿 DSH 的映射表，逐条查 AstrBot 那边还在不在。

### 12. 孤儿会话

映射表被清空（比如手动清理）后，磁盘上的会话就成了孤儿：界面看不见、也删不掉，
删除同步也扫不到（它依赖映射表）。

所以需要专门的清理入口：

```
GET  /orphans        列出磁盘上有、映射里没有的 qq 会话
POST /clean-orphans  一键归档所有孤儿
```

## 已知限制

- **DSH 侧无法真删会话**，只有归档（`workspaceRegistry.archiveSession`）。JSONL 仍留在磁盘。
- AstrBot 的删除操作**没有事件钩子**，只能轮询发现。
- 助手回复在 DSH 的模型选择里可能显示为未知模型（`provider: astrbot`）。
- 目前只支持 `aiocqhttp`（NapCat / OneBot v11）。

## 开发

```shell
# DSH 侧自检
cd dsh-astrbot-unified && ./verify.sh

# 语法检查
node --check dsh-astrbot-unified/lib/*.js
python3 -c "import ast;ast.parse(open('astrbot_plugin_dsh_unified/main.py').read())"
```

调试时把 AstrBot 侧的日志级别保持 `warning` —— 推送失败会直接显示原因，不会静默。

## 许可

MIT

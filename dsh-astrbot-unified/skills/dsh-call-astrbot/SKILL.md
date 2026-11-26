---
name: dsh-call-astrbot
description: "调用 AstrBot 的 LLM 或往 QQ 发消息。当用户要求「问问 AstrBot」「发到 QQ」「通知群里」时使用。"
---

# 调用 AstrBot

AstrBot 跑在同一台设备的另一个容器里，通过 HTTP 访问。

## 凭证

配置在 `~/.dsh/dsh-astrbot-unified/config.json`，里面有两项：

```json
{
  "astrbot_url": "http://127.0.0.1:6185",
  "astrbot_key": "abk_..."
}
```

`astrbot_key` 需要在 AstrBot 的 WebUI 里创建（设置 → API Key，勾选 `im` 和 `chat` 权限）。
如果还想让 AstrBot 那边真的执行命令（而不是只聊天），要再勾 `chat:admin`；
不勾的话它的 shell / python 工具会报
`Shell execution is disabled by the Local permission policy for this user role (member)`。

## 让 AstrBot 的 LLM 回答

**走本插件的 `/astrbot/ask`，不要直接 curl `/api/v1/chat`。**

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.dsh/dsh-astrbot-unified/config.json'))['token'])")
curl -s -X POST http://127.0.0.1:3188/astrbot/ask \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"你的问题"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['text'])"
```

区别在于：直接打 `/api/v1/chat` 每问一句都会在 AstrBot 里留一条 conversation，
越堆越多还删不掉；`/astrbot/ask` 用一次性的临时 session，拿到答案后立刻把那条
conversation 删掉。

返回里的 `cleaned` 说明删没删成：

```json
{"ok":true,"text":"...","sessionId":"dsh-tmp-...","username":"dsh-bridge","cleaned":{"deleted":true,"cid":"..."}}
```

`cleaned.deleted` 是 `false` 也不影响结果——后台每 30 分钟按 TTL（默认 6 小时）
扫一遍，把漏掉的临时会话清掉。

想保留上下文（连续追问同一个话题）就自己传 `sessionId` 并加 `"keep": true`：

```bash
-d '{"text":"接着说","sessionId":"dsh-tmp-keep-1","keep":true}'
```

`keep` 的会话不会被自动删，要删手动 `POST /astrbot/drop {"sessionId":"..."}`。

`username` 不能填 AstrBot 管理员（`admins_id` 里的号），否则会报
`username is reserved for an AstrBot administrator`；用一个自己的名字即可，
它同时也是 AstrBot 侧的会话归属。

## 往 QQ 发消息

```bash
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.dsh/dsh-astrbot-unified/config.json'))['astrbot_key'])")

# 先查有哪些会话可发
curl -s -H "X-API-Key: $KEY" \
  "http://127.0.0.1:6185/api/v1/conversations?page=1&page_size=20&include_history=false" \
  | python3 -c "
import json,sys
for c in json.load(sys.stdin)['data']['conversations']:
    print(c['user_id'])
"

# 发（umo 从上面查）
curl -s -X POST http://127.0.0.1:6185/api/v1/im/messages \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"umo":"pre-config:GroupMessage:123456","message":"内容","type":"plain"}'
```

## 传文件给 AstrBot

两边共享 `/sdcard/Download/`。把文件写在那里，然后让 AstrBot 去读：

```bash
cp 你的文件 /sdcard/Download/
# 然后调 AstrBot 的 chat，让它读 /sdcard/Download/文件名
```

## 让 AstrBot 拷贝文件 / 重载插件

AstrBot 有 shell 工具，可以自己操作它容器内的文件。但它**不知道重载插件的正确命令**，
需要明确告诉它。

### 拷贝插件文件

```
请把 /sdcard/Download/DSH-Go/astrbot_plugin_dsh_unified/ 下的文件
覆盖复制到 /root/AstrBot/data/plugins/astrbot_plugin_dsh_unified/
```

### 重载插件

AstrBot 的重载命令是 **`/plugin reload <插件名>`**，不是 `/reload`。
如果装了 `astrbot_plugin_cmd_runner`，也可以用 `/插件 重载 <插件名>`。

在 chat 里让它执行：

```
请执行 /plugin reload astrbot_plugin_dsh_unified
```

或者直接用 API（更可靠）：

```bash
# 需要 dashboard JWT，不是普通 API Key
curl -X POST http://127.0.0.1:6185/api/v1/plugins/reload \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"plugin_id":"astrbot_plugin_dsh_unified"}'
```

## 排查

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.dsh/dsh-astrbot-unified/config.json'))['token'])")

# AstrBot 那边现在有哪些会话（temp=true 是没清掉的临时会话）
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3188/astrbot/conversations

# 立刻扫一次（ttlMs=0 表示不管多新都删）
curl -s -X POST http://127.0.0.1:3188/astrbot/sweep \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"ttlMs":0}'
```

## 注意

- AstrBot 可能被系统杀掉，连不上时提示用户打开 App
- 别把 `astrbot_key` 写进代码或提交到 git
- `username` 不能填 AstrBot 管理员号（`admins_id` 里的），会报
  `username is reserved for an AstrBot administrator`
- 想让 AstrBot 真的执行命令，API Key 必须带 `chat:admin`；只有 `chat` 时
  它的 shell / python 工具一律返回 `Permission denied`
- AstrBot 的执行工具默认工作目录是它自己的 workspace（`/root/AstrBot/data/workspaces/...`），
  不是 `/root/AstrBot`，用绝对路径

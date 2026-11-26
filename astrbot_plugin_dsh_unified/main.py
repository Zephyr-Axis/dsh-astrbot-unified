"""DSH 统一桥：LLM 自主调用 DSH + 对话镜像。"""

import asyncio
import json
import uuid

import httpx

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.provider import LLMResponse
from astrbot.api.star import Context, Star

# 告诉 LLM 共享目录在哪，这样传文件不用人插手
SHARE_HINT = """

## 与 DSH 共享文件

你和 DeepSeek Harness（DSH）运行在同一台设备上，共享目录是 `/sdcard/Download/`。

- 要**把文件交给 DSH**：写到 `/sdcard/Download/`，然后在任务里告诉它文件名
- DSH 要**把文件交给你**：它会写在同一个目录，你可以直接读
- 大文件走这里，不要用 base64 或聊天附件

不需要问用户路径，直接用 `/sdcard/Download/`。
"""

# 这些任务 DSH 比 AstrBot 更擅长：给 LLM 看，让它自己判断要不要调用
DSH_TOOL_DESC = (
    "把任务交给本机运行的 DeepSeek Harness（DSH）agent 执行。"
    "DSH 能真实读写文件、执行 shell 命令、跑测试、查系统信息、改代码。"
    "适合：涉及具体文件路径、需要跑命令、需要看系统状态的实操任务。"
    "不适合：纯闲聊、常识问答、你已有把握直接回答的问题。"
)


class DshUnifiedPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig = None):
        super().__init__(context)
        self.config = config or {}
        self._executed: dict[str, bool] = {}     # umo -> 本轮是否调过 dsh_ask
        self._last_bot_text: dict[str, str] = {}
        self._sweep_task: asyncio.Task | None = None

    # ---------- 配置 ----------

    def _cfg(self, key, default=None):
        try:
            return self.config.get(key, default)
        except AttributeError:
            return default

    def _base(self) -> str:
        return str(self._cfg("dsh_url", "http://127.0.0.1:3188") or "").rstrip("/")

    def _token(self) -> str:
        return str(self._cfg("token", "") or "")

    def _timeout(self) -> float:
        return float(self._cfg("timeout_sec", 900) or 900)

    # ---------- 与 DSH 通信 ----------

    async def _post(self, path: str, payload: dict, stream: bool = False):
        """调 DSH。失败只记 warning，绝不中断 AstrBot 正常对话。"""
        if not self._cfg("enabled", True):
            return None
        token = self._token()
        if not token:
            return None
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(None, connect=10.0, read=self._timeout(), write=30.0),
                trust_env=False,
            ) as client:
                if stream:
                    return client.stream("POST", f"{self._base()}{path}", json=payload, headers=headers)
                r = await client.post(f"{self._base()}{path}", json=payload, headers=headers)
                if r.status_code >= 400:
                    logger.warning(f"[dsh] {path} → HTTP {r.status_code}: {r.text[:200]}")
                    return None
                return r.json()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[dsh] {path} 失败：{type(exc).__name__}: {exc}")
            return None

    async def _run_task(self, umo: str, text: str) -> str:
        """把任务交给 DSH 执行，收集流式输出。"""
        token = self._token()
        if not token:
            return "DSH 桥没配 token，先在插件设置里填上。"
        payload = {
            "umo": umo,
            "chatType": "group" if ":GroupMessage:" in umo else "private",
            "senderId": "",
            "text": text,
            "progress": {"mode": "minimal"},   # 工具调用时不刷进度，结果自己会说话
        }
        chunks: list[str] = []
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(None, connect=10.0, read=self._timeout(), write=30.0),
                trust_env=False,
            ) as client:
                async with client.stream(
                    "POST", f"{self._base()}/inbound", json=payload,
                    headers={"Authorization": f"Bearer {token}", "Accept": "text/event-stream"},
                ) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread()).decode("utf-8", "ignore")[:200]
                        logger.warning(f"[dsh] /inbound → HTTP {resp.status_code}: {body}")
                        return f"DSH 拒绝了这次请求（HTTP {resp.status_code}）。"
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        try:
                            data = json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        t = data.get("text") or data.get("message")
                        if t:
                            chunks.append(str(t))
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[dsh] 执行失败：{type(exc).__name__}: {exc}")
            return f"执行出错：{type(exc).__name__}"
        out = "".join(chunks).strip()
        # DSH 的结束标记不进上下文
        return out.replace("—— 本回合结束", "").strip() or "（DSH 没有返回内容）"

    # ---------- LLM 工具：自主判断 ----------

    @filter.llm_tool(name="dsh_ask")
    async def dsh_ask(self, event: AstrMessageEvent, task: str) -> str:
        """把需要真实执行的任务交给本机 DSH agent。

        Args:
            task(string): 要 DSH 做的事，尽量具体，可以包含文件路径。
        """
        if not self._cfg("auto_execute", True):
            return "自主执行已关闭，请让用户直接说明需求。"
        umo = event.unified_msg_origin
        self._executed[umo] = True          # 标记：这一轮不用再镜像助手回复
        result = await self._run_task(umo, task)
        # 长结果原样发一份，让 LLM 只做简短确认（避免转述时丢细节）
        limit = int(self._cfg("long_result_threshold", 1500) or 1500)
        if len(result) > limit or "```" in result:
            try:
                await event.send(MessageChain().message(f"【DSH 输出】\n{result}"))
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[dsh] 发送原始输出失败：{exc}")
            return "详细输出已单独发给用户了。你只需一句话简短确认，不要重复内容。"
        return result

    # ---------- 镜像 ----------

    async def _current_cid(self, event: AstrMessageEvent):
        try:
            return await self.context.conversation_manager.get_curr_conversation_id(
                event.unified_msg_origin
            )
        except Exception:  # noqa: BLE001
            return None

    async def _mirror(self, umo: str, cid: str, role: str, text: str):
        await self._post("/append", {"umo": umo, "cid": cid, "role": role, "text": text})

    @filter.on_llm_request(priority=100)
    async def on_req(self, event: AstrMessageEvent, req):
        # 注入共享目录说明（可关）
        if self._cfg("inject_share_hint", True):
            try:
                sp = getattr(req, "system_prompt", None)
                if isinstance(sp, str) and SHARE_HINT not in sp:
                    req.system_prompt = sp + SHARE_HINT
                elif sp is None:
                    req.system_prompt = SHARE_HINT
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[dsh] 注入提示词失败：{exc}")

        if not self._cfg("mirror_enabled", True) or not self._cfg("mirror_user_msg", True):
            return
        text = (event.message_str or "").strip()
        if not text:
            return
        cid = await self._current_cid(event)
        if cid:
            await self._mirror(event.unified_msg_origin, cid, "user", text)

    @filter.on_llm_response(priority=100)   # 抢在 qzone_tools 等插件 stop_event 之前
    async def on_resp(self, event: AstrMessageEvent, response: LLMResponse):
        umo = event.unified_msg_origin
        # 这一轮调过 dsh_ask → DSH 那边已经有真实回合了，不再重复记录
        if self._executed.pop(umo, False):
            return
        if not self._cfg("mirror_enabled", True) or not self._cfg("mirror_bot_msg", True):
            return
        chain = getattr(response, "result_chain", None)
        if chain is None:
            return
        try:
            text = (chain.get_plain_text() or "").strip()
        except Exception:  # noqa: BLE001
            return
        if not text or self._last_bot_text.get(umo) == text:
            return
        self._last_bot_text[umo] = text
        cid = await self._current_cid(event)
        if cid:
            await self._mirror(umo, cid, "assistant", text)

    @filter.event_message_type(filter.EventMessageType.ALL, priority=200)
    async def on_reset_watch(self, event: AstrMessageEvent):
        """监听 /reset。

        不能用 @filter.command("reset")：AstrBot 内置的 reset 命令优先级更高，
        而且内置命令执行后事件就被 stop 了，我们的钩子根本轮不到。
        所以改成看原始文本 + 高优先级，抢在前面记下 cid，后台延迟通知。
        """
        if not self._cfg("mirror_enabled", True):
            return
        text = (event.message_str or "").strip().lower()
        if text.lstrip("/") not in ("reset", "重置"):
            return
        cid = await self._current_cid(event)
        if not cid:
            return
        # 不能 await 太久：会让内置 reset 延迟。丢到后台任务里等它清完再通知。
        asyncio.create_task(self._notify_reset(event.unified_msg_origin, cid))

    async def _notify_reset(self, umo: str, cid: str):
        await asyncio.sleep(1.2)   # 等 AstrBot 内置 reset 把 history 清空
        await self._post("/reset", {"umo": umo, "cid": cid})

    # ---------- 删除同步（轮询）----------

    async def _list_conv_ids(self):
        try:
            convs = await self.context.conversation_manager.get_conversations()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[dsh] 列会话失败：{type(exc).__name__}: {exc}")
            return None
        out: dict[str, set[str]] = {}
        for c in convs or []:
            umo, cid = getattr(c, "user_id", None), getattr(c, "cid", None)
            if umo and cid:
                out.setdefault(umo, set()).add(cid)
        return out

    async def _mirror_mapping(self) -> dict[str, set[str]]:
        """从 DSH 侧拉映射表，作为「我们记录过什么」的权威来源。

        为什么必须这样：插件重载后内存里的 _seen 是空的，
        如果只拿 AstrBot 当前会话当基线，历史映射就永远对不上，
        删除同步会静默失效（实测踩到）。
        """
        try:
            async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
                r = await client.get(
                    f"{self._base()}/map",
                    headers={"Authorization": f"Bearer {self._token()}"},
                )
                if r.status_code >= 400:
                    logger.warning(f"[dsh] 拉映射表失败 HTTP {r.status_code}")
                    return {}
                data = (r.json() or {}).get("data") or {}
                out: dict[str, set[str]] = {}
                for umo, cids in data.items():
                    if isinstance(cids, dict):
                        out[umo] = set(cids.keys())
                    elif isinstance(cids, list):
                        out[umo] = set(cids)
                return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[dsh] 拉映射表异常：{type(exc).__name__}: {exc}")
            return {}

    async def _sweep_once(self):
        """每轮：拿 DSH 的映射表 vs AstrBot 现状，AstrBot 没有的就清掉。

        不用「基线 + 差异」是因为基线只在启动时建一次，之后新建的映射
        永远不会被纳入比对，删除同步就失效了（实测踩到）。
        """
        now = await self._list_conv_ids()
        if now is None:
            return                      # 读不到就跳过，别误判成全删

        mapped = await self._mirror_mapping()   # DSH 侧：{umo: {cid}}
        if not mapped:
            return

        cleaned = 0
        for umo, cids in mapped.items():
            if umo.startswith("webchat:"):
                continue                # 程序调 API 产生的，不参与
            live = now.get(umo)
            if live is not None and len(live) > 0:
                continue                # 该 umo 还有对话，只是换会话，不动
            # AstrBot 那边这个 umo 一条都不剩 → 真删了，整组清掉
            r = await self._post("/archive-umo", {"umo": umo})
            if r is not None:
                n = r.get("count", 0)
                cleaned += 1
                logger.warning(f"[dsh] umo 已无对话，清空 {umo}：归档 {n} 个")
        if cleaned:
            logger.info(f"[dsh] 本轮清理 {cleaned} 个 umo")

    async def _sweep_loop(self, interval: int):
        while True:
            try:
                await asyncio.sleep(interval)
                await self._sweep_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[dsh] 轮询异常：{type(exc).__name__}: {exc}")

    # ---------- 生命周期 ----------

    @filter.on_plugin_loaded()
    async def on_loaded(self, metadata=None):
        name = getattr(metadata, "name", None) if metadata is not None else None
        if name and name != "astrbot_plugin_dsh_unified":
            return
        if not self._cfg("enabled", True):
            return
        if not self._token():
            logger.warning("[dsh] 没填 token，桥不会工作")
            return
        try:
            async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
                r = await client.get(f"{self._base()}/health")
                info = r.json()
                logger.info(
                    f"[dsh] 已连上 {info.get('plugin')} @{info.get('host')}:{info.get('port')}"
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[dsh] 连不上 {self._base()}：{exc}")
        self._start_sweep()

    def _start_sweep(self):
        if self._sweep_task and not self._sweep_task.done():
            self._sweep_task.cancel()
            self._sweep_task = None
        interval = int(self._cfg("delete_sync_interval_sec", 300) or 300)
        interval = max(30, interval) if interval > 0 else 0
        if interval <= 0:
            logger.info("[dsh] 删除同步已关闭")
            return
        self._sweep_task = asyncio.create_task(self._sweep_loop(interval))
        logger.info(f"[dsh] 删除同步已启动，每 {interval} 秒")

    async def terminate(self):
        self._last_bot_text.clear()
        self._executed.clear()
        if self._sweep_task and not self._sweep_task.done():
            self._sweep_task.cancel()
            try:
                await self._sweep_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._sweep_task = None

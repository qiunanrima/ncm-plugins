# NCM Plugins · BetterNCM 插件两只

给网易云音乐 PC 客户端（BetterNCM II）写的两个插件，一个管**下载**，一个管**自动化**。

| 插件 | 作用 | 目录 |
| --- | --- | --- |
| **NCM Playback DL** | 让下载走「播放接口」，批量下歌 + 歌单/播放次数信号导出 | [`ncm-playback-dl/`](ncm-playback-dl/README.md) |
| **NCM Agent Bridge** | 把客户端变成可脚本控制的「遥控器」：播放/歌单/搜索/点击/JS 执行 | [`ncm-agent-bridge/`](ncm-agent-bridge/README.md) |

两者都通过 `文件队列`（`inbox/*.json` → `outbox/*.res.json`）跟外部脚本通信，不用开端口、不用改 hosts。

---

## 1. NCM Playback DL

网易云的「下载」队列受会员码率上限限制，但「播放」接口能给到更高音质。
这个插件把播放地址抓下来，直接落盘成可播放的 mp3/flac。

- 走 `/api/song/enhance/player/url/v1`（播放接口）拿地址 → 渲染进程 fetch → 写文件
- 支持队列批量、断点续跑、失败清单
- 附带 `signals-all`：导出歌单 + `t_i`（加入时间）+ `m_i`（播放次数）
- `docs/eapi-笔记.md`：**eapi 加密逆向完整笔记**（AES-128-ECB + hex + `e_r:false` 明文技巧），含纯 Python 实现 `docs/eapi.py`

实测：2253 首下载队列 → 成功 2018 / 跳过 232 / 失败 3。

## 2. NCM Agent Bridge

把播放器包成一组 op，外部 PowerShell/Node 脚本可以：

```powershell
.\tools\ncm.ps1 status          # 当前播放/进度/音量/模式
.\tools\ncm.ps1 play -Id 123    # 播放指定歌曲
.\tools\ncm.ps1 playlist -Id x  # 读歌单
.\tools\ncm.ps1 query -Text "关键词"
.\tools\ncm.ps1 js -Text "location.reload()"
```

包含播放控制、歌单读取、搜索、DOM 点击/输入、任意 JS 执行。

---

## 安装

1. 装 [BetterNCM II](https://github.com/BetterNCM/BetterNCM-II)
2. 把对应目录下的 `dist/*.plugin` 拖进 BetterNCM 插件目录，或直接把 `plugin/` 拷到
   `C:\betterncm\plugins_dev\<slug>\`
3. 重启网易云（或 BetterNCM → 重载插件）

CSV 文件队列默认落在 `C:\betterncm\PlaybackDL\`、`C:\betterncm\AgentBridge\`。

## 说明

- 只操作本机已登录的客户端，不涉及账号密码，不绕过付费内容（拿不到地址就是拿不到）。
- 接口会随客户端版本变化，逆向结论记录在各目录的 README / docs 里。
- 请低频使用，别把号跑没了。

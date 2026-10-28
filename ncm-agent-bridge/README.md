# NCM Agent Bridge

把网易云音乐变成 **可被 AI / 脚本操作** 的播放器 —— 一个 BetterNCM 插件 + 一套命令行客户端。

> 已在 **网易云音乐 2.10.13.202675 + BetterNCM 1.3.4** 上实测通过。
> 插件跑在网易云的渲染进程里，用网易云自己的播放条 / 内部通道操作它；外部程序通过
> `<BetterNCM>\AgentBridge` 下的文件队列收发命令，**不监听任何端口**。

```
┌────────────┐  写命令 JSON   ┌──────────────────┐   DOM / channel   ┌──────────────┐
│ 你的脚本 /  │ ────────────▶ │  AgentBridge/    │ ───────────────▶ │ 网易云音乐    │
│ AI Agent   │               │  inbox/*.json    │                  │ （渲染进程）  │
│            │ ◀──────────── │  outbox/*.res    │ ◀─────────────── │              │
└────────────┘  读结果 JSON   └──────────────────┘   回读状态校验     └──────────────┘
        ▲                            ▲
        └──── tools/ncm.ps1 ─────────┘  （生成命令 / 等待结果 / 打印状态）
```

---

## 一、能力一览

| 能力 | op | 状态 |
| --- | --- | --- |
| 读取播放状态（歌名/歌手/专辑/进度/时长/音量/模式/音质） | `status` | ✅ 实测 |
| 播放 / 暂停 / 切换 | `play` `pause` `toggle` | ✅ 实测 |
| 下一首 / 上一首 | `next` `prev` | ✅ 实测 |
| 跳转进度 | `seek` | ✅ 实测（播放中可靠；暂停时客户端会重置进度，见限制） |
| 播放模式（顺序/随机/单曲/列表/FM） | `mode` | ✅ 实测（合成点击） |
| 音质切换（标准/较高/极高/无损） | `quality` | ✅ 代码就绪 |
| 读取我的歌单列表 | `playlists` | ✅ 实测 |
| 读取歌单里的歌曲（含歌单页导航） | `playlist` | ✅ 实测 |
| 下载管理页任务列表 + 下载目录 | `downloads` | ✅ 可用（先 `navigate` 到下载页） |
| 下载指定歌曲 | `download` | ⚠️ 尽力而为（见限制） |
| 调节音量 | `volume` | ⚠️ 尽力而为（见限制） |
| 任意 DOM 查询 / 点击 / 输入 | `query` `html` `click` `type` | ✅ |
| 直接调用网易云内部通道 | `channel` | ✅ |
| 执行任意 JS（调试用） | `js` | ✅ |

---

## 二、目录结构

```
ncm-agent-bridge/
├── plugin/                 BetterNCM 插件（这个才是核心）
│   ├── manifest.json
│   └── main.js             ~1200 行：RPC 队列 + 播放控制 + 歌单/下载 + 诊断
├── tools/
│   ├── ncm.ps1             命令行客户端（status / play / next / playlists / playlist ...）
│   ├── install.ps1         安装到 plugins_dev（自动重载）或打包成 .plugin；-Restart 可重启网易云
│   └── realclick.ps1       真实鼠标点击（当合成事件不生效时的兜底，可选）
├── dist/
│   └── NCM-AgentBridge-1.3.0.plugin   打包好的插件（双击/放进 plugins 文件夹即可）
└── README.md
```

---

## 三、安装

```powershell
# 1) 安装到开发目录（会随文件修改自动重载，推荐）
.\tools\install.ps1                  # 复制到 C:\betterncm\plugins_dev\ncm-agent-bridge

# 2) 让网易云加载插件（二选一）
.\tools\install.ps1 -Restart         # 由脚本重启网易云（会中断几秒播放）
# 或：打开网易云 → 点 BetterNCM 图标 → 「重载插件」

# 3) 验证
.\tools\ncm.ps1 status
```

> BetterNCM 只在启动时扫描插件，**新插件必然需要重载一次**；之后的改动走
> `plugins_dev` 的目录监听，会自动刷新页面并重载插件。

正式安装（不用开发目录）时，把 `dist\NCM-AgentBridge-1.3.0.plugin` 放进
`C:\betterncm\plugins\`，重启网易云即可。**注意** `plugins_dev` 与 `plugins` 里的
同名插件只会加载一个（slug 重复），不要同时放两份。

---

## 四、快速上手

```powershell
cd F:\CloudMusic\ncm-agent-bridge

.\tools\ncm.ps1 status                 # 当前在放什么
.\tools\ncm.ps1 pause                  # 暂停
.\tools\ncm.ps1 play                   # 继续
.\tools\ncm.ps1 next                   # 下一首
.\tools\ncm.ps1 seek -To 90            # 跳到 1:30
.\tools\ncm.ps1 playlists              # 我的歌单（id + 名称）
.\tools\ncm.ps1 playlist -Id 398968210 -To 20   # 歌单前 20 首
.\tools\ncm.ps1 download -Id 77448     # 下载某首歌（尽力而为，见限制）
.\tools\ncm.ps1 downloads              # 下载管理（任务 + 存储目录）
.\tools\ncm.ps1 navigate -Text "#/m/offline/download/"   # 打开任意页面
```

输出示例：

```
  ▶ 播放中   すずめ feat.十明
            RADWIMPS / 十明
    进度 1:04 / 3:56    音量 90    ID 1984758339
    模式 order
```

所有命令都支持 `-Raw` 输出原始 JSON，方便脚本/AI 消费：

```powershell
.\tools\ncm.ps1 status -Raw | ConvertFrom-Json
```

---

## 五、协议（文件队列）

插件不开放端口。外部程序把命令写成 JSON 放进 `<BetterNCM>\AgentBridge\inbox\`，
插件执行后把结果写到 `outbox\`（文件名相同，`.res.json` 结尾），并删除命令文件。

命令：

```json
{
  "id": "1793031011406-ab12cd",
  "op": "seek",
  "args": { "seconds": 90 },
  "timeoutMs": 15000
}
```

结果：

```json
{
  "id": "1793031011406-ab12cd",
  "ok": true,
  "op": "seek",
  "data": { "seeked": true, "seconds": 90, "progressMs": 90321, "strategy": "channel" },
  "ms": 412,
  "ts": 1793031011820
}
```

失败：

```json
{ "id": "...", "ok": false, "op": "seek",
  "error": { "code": "NOT_CONFIRMED", "message": "跳转进度没有被确认", "extra": { "target": 90 } } }
```

另外每秒刷新一次：

* `AgentBridge\status.json` —— 当前状态心跳（CLI 的 `peek` 和设置页直接读它）
* `AgentBridge\hello.json` —— 插件启动信息（版本、网易云版本、session）
* `AgentBridge\plugin-error.json` —— 启动异常时的堆栈

> **不会「假装成功」**：所有写操作都会回读状态（DOM / 原生事件 / 内部接口）后才返回
> `ok:true`；回读不到就返回 `NOT_CONFIRMED` 并附上观测值。

---

## 六、op 参考

| op | 参数 | 说明 |
| --- | --- | --- |
| `ping` | — | 存活探测，返回插件版本/session/网易云版本 |
| `status` | — | 播放状态（`playing` `track{id,title,artists,album,cover}` `progressMs` `durationMs` `volume` `mode` `quality`） |
| `toggle` / `play` / `pause` | — | 播放控制，点击播放条上的真实按钮并校验状态 |
| `next` / `prev` | — | 切歌，校验曲目 id 改变 |
| `seek` | `{seconds}` 或 `{ms}` | 优先走内部通道 `audioplayer.seek`，失败再点进度条 |
| `volume` | `{value: 0-100}` | 拖拽音量条（需要 hover，见限制） |
| `mode` | `{mode: order\|random\|single\|loop\|fm}` | 循环点击模式按钮直到命中 |
| `quality` | `{quality: standard\|higher\|exhigh\|lossless}` | 打开音质菜单并点选 |
| `playlists` | — | 我的歌单（侧边栏）`[{id,name,visible}]` |
| `playlist` | `{id, offset?, limit?}` | 打开歌单页并抓取 `[{id,title,artists,album,duration}]` |
| `download` | `{id?}` | 点当前页面该歌曲行的下载按钮（不传 id 则用当前播放歌曲） |
| `downloads` | `{tab?, limit?}` | 下载管理页任务列表 + 存储目录 |
| `navigate` | `{hash}` | 跳转到任意页面（`#/m/playlist/?id=...`、`#/m/offline/download/` 等） |
| `query` | `{selector, limit?}` | 查询 DOM 元素（含 rect），写自动化脚本的基础 |
| `html` | `{selector, limit?}` | 取元素 outerHTML |
| `click` | `{selector, index?, xRatio?, yRatio?, waitMs?}` | 合成点击（React/nej 都能收到） |
| `type` | `{selector, text, enter?}` | 往输入框写值并回车 |
| `channel` | `{name, args}` | 直接调网易云内部通道（`audioplayer.*` / `winhelper.*` / `app.*`） |
| `js` | `{code}` | 在插件作用域里 eval（可访问插件内部变量，调试神器） |
| `diagnose` | — | 环境自检：DOM 结构、模块 id、通道探测结果 |
| `log` | — | 最近 40 条命令日志 |
| `reload` | — | 重新加载页面（等价于开发者刷新） |

---

## 七、实现原理（踩过的坑）

1. **为什么不直接跑 HTTP 服务？**
   BetterNCM 插件跑在 CEF 渲染进程里，JS 无法监听端口；BetterNCM 自己的 HTTP 服务
   （`127.0.0.1:<port>/api/*`）需要渲染进程里的 `BETTERNCM_API_KEY`，外部拿不到。
   所以用「本地文件队列 + BetterNCM Native FS」：同步读写、`watchDirectory` 事件驱动，
   实测延迟 < 100ms。

2. **状态从哪来？**
   - 歌曲信息：`betterncm.ncm.findApiFunction('getPlaying')()` —— 网易云内部的
     `getPlaying()`，能拿到完整 track（含 `artists` / `album` / `duration` / `privilege`）。
   - 进度/时长：注册原生事件 `legacyNativeCmder.appendRegisterCall('PlayProgress'|'Load'|'PlayState','audioplayer', cb)`；
     页面 DOM（`time.now` / `time.all` / `.prg .has` 宽度）作为兜底。
   - 播放状态：`.btnp` 是否有 `btnp-pause` 类 + `getPlaying().state`（2=播放）。

3. **控制从哪来？**
   优先「和用户点一样的按钮」：`#main-player .btnp`（播放/暂停）、`.btnc-nxt/.btnc-prv`（切歌）、
   `.type`（模式）、`.brt .brttext` + `.brtlist li[data-brt]`（音质）。
   跳进度走内部通道 `channel.call('audioplayer.seek', cb, [trackId, token, seconds])`
   （第三个参数是**秒**，token 形如 `id|seek|random`）。
   DOM 一切选择器都加了多级兜底，并在执行后回读校验。

4. **播放条 DOM（2.10.x）**

   ```html
   <div id="main-player" class="m-player">
     <div class="btnc btnc-prv">上一首</div>
     <div class="btnp btnp-play|btnp-pause">播放/暂停</div>
     <div class="btnc btnc-nxt">下一首</div>
     <time class="now">01:04</time>
     <div class="prg"><span class="has" style="width:27%"></span></div>
     <time class="all">03:56</time>
     <div class="spk j-vol">静音</div>
     <div class="prg-spk j-vol"><div class="wrap"><div class="has" style="height:90%"></div></div></div>
     <div class="brt"><span class="brttext">极高</span><div class="brtlist">…音质…</div></div>
     <div class="type type-random|type-order">模式</div>
     …
   </div>
   ```

   歌单页：行是 `li.itm[data-res-type="4"][data-res-id="<songId>"][data-res-data="<playlistId>"]`，
   里面 `.tit`（歌名）、`.td.col`（歌手 / 专辑 / 时长）、`.offline-<id>`（下载按钮）。

---

## 八、已知限制

* **音量 / 下载按钮依赖真实鼠标 hover**：这两个控件的显示与命中由 CSS `:hover` 控制
  （`.prg-spk` 在 hover 前是 `pointer-events:none`），合成事件点不到；插件会尝试并
  **如实返回 `verified:false`**，不会谎报成功。想要真正操作，可用
  `tools\realclick.ps1`（真实光标移动 + 点击，会把网易云窗口置前）：
  ```powershell
  .\tools\realclick.ps1 -Selector ".itm[data-res-id='77448'] [class*='offline-']" `
                        -HoverSelector ".itm[data-res-id='77448']"
  ```
* **暂停时 seek 会被客户端重置**：网易云在暂停态会丢弃 seek 并回到原位置，建议先 `play` 再 `seek`。
* **下载需要账号权限**：无损/极高音质下载需要会员；点击后网易云可能弹自己的会员对话框。
* **版本绑定**：DOM 选择器与内部通道名来自 2.10.13 实测；换大版本后请先跑
  `ncm.ps1 diagnose -Raw`（或插件设置页的「运行自检」）确认结构。
* **`js` / `channel` op 是双刃剑**：可以执行任意代码、调用任意内部通道，错误参数可能让
  渲染进程卡死（我在开发中就遇到过，重启网易云即可恢复）。仅供本机调试使用。

---

## 九、开发与调试

```powershell
# 改完 plugin/main.js 后
node --check plugin/main.js
.\tools\install.ps1          # 复制到 plugins_dev，目录监听会自动刷新页面并重载插件

# 看插件在页面里看到了什么
.\tools\ncm.ps1 diagnose -Raw
.\tools\ncm.ps1 js -Text 'document.title'
.\tools\ncm.ps1 query -Selector "#main-player .type" -Raw
.\tools\ncm.ps1 channel -Name "audioplayer.seek" -ArgsJson '[0,"t",30]'
```

* 网易云里按 `F12` 可以直接开 DevTools 控制台。
* 插件设置页（BetterNCM → 插件列表 → NCM Agent Bridge）能看到实时状态、命令日志、
  「打开数据目录」「运行自检」「显示悬浮标」开关。
* `plugins_dev` 目录里的插件改动会自动重载；**不要删除插件目录本身**，否则
  BetterNCM 的 `watchDirectory` 句柄会失效（`install.ps1` 已经改成原地覆盖）。

---

## 十、安全

* 不监听端口，不联网，只读写 `<BetterNCM>\AgentBridge`。
* 命令队列完全在本机文件系统里 —— 能写这个目录的进程本来就能控制你的会话。
* `channel` / `js` op 提供的是「本机调试级」权限，请勿把 `AgentBridge` 目录共享出去。

---

## 十一、参考

* BetterNCM 开发文档：<https://github.com/std-microblock/chromatic/wiki/开发文档>
* BetterNCM 插件基本结构：<https://github.com/std-microblock/chromatic/wiki/插件的基本结构>
* BetterNCM JavaScript / Native API：<https://github.com/std-microblock/chromatic/wiki/JavaScript-API>

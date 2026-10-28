# NCM Playback DL

**让「下载」走「播放」的接口。**

网易云的播放和下载是两条链路：播放按 `maxPlayBr`/播放权限给地址，下载按 `maxDownBr`/下载设置另给一份。
同一首歌，播放能到 320k，下载队列里拿到的却常常是 128k —— 这个插件就是用来补上这个差距的。

> 实测（网易云 2.10.13.202675 + BetterNCM 1.3.4，同一首歌《挚友》）：
>
> | | 来源 | 大小 | 码率 | 说明 |
> | --- | --- | --- | --- | --- |
> | 客户端下载 | 下载队列（`eapi/song/enhance/download/url/v1`） | 5,015,174 B | ≈128k | `F:\CloudMusic\周兴哲 - 挚友.mp3` |
> | 播放取流 | 播放接口（`/api/song/enhance/player/url/v1`） | 12,534,765 B | 320k | 播放缓存里的那份 |
> | **本插件** | 播放接口 + 直接落盘 | **12,534,765 B** | **320k** | md5 `b32729…f272e` 与接口完全一致 |

---

## 一、原理

```
插件（渲染进程，自带登录 cookie）
   │  ① GET /api/song/enhance/player/url/v1?ids=[id]&level=exhigh&encodeType=mp3
   │     ← 和网易云播放时用的是同一个接口：{ url, br, size, md5, type, level, fee }
   │  ② fetch(url) 拿音频字节（CDN 允许页面直接取，实测 12.5MB 完整拿到）
   │  ③ betterncm.fs.writeFile(目标路径, Blob)  →  普通 mp3 / flac
   ▼
F:\CloudMusic\周兴哲 - 挚友.mp3   （ID3 头 + md5 与接口一致）
```

* **不碰下载队列**：不会写客户端的「正在下载」列表，也不受下载码率设置影响。
* **不复用播放缓存**：播放缓存 `Cache\*.uc` 是加密容器（实测头 `EA E7 90 A7 A3 A3…`，不是裸 mp3），
  要导出得先解密；直接调播放接口拿原始音频更干净。
* **权限和播放一致**：播放不了的（无版权 / 需要会员）这里也拿不到，会明确报 `NO_URL` / `TRIAL_ONLY`。

---

## 二、安装

```powershell
cd F:\CloudMusic\ncm-playback-dl
.\tools\install.ps1 -Restart      # 复制到 plugins_dev\ncm-playback-dl 并重启网易云
# 或者：把 dist\NCM-PlaybackDL-1.0.0.plugin 放进 C:\betterncm\plugins\ 后重启网易云
```

装好后验证：

```powershell
.\tools\ncmdl.ps1 ping
# ✓ PlaybackDL 1.0.0，默认目录 F:/CloudMusic
```

---

## 三、用法

```powershell
# 看歌曲信息（/api/v3/song/detail）
.\tools\ncmdl.ps1 song -Id 2049541052

# 只看播放地址，不下载
.\tools\ncmdl.ps1 url -Id 2049541052 -Level exhigh

# 用播放接口下载（默认存到 F:\CloudMusic）
.\tools\ncmdl.ps1 fetch -Id 2049541052 -Level exhigh

# 换目录 / 换音质（standard / higher / exhigh / lossless / hires）
.\tools\ncmdl.ps1 fetch -Id 2049541052 -Level lossless -Dir "F:/CloudMusic/无损"

# 下载当前正在播放的歌
.\tools\ncmdl.ps1 current -Level exhigh
```

输出：

```
✓ 已通过播放接口下载：12,534,765 字节  exhigh(320000)  mp3
  文件：F:/CloudMusic/周兴哲 - 挚友.mp3
  歌曲：挚友 — 周兴哲
  校验：大小一致 ✓
```

## 三·五、下载队列批处理（「队列里的也走这条路」）

网易云「本地与下载 → 正在下载」里卡住的队列，可以直接用播放接口重取：

```powershell
# 1) 先看看队列里有什么（会打开客户端的下载管理页）
.\tools\ncmdl.ps1 queue -Limit 20

# 2) 批处理：默认跳过已存在的文件，-Force 覆盖旧的低码率文件
.\tools\ncmdl.ps1 fetch-queue -Limit 10 -Level exhigh
.\tools\ncmdl.ps1 fetch-queue -Limit 10 -Force          # 覆盖同名旧文件

# 分批跑完 200 条（每批之间可以随时停）
.\tools\ncmdl.ps1 fetch-queue -Limit 20 -Force
```

实测：队列里 200 条全部是「已暂停」（客户端自己下不动），用播放接口直接拿到了 320k：

```
queue: 200 条
fetch-queue -Limit 1 -Force
  ✓ 米店 → F:/CloudMusic/张玮玮 - 米店.mp3  (13,472,958B)
```

行为说明：

* 逐首处理，**单首失败不影响后面的**（返回里每项都有 `ok/error`，常见 `NO_URL`（无版权/需会员）、`TRIAL_ONLY`（只给试听））。
* **不会改动客户端队列**：不写入、不删除、不标记完成；确认文件都下好了，再自己去下载页清理队列。
* 默认 `onExists=skip`（已存在就跳过），`-Force` 才会覆盖成高码率文件。
* 200 首 × 10–15MB ≈ 2–3GB，注意磁盘；单首无损可能要 30–50MB、耗时更久。

---

## 四、op 参考
| op | 参数 | 返回 |
| --- | --- | --- |
| `ping` | — | 插件版本、默认目录、可用音质 |
| `song` | `{id}` | 歌名 / 歌手 / 专辑 / 时长 |
| `url` | `{id, level?}` | `{url, br, size, md5, format, level, fee}`（地址短时效，别缓存） |
| `fetch` | `{id, level?, dir?, timeoutMs?}` | 下载并落盘：`{path, bytes, br, level, format, md5, verified, song}` |
| `fetch_current` | `{level?, dir?}` | 对当前播放歌曲执行 `fetch` |
| `queue` | `{limit?, page?}` | 读客户端「正在下载」队列（分页，每页 200）：`{page, pageCount, tasks:[{id,title,status}]}` |
| `dump_queue` | — | 顺序翻完所有页，一次拿全队列 id（`{count, ids:[{id,title}]}`） |
| `verify_queue` | `{limit?, offset?, page?, level?}` | 逐首核对队列歌曲是否在库，缺的补下 |
| `fetch_queue` | `{limit?, level?, dir?, force?, delayMs?}` | 把队列里的歌逐首用播放接口下载：`{attempted, ok, skipped, failed, items[]}` |
| `me` | — | 登录账号：`{uid, nickname, vipType}` |
| `records` | `{type?: 0|1}` | 听歌排行 Top100（0=全时段，1=本周）：`{items:[{id,name,artists,playCount,score}]}` |
| `playlist_api` | `{id, detail?, limit?, offset?}` | 歌单 API 版：每首带 `addTime`（加入时间，毫秒）+ 歌名/歌手/专辑/时长 |
| `signals` | `{id}` | 单个歌单的推荐信号：`tracks[]` 带 `addTime` + `playCount`/`weekPlayCount`/`inTopAll` |
| `signals_all` | `{out?, limit?}` | 遍历全部歌单，导出合并后的 `m_i`/`t_i` JSON 到磁盘，只返回摘要 |
| `log` | — | 最近 40 条命令 |
| `js` | `{code}` | 调试用 eval |

音质档位（`level` → 实际码率 / 容器）：

| level | br | encodeType |
| --- | --- | --- |
| `standard` | 128k | mp3 |
| `higher` | 192k | mp3 |
| `exhigh` | 320k | mp3 |
| `lossless` | 999k | flac |
| `hires` | 1999k | flac |

---

## 四·五、推荐信号：播放次数 m_i 与加入时间 t_i

给 `recommender/`（时间 × 频次加权向量）用的两个信号，全部在本机实测通过：

| 信号 | 来源 | 覆盖 | 说明 |
| --- | --- | --- | --- |
| `m_i` 累计播放次数 | `/api/v1/play/record?uid=&type=0`（全时段）/ `type=1`（本周） | **只有 Top100**，无分页 | 榜单外的歌拿不到次数；用 `inTopAll/inTopWeek` 区分「真的 0」和「没进榜」 |
| `t_i` 加入歌单时间 | `/api/v6/playlist/detail` 的 `trackIds[].at` | **全量** | 毫秒时间戳，真实加入时间；个别歌单可能为 `null` |

> 数据通路：插件在**渲染进程**里用 `interface.music.163.com` + 客户端 cookie 直接 `fetch`（实测 200），
> 不需要 `music.163.com/api` 直连，也不需要代理。

```powershell
.\tools\ncmdl.ps1 me                                  # uid / 昵称 / vip
.\tools\ncmdl.ps1 records -Type 0                     # 全时段 Top100（含 playCount）
.\tools\ncmdl.ps1 records -Type 1                     # 本周 Top100
.\tools\ncmdl.ps1 playlist-api -Id 398968210          # 歌单每首带 addTime（加入时间）
.\tools\ncmdl.ps1 signals -Id 398968210               # 单歌单：t_i + m_i 合并
.\tools\ncmdl.ps1 signals-all -Out F:/CloudMusic/ncm-playback-dl/tmp/signals_all.json   # 全部歌单合并导出
```

`signals_all` 导出的 JSON 结构（只写盘，RPC 只回摘要，避免几 MB 数据挤爆队列）：

```json
{
  "uid": "1776754239",
  "generatedAt": "2026-10-28T03:18:36.778Z",
  "topAll": 100, "topWeek": 100,
  "playlists": [{ "id": "2686243068", "name": "我喜欢的音乐", "trackCount": 1485, "tracks": 1485 }],
  "songCount": 5432,
  "songs": [{
    "id": "3385634590",
    "name": "La Gloire à Mes Genoux",
    "artists": ["邹十八"], "album": "...", "durationMs": 160680,
    "playCount": 0, "weekPlayCount": 3,
    "inTopAll": false, "inTopWeek": true,
    "playlists": { "2686243068": 1793113085763 }
  }]
}
```

推荐器里的用法建议：

* `playlists[pid]` 直接当 `t_i`（毫秒）；缺失就当作「同一天加入」退化处理。
* `playCount` 是稀疏的：`inTopAll=false` 时**不要当 0 次**，按「未知」处理（或用 `weekPlayCount` 做近 7 天热度）。
* 需要「最近常听」时优先用 `inTopWeek/weekPlayCount`，比全时段次数更贴近期行为。

---

## 五、文件队列协议

和 AgentBridge 同一套思路，只是目录独立（两个插件互不干扰）：

```
C:\betterncm\PlaybackDL\
├── inbox\<id>.json        ← 外部写命令
├── outbox\<id>.res.json   ← 插件写结果
├── status.json            ← 心跳
└── hello.json             ← 启动信息
```

```json
{ "id": "1793...-ab12cd", "op": "fetch", "args": { "id": "2049541052", "level": "exhigh" }, "timeoutMs": 180000 }
```

```json
{ "id": "1793...-ab12cd", "ok": true, "op": "fetch",
  "data": { "path": "F:/CloudMusic/周兴哲 - 挚友.mp3", "bytes": 12534765,
            "br": 320000, "level": "exhigh", "format": "mp3", "verified": true } }
```

---

## 六、已知限制

* **不是「官方下载」**：文件不会出现在网易云的下载库/「本地与下载」里，需要自己按库目录扫描或手动导入。
* **权限跟播放一致**：无版权、需要会员但未登录的歌曲拿不到地址（`NO_URL`）；只给试听的歌会拒绝保存（`TRIAL_ONLY`）。
* **地址短时效**：`url` op 返回的地址几分钟后失效，`fetch` 里是即取即用。
* **大文件耗时**：无损单曲 30–50MB，`fetch` 走 `fetch()` + `writeFile`，慢于客户端多线程下载；超时可传 `timeoutMs`。
* **文件名可能重复**：同名歌手+歌名会覆盖，需要区分请自己传 `dir` 或用 `-Keep` 保留结果观察。
* **依赖客户端版本**：接口路径来自 2.10.13 实测；换大版本后用 `url` op 先验一下。

---

## 七、和 NCM Agent Bridge 的关系

* `F:\CloudMusic\ncm-agent-bridge` —— 控制播放（状态/播放/暂停/切歌/进度/歌单/诊断），队列在 `AgentBridge\`。
* `F:\CloudMusic\ncm-playback-dl` —— 只管「用播放接口下载」，队列在 `PlaybackDL\`。
* 两个插件可以同时装、互不影响；CLI 分别是 `ncm.ps1` 和 `ncmdl.ps1`。

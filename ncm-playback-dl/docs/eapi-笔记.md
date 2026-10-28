# 网易云 eapi 逆向 + 每首歌的真实播放次数

> 最后更新：2026-10-28　适用：网易云 PC 客户端 2.10.x / 移动端 9.5.x（同一套 key）
> 全部结论都用真实抓包 + 实际请求验证过，不是猜的。

---

## 0. 一句话结论

| 你要的东西 | 从哪拿 | 状态 |
| --- | --- | --- |
| **每首歌「你听了几次」** | 歌曲百科页第一个区块的 `rnData.totalPlay.playCount` | ✅ 已打通，命令可直接用 |
| 首听时间 | 同一区块 `rnData.firstListen.timestamp` | ✅ |
| 累计听歌时长（分钟） | 同一区块 `rnData.totalPlay.duration` | ✅ |
| `t_i` 加入歌单时间 | `/api/v6/playlist/detail` 的 `trackIds[].at` | ✅ 全量 |
| Top100 播放次数（全时段/本周） | `/api/v1/play/record?type=0/1` | ✅ 但只有 100 条、无分页 |

**关键突破**：eapi 的加密已经完全复刻（和抓包**逐字节一致**），所以任何 eapi 接口都能自己调；
请求里带 `"e_r": false` 时，**服务端直接返回明文 JSON**，连响应解密都省了。

---

## 1. eapi 协议（已验证）

```
key    = "e82ckenh8dichen8"                       # AES-128，16 字节，硬编码在客户端里
salt   = "-36cd479b6b5-"
明文   = path + salt + json + salt + md5("nobody" + path + "use" + json + "md5forencrypt")
params = AES-128-ECB(明文, PKCS7) → **十六进制大写**（不是 base64！）
```

两个关键坑：

1. **明文里的 path 是 `/api/...`，不是 URL 上的 `/eapi/...`**
   URL 走 `/eapi/xxx`，但参与签名的路径是 `/api/xxx`。这两个搞混就永远是 400/404。
2. 输出是 **hex（大写）**。抓包里看到 512 个字符 = 256 字节 = 16 个分组，不是 base64。

响应的三种形态：

| 请求里的 `e_r` | 响应 |
| --- | --- |
| `false` 或省略 | **明文 JSON**（推荐） |
| `true` | `HTTP(brotli) → AES-128-ECB → gzip → JSON` |

### Python（无第三方依赖，`docs/eapi.py`，已与抓包逐字节核对）

```python
import eapi

params = eapi.eapi_encrypt('/api/song/play/user/personal/items', {
    "e_r": True,
    "extJson": '{"sharkBabyGroup":"","currentTabList":"[\\"main\\",\\"explore\\"]"}',
    "header": "{}",
})
# => 3B89641844C3442B...  （和抓包 512 字符完全一致 ✅）
```

`docs/eapi.py` 自带 `wiki_playcount(session, song_id)`，见第 3 节。

### Node（`tools/eapi52.js`，解密抓包用）

```powershell
# 把抓包里的 params 十六进制解成明文
node tools/eapi52.js params tmp/params.hex
# 解密一个抓包响应文件（自动 brotli → AES → gunzip）
node tools/decode_resp.js "<captured response file>"
```

---

## 2. 已验证的接口清单

| 接口（URL 前缀 `https://interface3.music.163.com`） | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `POST /eapi/link/page/parent/relation/construct/info?extJson=...&positionCode=songWikiMainPosition` | `{e_r:false, extJson, positionCode, header:"{}"}` | 百科页全部区块（48KB） | **播放次数在这里** |
| `POST /eapi/song/play/user/personal/items` | `{songId, e_r:false}` | 播放页菜单（播放设备/插播相似/歌曲百科/下载/更多） | 不是次数 |
| `POST /eapi/song/feature/detail` | `{c:"[{\"id\":\"<id>\",\"v\":0}]", e_r:false}` | BPM/曲风/节拍/能量曲线 | 音频分析 |
| `GET /api/nuser/account/get` | — | `profile.userId / nickname / vipType` | 拿 uid |
| `GET /api/v1/play/record?uid=&type=0` | `type=0` 全时段 / `1` 本周 | `allData/weekData` 各 100 条，含 `playCount` | **limit/offset 无效** |
| `GET /api/v6/playlist/detail?id=&n=1000` | — | `trackIds[].at` = 加入时间(ms) | `t_i` 来源 |
| `GET /api/v3/song/detail?c=[{"id":..}]` | 每批 ≤100 个 | 歌名/歌手/专辑/时长 | 批量元数据 |
| `GET /api/user/playlist?uid=&limit=1000` | — | 全部歌单（含 trackCount） | 有 33 个 |
| `GET /api/song/enhance/player/url/v1?ids=[id]&level=exhigh&encodeType=mp3` | — | 播放地址（下载用） | 见另一个插件 |

> 明文 `GET /api/...` 直接用页面 cookie 就能调（`interface.music.163.com` 也可以，两个 host 等价）。

---

## 3. 「每首歌听了几次」怎么取（核心）

### 请求

```
POST https://interface3.music.163.com/eapi/link/page/parent/relation/construct/info
     ?extJson={"states":{"playingResource":{"current":"<songId>","scene":"songWiki"}}}
     &positionCode=songWikiMainPosition

body: params=<eapi_encrypt('/api/link/page/parent/relation/construct/info', {
        "e_r": false,
        "extJson": "<和 URL 里一模一样的字符串>",
        "positionCode": "songWikiMainPosition",
        "header": "{}"
      })>
```

### 返回（只看第一个区块）

```json
{
  "code": 200,
  "data": {
    "blocks": [{
      "blockCode": "songWikiFirstListen",
      "rnData": {
        "totalPlay": {
          "duration": 121,            // 累计分钟
          "playCount": 52,            // ★ 你听过多少次
          "moduleTitle": "累计播放",
          "text": "如同微风轻拂21780米"
        },
        "firstListen": { "timestamp": 1641478784000 }   // 第一次听（毫秒）
      }
    }]
  }
}
```

### 解析代码（Python，`docs/eapi.py` 已带）

```python
import requests, eapi

s = requests.Session()
s.cookies.set('MUSIC_U', '<从浏览器/客户端拿到的 cookie>')
print(eapi.wiki_playcount(s, '1864305690'))
# {'songId': '1864305690', 'playCount': 52, 'durationMin': 121,
#  'firstListenAt': 1641478784000, 'text': '如同微风轻拂21780米'}
```

### 实测样例（互相印证）

| 歌曲 | 百科 playCount | Top100 里的次数 | 首听 |
| --- | --- | --- | --- |
| フォニイ (1888688617) | **882** | **882** ✅ 一致 | 2022-03-31 |
| ぴんく (1864305690) | 51→52（一直在播） | 不在 Top100 | 2022-01-06 |
| La Gloire... (428649319) | 6 | 不在 Top100 | 2026-10-26 |

> 结论：百科里的数字和听歌排行同源，就是个人累计播放次数。Top100 之外的歌只有这里能查到。

### 覆盖率

少数歌曲没有 `songWikiFirstListen` 区块（例如重复版本、冷门曲），返回 `playCount: null`，按 0 / 未知处理。
脚本会遍历所有 `blocks` 找带 `totalPlay` 的那个，不是死取 `blocks[0]`。

---

## 4. 现成命令（NCM Playback DL 插件）

插件必须开着网易云（渲染进程里带 cookie 发请求），以下命令在 `F:\CloudMusic\ncm-playback-dl` 下执行：

```powershell
# 单首：累计播放次数
.\tools\ncmdl.ps1 wiki -Id 1864305690
# → 1864305690  累计播放 52 次，121 分钟   首听 2022-01-06T14:19:44.000Z

# 批量（逗号分隔）
.\tools\ncmdl.ps1 wiki-batch -Text "1864305690,1888688617" -DelayMs 500

# 全量扫描（断点续跑，结果写 tmp/playcounts.json）
.\tools\scan_wiki.ps1 -Chunk 25 -DelayMs 500 -IdsFile tmp/wiki-ids.txt -Out tmp/playcounts.json
```

| 文件 | 作用 |
| --- | --- |
| `plugin/main.js` | 插件本体，含 AES-128-ECB + MD5 + eapi 封装（`OPS.wiki` / `OPS.wiki_batch`） |
| `docs/eapi.py` | **Python 版 eapi 加密**（纯标准库，已逐字节验证） |
| `tools/eapi52.js` | Node 版：解密抓包 `params` 十六进制 |
| `tools/decode_resp.js` | Node 版：解抓包响应（br → AES → gzip） |
| `tools/scan_wiki.ps1` | 批量扫描 + 断点续跑 + 实时落盘 |
| `tools/ncmdl.ps1` | CLI（`wiki` / `wiki-batch` / `signals-all` / `fetch` / `queue` …） |

---

## 5. 数据文件格式

### `tmp/playcounts.json`（播放次数扫描结果）

```json
{
  "updatedAt": "2026-10-28T12:05:00.0000000+08:00",
  "counts": {
    "1864305690": { "playCount": 52, "durationMin": 121, "firstListenAt": 1641478784000, "text": "如同微风轻拂21780米" },
    "1888688617": { "playCount": 882, "durationMin": 2682, "firstListenAt": 1648721032117, "text": "超越了全站99%的用户" }
  }
}
```

### `tmp/signals_all.json`（歌单 + t_i + Top100）

```json
{
  "uid": "1776754239", "topAll": 100, "topWeek": 100, "songCount": 2741,
  "playlists": [{ "id": "2686243068", "name": "我喜欢的音乐", "trackCount": 1485, "tracks": 1485 }],
  "songs": [{
    "id": "3385634590", "name": "...", "artists": ["..."], "album": "...", "durationMs": 160680,
    "playCount": 0, "weekPlayCount": 3, "inTopAll": false, "inTopWeek": true,
    "playlists": { "2686243068": 1793113085763 }
  }]
}
```

**合并规则（给推荐器）**：

```python
m_i = playcounts.get(song_id, {}).get('playCount')
if m_i is None:                      # 百科没有区块 → 退回 Top100
    m_i = song['playCount'] if song['inTopAll'] else None   # None = 未知，别当 0
t_i = song['playlists'].get(playlist_id)                      # 毫秒时间戳
```

### 合并脚本：`tools/merge_signals.py`（已实现）

第 8 节原来的待办，现在可以直接跑：

```powershell
& $py tools\merge_signals.py --top 10      # → tmp/signals_final.json
```

产出 `tmp/signals_final.json`，字段就是上面规则的落地版本：

```json
{
  "generatedAt": "...", "uid": "1776754239", "songCount": 2741,
  "playlists": [{"id": "2686243068", "name": "我喜欢的音乐", "trackCount": 1485, "tracks": 1485}],
  "stats": {"total": 2741, "fromWiki": 199, "fromTop100": 90, "unknown": 2452,
            "wikiNull": 1, "atMissing": 23, "playCountsScanned": 200, "coverage": 0.105},
  "songs": [{
    "id": "...", "name": "...", "artists": ["..."], "album": "...", "durationMs": 160680,
    "playCount": 213, "playCountSource": "wiki", "weekPlayCount": 3, "inTopAll": false,
    "durationMin": 2682, "firstListenAt": 1790429013190,
    "at": {"2686243068": 1793113085763}
  }]
}
```

- `playCountSource`：`wiki`（百科，最准）/ `top100`（只有 Top100）/ `null`（未知）。
- 两个输入文件是 PowerShell 写的、**带 UTF-8 BOM**，脚本用 `utf-8-sig` 读。
- 扫描过程中可以反复重跑，每次都做全量合并；`stats.coverage` 就是当前覆盖率。
- 下游消费方：`recommender\netmusic.py`（见其 README 第 7 节）。

---

## 6. 限流与稳定性（重要）

- **每首 48KB**（百科页整页），2741 首 ≈ 130MB 流量；单次请求约 0.3–0.6s。
- **0.5s/首** 实测稳定（≈1 秒/首，全量 45–60 分钟）。
- **网易云窗口不要最小化**：渲染进程被挂起后插件的定时器/命令轮询会被节流，表现为「插件没有响应」。
  真卡了就 `ncmdl.ps1 js -Text 'location.reload()'` 重载页面，扫描脚本会断点续跑。
- 插件里的 fetch 带 15 秒超时（`OPS.wiki` 内置 AbortController），单首卡住不会拖死整队。
- 别更快了：这是账号级接口，1 秒/首已经算温和。

---

## 7. 已知坑（都踩过）

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| 400 参数错误 | 签名用的 path 写成 `/eapi/...` | 用 `/api/...` |
| 404 接口未找到 | 接口名不对，或 eapi 参数加密错 | 先用抓包解密对照 |
| 响应是乱码 | `e_r:true` → br+AES+gzip | 传 `e_r:false`，或用 `decode_resp.js` |
| `playedNum` 永远是 0 | 明文 `/api/song/detail` 不再填充该字段 | 走百科区块 |
| Top100 只有 100 条 | 服务端硬上限，`limit/offset/page/start` 全部无效 | 只当补充信号 |
| 插件无响应 | 页面被最小化节流 / 某次 fetch 挂住 | 重载页面 + 15s 超时（已内置） |
| 歌单 at 为 null | 部分歌单（导入/云盘）没有 at | 按「同一天加入」退化 |

---

## 8. 现状

- 已扫描并落盘：`tmp/playcounts.json`（断点续跑，重跑自动跳过已有）
- ✅ **合并脚本已实现**：`tools/merge_signals.py` → `tmp/signals_final.json`（字段见第 5 节）
- ✅ **下游已接上**：`recommender\netmusic.py` 用 `signals_final.json` 的真 `t_i`/真 `m_i` 跑推荐
- ⏳ 全量扫描（2741 首）未跑完，`merge_signals.py` 每次执行都会打印当前覆盖率；
  扫描随时可中断，不影响已扫结果

```powershell
$py = 'C:\Users\QiuNan\.conda\envs\genre\python.exe'
& $py tools\merge_signals.py --top 10
cd ..\recommender; & $py netmusic.py --top-plays 150
```

---

## 9. 最小可复现示例（复制就能跑）

```python
import requests, eapi   # eapi.py 与本文件同目录

s = requests.Session()
s.cookies.set('MUSIC_U', '<你的 MUSIC_U>')       # F12 → Application → Cookies
s.headers['User-Agent'] = 'NeteaseMusic/9.5.50'

for sid in ['1888688617', '1864305690', '428649319']:
    print(eapi.wiki_playcount(s, sid))
```

没有 cookie？用插件命令 `ncmdl.ps1 wiki -Id ...` 就行，插件自带登录态。

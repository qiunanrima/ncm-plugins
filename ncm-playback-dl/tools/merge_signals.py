"""把 tmp/playcounts.json 的播放次数合并进 tmp/signals_all.json → tmp/signals_final.json。

这是 [eapi-笔记.md](../docs/eapi-笔记.md) 第 8 节留的待办。字段映射严格按第 5 节：

    m_i = playcounts[songId].playCount          # 百科页（个人累计，最准）
    m_i = signals.songs[].playCount             # 退回 Top100（仅当 inTopAll=true）
    m_i = null                                  # 都没有 → 未知，绝不能当 0
    t_i = signals.songs[].playlists[playlistId]  # 毫秒时间戳，可能为 null

两个数据文件都是 PowerShell 写的，**带 UTF-8 BOM**，读的时候必须用 utf-8-sig。

用法::

    $py = 'C:\\Users\\QiuNan\\.conda\\envs\\genre\\python.exe'
    & $py merge_signals.py                       # 用默认路径
    & $py merge_signals.py --top 20              # 顺便打印播放次数最多的 20 首
    & $py merge_signals.py --out tmp/signals_final.json

扫描可以随时中断再续跑，本脚本也可以在扫描过程中反复执行（每次都做全量合并）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(os.path.dirname(HERE), "tmp")


def load_json(path: str) -> dict:
    """读 PowerShell 落盘的 JSON（容忍 UTF-8 BOM）。"""
    if not os.path.exists(path):
        raise FileNotFoundError(f"找不到 {path}")
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def write_json(path: str, payload: dict) -> None:
    """先写临时文件再替换，避免扫描进程同时写导致半截文件。"""
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def merge(signals: dict, counts: dict) -> dict:
    """按第 5 节的规则把两边合起来，返回最终结构。"""
    stats = {
        "total": 0,
        "fromWiki": 0,          # 百科页拿到确切次数
        "fromTop100": 0,        # 只有 Top100 的计数
        "unknown": 0,           # 两边都没有 → null
        "wikiNull": 0,          # 百科有记录但 playCount 是 null（冷门/重复版本）
        "atMissing": 0,         # 该歌在所有歌单里都没有 at
        "playCountsScanned": len(counts),
    }

    songs_out = []
    for s in signals.get("songs", []):
        sid = str(s.get("id"))
        wiki = counts.get(sid) or {}
        wiki_count = wiki.get("playCount")

        if wiki_count is not None:
            play_count = int(wiki_count)
            source = "wiki"
            stats["fromWiki"] += 1
        elif s.get("inTopAll") and s.get("playCount") is not None:
            # caveat：signals 里的 playCount 为 0 且 inTopAll=false 表示「未知」，不是真的 0
            play_count = int(s["playCount"])
            source = "top100"
            stats["fromTop100"] += 1
        else:
            play_count = None
            source = None
            stats["unknown"] += 1
            if sid in counts:
                stats["wikiNull"] += 1

        at = {str(k): v for k, v in (s.get("playlists") or {}).items()}
        if not any(v for v in at.values()):
            stats["atMissing"] += 1

        songs_out.append({
            "id": sid,
            "name": s.get("name"),
            "artists": s.get("artists") or [],
            "album": s.get("album") or "",
            "durationMs": s.get("durationMs"),
            "playCount": play_count,
            "playCountSource": source,
            "weekPlayCount": s.get("weekPlayCount"),
            "inTopAll": bool(s.get("inTopAll")),
            "durationMin": wiki.get("durationMin"),
            "firstListenAt": wiki.get("firstListenAt"),
            "at": at,
        })
        stats["total"] += 1

    coverage = stats["fromWiki"] + stats["fromTop100"]
    stats["coverage"] = round(coverage / max(stats["total"], 1), 4)

    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "uid": signals.get("uid"),
        "songCount": len(songs_out),
        "playlists": signals.get("playlists", []),
        "stats": stats,
        "rules": (
            "playCount: wiki > top100(inTopAll) > null(未知)；"
            "at[playlistId]: 毫秒时间戳，可能为 null，调用方需自行退化"
        ),
        "songs": songs_out,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="合并播放次数进 signals（eapi 笔记第 8 节的待办）")
    ap.add_argument("--signals", default=os.path.join(TMP, "signals_all.json"))
    ap.add_argument("--counts", default=os.path.join(TMP, "playcounts.json"))
    ap.add_argument("--out", default=os.path.join(TMP, "signals_final.json"))
    ap.add_argument("--top", type=int, default=0, help="打印播放次数最多的 N 首")
    args = ap.parse_args(argv)

    signals = load_json(args.signals)
    try:
        counts = load_json(args.counts).get("counts", {})
    except FileNotFoundError:
        print(f"[warn] {args.counts} 不存在，playCount 全部记为未知", file=sys.stderr)
        counts = {}

    final = merge(signals, counts)
    write_json(args.out, final)

    st = final["stats"]
    print(f"写入 {args.out}")
    print(f"  歌曲 {st['total']} 首 · 歌单 {len(final['playlists'])} 个 · 播放次数已扫 {st['playCountsScanned']} 首")
    print(f"  playCount 有值 {st['fromWiki'] + st['fromTop100']}（百科 {st['fromWiki']} + Top100 {st['fromTop100']}）"
          f"，未知 {st['unknown']}，覆盖率 {st['coverage']*100:.1f}%")
    print(f"  at 全缺失 {st['atMissing']} 首 · 百科有记录但次数为 null {st['wikiNull']} 首")

    if args.top:
        known = [s for s in final["songs"] if s["playCount"] is not None]
        known.sort(key=lambda s: -s["playCount"])
        print(f"\n播放次数 Top {args.top}：")
        for s in known[:args.top]:
            artist = "/".join(s["artists"])[:20]
            print(f"  {s['playCount']:>5}  {s['name'][:38]:<40}{artist:<22}"
                  f"{'百科' if s['playCountSource'] == 'wiki' else 'Top100'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

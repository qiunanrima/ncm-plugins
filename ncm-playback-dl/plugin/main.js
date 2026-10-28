/*
 * NCM Playback DL — BetterNCM 插件
 * --------------------------------
 * 目的：让「下载」走「播放」的接口。
 *
 *   播放接口：GET /api/song/enhance/player/url/v1?ids=[id]&level=exhigh&encodeType=mp3
 *            —— 网易云播放时用的同一套地址/权限/音质（实测 2.10.13 可直接带 cookie 调用）
 *   下载接口：/eapi/song/enhance/download/url/v1
 *            —— 走下载队列，音质/权限受 maxDownBr 与下载设置限制（实测下载到的常是 128k）
 *
 * 本插件：调播放接口拿 320k/无损地址 → 在渲染进程里 fetch 音频 → betterncm.fs.writeFile 落盘，
 * 并把「播放缓存里的那份 320k」变成可直接播放的 mp3/flac（不再受下载队列码率限制）。
 *
 * 外部通过 <BetterNCM>\PlaybackDL\inbox/*.json 发命令，结果写回 outbox。
 */
plugin.onLoad(async function (tools) {
  'use strict';

  const VERSION = '1.1.3';
  const ROOT = '/PlaybackDL';
  const SESSION = Math.random().toString(36).slice(2, 8);
  const NF = window.betterncm_native || null;
  const NFS = NF && NF.fs ? NF.fs : null;

  if (window.__ncmPlaybackDL && typeof window.__ncmPlaybackDL.dispose === 'function') {
    try { window.__ncmPlaybackDL.dispose(); } catch (e) { /* ignore */ }
  }

  const LEVELS = {
    standard: { br: 128000, enc: 'mp3', label: '标准' },
    higher: { br: 192000, enc: 'mp3', label: '较高' },
    exhigh: { br: 320000, enc: 'mp3', label: '极高' },
    lossless: { br: 999000, enc: 'flac', label: '无损' },
    hires: { br: 1999000, enc: 'flac', label: 'Hi-Res' },
  };

  const log = [];
  let fsRoot = null;
  let disposed = false;
  let scanning = false;
  const handled = new Map();
  const timers = [];

  /* ---------------- 基础工具 ---------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safe = (fn, fb) => { try { return fn(); } catch (e) { return fb === undefined ? null : fb; } };

  async function waitFor(test, ms, step) {
    const deadline = Date.now() + (ms || 2000);
    while (Date.now() < deadline) {
      let v;
      try { v = test(); } catch (e) { v = false; }
      if (v) return v;
      await sleep(step || 100);
    }
    return false;
  }

  function err(code, message, extra) {
    const e = new Error(message || code);
    e.code = code;
    if (extra) e.extra = extra;
    return e;
  }

  async function withTimeout(p, ms, label) {
    let t;
    try {
      return await Promise.race([
        p,
        new Promise((_, rej) => { t = setTimeout(() => rej(err('TIMEOUT', (label || '操作') + '超时（' + ms + 'ms）')), ms); }),
      ]);
    } finally { clearTimeout(t); }
  }

  function jsonSafe(v, depth) {
    depth = depth === undefined ? 4 : depth;
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + '…' : v;
    if (typeof v !== 'object') return v;
    if (depth <= 0) return '[Object]';
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => jsonSafe(x, depth - 1));
    const o = {};
    for (const k of Object.keys(v)) o[k] = jsonSafe(v[k], depth - 1);
    return o;
  }

  /** 合成点击（下载页的分页器等 nej 组件用得到） */
  function clickElement(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const mk = (type, buttons) => new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, button: 0,
      buttons: buttons, clientX: x, clientY: y,
    });
    el.dispatchEvent(mk('mousedown', 1));
    el.dispatchEvent(mk('mouseup', 0));
    el.dispatchEvent(mk('click', 0));
    return true;
  }

  /* ---------------- 文件队列（与 AgentBridge 同一套思路） ---------------- */

  const join = (d, n) => String(d).replace(/\/+$/, '') + '/' + n;
  const baseName = (p) => String(p).split(/[\\/]/).pop();

  const nfExists = (p) => safe(() => !!(NFS && NFS.exists(p)), false);
  const nfReadText = (p) => safe(() => NFS.readFileText(p), null);
  const nfWriteText = (p, t) => safe(() => !!NFS.writeFileText(p, t), false);
  const nfRemove = (p) => safe(() => { NFS.remove(p); return true; }, false);

  function nfReadDir(p) {
    return safe(() => {
      const l = NFS.readDir(p);
      if (!l) return [];
      return Array.from(l).map((x) => {
        const s = String(x);
        return /[\\/]/.test(s) ? s : join(p, s);
      });
    }, []);
  }

  async function mkdirp(dir) {
    if (nfExists(dir)) return true;
    await safe(() => betterncm.fs.mkdir(dir));
    if (!nfExists(dir)) safe(() => NFS.rename(dir));
    return nfExists(dir);
  }

  async function resolveRoot() {
    for (const c of [ROOT, '.' + ROOT, ROOT.slice(1)]) {
      const dir = join(c, 'inbox');
      if (!nfExists(dir)) continue;
      const probe = join(dir, '.probe');
      if (nfWriteText(probe, String(Date.now())) && nfExists(probe)) { nfRemove(probe); return c; }
    }
    return ROOT;
  }

  const writeJson = (p, o) => safe(() => nfWriteText(p, JSON.stringify(o)), false);

  /* ---------------- 网易云 API（页面内 fetch，自带登录 cookie） ---------------- */

  const API_HOST = 'https://interface.music.163.com';

  /** 客户端有时把两段 JSON 拼在一起返回（{...}{...}），这里做宽松解析 */
  function parseLoose(text) {
    const s = String(text || '').trim();
    try { return JSON.parse(s); } catch (e) { /* ignore */ }
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(0, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  async function api(path, timeoutMs) {
    const r = await withTimeout(
      fetch(API_HOST + path, { credentials: 'include' }),
      timeoutMs || 8000,
      '请求网易云接口'
    );
    const text = await r.text();
    const j = parseLoose(text);
    if (!j) throw err('BAD_JSON', '接口返回无法解析（HTTP ' + r.status + '）', { head: text.slice(0, 200) });
    return j;
  }

  function normLevel(v) {
    const s = String(v === undefined || v === null ? 'exhigh' : v).toLowerCase().trim();
    if (LEVELS[s]) return s;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n <= 128000) return 'standard';
      if (n <= 192000) return 'higher';
      if (n <= 320000) return 'exhigh';
      if (n <= 999000) return 'lossless';
      return 'hires';
    }
    return 'exhigh';
  }

  /** 播放接口：拿「播放」用的地址（这就是本插件的核心） */
  async function getPlayUrl(id, level) {
    const L = LEVELS[level];
    const ids = encodeURIComponent('[' + id + ']');
    const path = '/api/song/enhance/player/url/v1?ids=' + ids + '&level=' + level + '&encodeType=' + L.enc;
    const j = await api(path, 8000);
    const d = j.data && j.data[0];
    if (!d) throw err('API_BAD', '播放接口返回异常', { code: j.code, msg: j.msg });
    if (!d.url) {
      throw err('NO_URL', '播放接口没有返回地址（无版权 / 需要会员 / 地区限制）', {
        code: j.code, fee: d.fee, level: d.level, trial: d.freeTrialInfo,
      });
    }
    if (d.freeTrialInfo) {
      throw err('TRIAL_ONLY', '播放接口只给了试听片段，不能当完整歌曲保存', { trial: d.freeTrialInfo });
    }
    if (!d.size || d.size < 100000) {
      throw err('BAD_SIZE', '播放接口返回的文件大小异常（疑似占位/试听）', { size: d.size });
    }
    return {
      url: d.url, br: d.br, size: d.size, md5: d.md5,
      type: d.type || L.enc, level: d.level || level, fee: d.fee,
    };
  }

  const songCache = new Map();

  async function getSong(id) {
    if (songCache.has(String(id))) return songCache.get(String(id));
    const c = encodeURIComponent(JSON.stringify([{ id: Number(id) }]));
    const j = await api('/api/v3/song/detail?c=' + c, 8000);
    const s = j.songs && j.songs[0];
    if (!s) return null;
    const info = {
      id: String(s.id),
      name: s.name || '',
      artists: (s.ar || []).map((a) => a.name).filter(Boolean),
      album: (s.al && s.al.name) || '',
      durationMs: s.dt || 0,
      fee: s.fee,
    };
    songCache.set(String(id), info);
    return info;
  }

  /* ---------------- 落盘 ---------------- */

  function sanitize(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110);
  }

  function sniffFormat(buf) {
    const b = new Uint8Array(buf.slice(0, 4));
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';           // ID3
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';                  // MPEG sync
    if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'flac'; // fLaC
    if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg';  // OggS
    return 'bin';
  }

  function defaultDir() {
    return 'F:/CloudMusic';
  }

  /* ---------------- 业务 op ---------------- */

  const OPS = Object.create(null);

  OPS.ping = async () => ({
    plugin: 'ncm-playback-dl', version: VERSION, session: SESSION,
    fsRoot, defaultDir: defaultDir(), levels: Object.keys(LEVELS), ts: Date.now(),
  });

  OPS.song = async (a) => {
    const id = String(a.id || '');
    if (!id) throw err('BAD_ARGS', '缺少歌曲 id');
    const s = await getSong(id);
    if (!s) throw err('NOT_FOUND', '查不到这首歌', { id });
    return s;
  };

  /** 只取地址，不下载 */
  OPS.url = async (a) => {
    const id = String(a.id || '');
    if (!id) throw err('BAD_ARGS', '缺少歌曲 id');
    const level = normLevel(a.level);
    const u = await getPlayUrl(id, level);
    const s = safe(() => null);
    return {
      id, level: u.level, br: u.br, size: u.size, format: u.type, md5: u.md5, fee: u.fee,
      url: u.url, song: s, note: '播放接口地址短时效，别存起来慢慢用',
    };
  };

  /** 用播放接口下载：核心 */
  OPS.fetch = async (a) => {
    const id = String(a.id || '');
    if (!id) throw err('BAD_ARGS', '缺少歌曲 id');
    const level = normLevel(a.level);
    const dir = String(a.dir || defaultDir()).replace(/\/+$/, '');
    const started = Date.now();

    const song = await safe(() => getSong(id), null);
    const u = await getPlayUrl(id, level);

    let buf = null;
    let tries = 0;
    let lastErr = null;
    while (tries < 2) {
      tries++;
      try {
        const resp = await withTimeout(fetch(u.url, { credentials: 'include' }), Number(a.timeoutMs) || 120000, '下载音频');
        if (!resp.ok) throw err('HTTP', '音频下载失败 HTTP ' + resp.status);
        buf = await resp.arrayBuffer();
        // CDN 偶尔给截断内容，size 不符就重试
        if (Math.abs(buf.byteLength - u.size) > 1024) {
          throw err('SIZE_MISMATCH', '音频大小与接口不一致', { expect: u.size, got: buf.byteLength });
        }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        buf = null;
        if (tries >= 2) break;
        await sleep(600);
      }
    }
    if (!buf) throw (lastErr || err('DOWNLOAD_FAILED', '下载失败'));

    const sniffed = sniffFormat(buf);
    const format = sniffed === 'bin' ? (u.type === 'flac' ? 'flac' : 'mp3') : sniffed;
    const title = song && song.name ? song.name : ('song-' + id);
    const artist = song && song.artists.length ? song.artists[0] : '';
    const baseName = sanitize((artist ? artist + ' - ' : '') + title);
    let target = dir + '/' + baseName + '.' + format;

    // 已存在时的策略：skip（默认，队列批处理用）/ overwrite（-Force）/ rename
    const onExists = String(a.onExists || (a.force ? 'overwrite' : 'skip')).toLowerCase();
    const existed = await safe(() => betterncm.fs.exists(target), false);
    if (existed) {
      if (onExists === 'skip' && !a.force) {
        // 已存在就跳过，但要把现有文件大小读出来，别谎报“0 字节”
        const existingSize = await safe(async () => {
          const blob = await betterncm.fs.readFile(target);
          return blob ? blob.size : 0;
        }, 0);
        return {
          id, path: target + '', bytes: existingSize, br: u.br, level: u.level, format,
          md5: u.md5, verified: existingSize > 100000, skipped: 'exists', song: song || null,
          ms: Date.now() - started, source: 'player/url/v1（播放接口）',
        };
      }
      if (onExists === 'rename') {
        for (let i = 2; i < 50; i++) {
          const cand = dir + '/' + baseName + ' (' + i + ').' + format;
          if (!(await safe(() => betterncm.fs.exists(cand), false))) { target = cand; break; }
        }
      }
    }

    const ok = await safe(async () => betterncm.fs.writeFile(target, new Blob([buf], { type: format === 'flac' ? 'audio/flac' : 'audio/mpeg' })), false);
    if (!ok) throw err('WRITE_FAILED', '写文件失败：' + target, { dir });

    const exists = await safe(() => betterncm.fs.exists(target), false);
    const result = {
      id,
      path: target + '',
      bytes: buf.byteLength,
      expectBytes: u.size,
      br: u.br,
      level: u.level,
      format,
      md5: u.md5,
      verified: !!exists && buf.byteLength === u.size,
      replacedExisting: !!existed,
      song: song || null,
      ms: Date.now() - started,
      source: 'player/url/v1（播放接口）',
    };
    if (!result.verified) throw err('NOT_CONFIRMED', '文件写入后校验失败', result);
    return result;
  };

  OPS.fetch_current = async (a) => {
    const ncm = safe(() => betterncm.ncm);
    const p = ncm && ncm.getPlaying ? safe(() => ncm.getPlaying(), null) : null;
    if (!p || !p.id) throw err('NO_TRACK', '当前没有正在播放的歌曲');
    return OPS.fetch(Object.assign({}, a, { id: String(p.id) }));
  };

  /* ---------------- 客户端下载队列（「正在下载」列表，分页） ---------------- */

  const queueRows = () => Array.from(document.querySelectorAll('.itm[data-res-id]'));

  function selectedPage() {
    const el = document.querySelector('.m-page .zpgi.js-selected');
    return el ? parseInt((el.textContent || '').trim(), 10) : null;
  }

  function pagerInfo() {
    const nums = Array.from(document.querySelectorAll('.m-page .zpgi'))
      .map((e) => parseInt((e.textContent || '').trim(), 10))
      .filter((n) => !isNaN(n));
    return { pageCount: nums.length ? Math.max.apply(null, nums) : 1, current: selectedPage() };
  }

  /** 切到下载队列的第 n 页 */
  async function gotoQueuePage(n) {
    n = Math.max(1, Number(n) || 1);
    if (!/offline\/download/.test(location.hash)) {
      location.hash = '#/m/offline/download/';
      await waitFor(() => /offline\/download/.test(location.hash), 6000, 150);
    }
    await waitFor(() => queueRows().length > 0, 12000, 300);
    // 已经在该页就不用点（注意：不能假设“第一页就是当前页”，用户可能停在第 4 页）
    const curPage = selectedPage();
    if (curPage === n) return true;
    let guard = 0;
    while (guard++ < 15) {
      const cur = selectedPage();
      if (cur === n) return true;
      const firstBefore = queueRows()[0] ? queueRows()[0].getAttribute('data-res-id') : null;
      const direct = document.querySelector('.m-page .zpg' + n);
      if (direct) {
        clickElement(direct);
      } else {
        const nxt = document.querySelector('.m-page .znxt');
        if (!nxt || /js-disabled/.test(String(nxt.className || ''))) return false;
        clickElement(nxt);
      }
      await waitFor(() => {
        if (direct) {
          if (selectedPage() === n) return true;
          const f = queueRows()[0];
          return !!f && f.getAttribute('data-res-id') !== firstBefore;
        }
        const c2 = selectedPage();
        return c2 !== null && c2 !== cur;
      }, 3000, 120);
      await sleep(200);
    }
    return selectedPage() === n;
  }

  /** 「下载管理」页的 tab（已下载单曲 / 已下载声音 / 已下载MV / 正在下载） */
  function findTab(name) {
    return Array.from(document.querySelectorAll('a.j-flagtab')).find((e) =>
      (e.textContent || '').trim() === name && e.getBoundingClientRect().width > 10) || null;
  }

  /**
   * 确保停在「正在下载」tab。
   * 注意：只在确实不在该 tab 时点一下，绝不切到“已下载单曲”等空列表去重挂 ——
   * 那样会让用户看到列表被清空（实际只是渲染/切 tab）。
   */
  async function ensureDownloadTab(waitMs) {
    const tab = findTab('正在下载');
    if (tab && !/z-sel/.test(String(tab.className || ''))) {
      clickElement(tab);
      await waitFor(() => /z-sel/.test(String((findTab('正在下载') || {}).className || '')), 5000, 150);
    }
    return !!(await waitFor(() => queueRows().length > 0, waitMs || 6000, 300));
  }

  /** 读队列某页（默认当前页），支持页内 offset 分段 */
  async function readDownloadQueue(limit, waitMs, offset, page) {
    if (page) await gotoQueuePage(page);
    else if (!/offline\/download/.test(location.hash)) {
      location.hash = '#/m/offline/download/';
      await waitFor(() => /offline\/download/.test(location.hash), 6000, 150);
    }
    await waitFor(() => queueRows().length > 0, waitMs || 12000, 300);
    await ensureDownloadTab(waitMs);
    await sleep(300);
    const rows = queueRows();
    const tasks = rows.map((r) => {
      let id = String(r.getAttribute('data-res-id') || '');
      const m = String(r.className || '').match(/offline-(\d+)/);
      if (m && m[1]) id = m[1];
      id = id.replace(/^offline-/, '');
      const text = (r.textContent || '').replace(/\s+/g, ' ').trim();
      const status = /额度已满|下载额度/.test(text) ? 'quota_exceeded'
        : /已暂停/.test(text) ? 'paused'
        : /下载中|正在下载/.test(text) ? 'downloading'
          : /已下载|已完成/.test(text) ? 'done' : '';
      return {
        id,
        title: ((r.querySelector('.tit') || {}).textContent || '').trim() || text.slice(0, 40),
        status,
        text: text.slice(0, 80),
      };
    }).filter((t) => /^\d+$/.test(t.id));
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.max(1, Math.min(500, Number(limit) || 20));
    const pager = pagerInfo();
    return {
      hash: location.hash,
      page: pager.current,
      pageCount: pager.pageCount,
      pageRows: tasks.length,
      total: pager.pageCount * 200,
      offset: off,
      tasks: tasks.slice(off, off + lim),
    };
  }

  OPS.queue = async (a) => readDownloadQueue(a.limit, Number(a.waitMs) || 12000, a.offset, a.page);

  /** 一次性把整个队列（所有页）的 ID 抓下来：顺序点“下一页”，不随机跳页（更稳） */
  OPS.dump_queue = async (a) => {
    if (!/offline\/download/.test(location.hash)) {
      location.hash = '#/m/offline/download/';
      await waitFor(() => /offline\/download/.test(location.hash), 6000, 150);
    }
    await waitFor(() => queueRows().length > 0, 12000, 300);
    await ensureDownloadTab(8000);
    const pager = pagerInfo();
    const pages = Math.max(1, Math.min(60, Number(a.pages) || pager.pageCount || 1));
    const all = [];
    const seen = {};
    const collect = () => {
      queueRows().forEach((r) => {
        let id = String(r.getAttribute('data-res-id') || '');
        const m = String(r.className || '').match(/offline-(\d+)/);
        if (m && m[1]) id = m[1];
        id = id.replace(/^offline-/, '');
        if (!/^\d+$/.test(id) || seen[id]) return;
        seen[id] = 1;
        all.push({ id, title: ((r.querySelector('.tit') || {}).textContent || '').trim() });
      });
    };
    // 回到第 1 页
    const p1 = document.querySelector('.m-page .zpg1');
    if (p1 && selectedPage() !== 1) {
      const first0 = queueRows()[0] ? queueRows()[0].getAttribute('data-res-id') : null;
      clickElement(p1);
      await waitFor(() => {
        const f = queueRows()[0];
        return (selectedPage() === 1) || (!!f && f.getAttribute('data-res-id') !== first0);
      }, 5000, 150);
    }
    await sleep(300);
    collect();
    const pageStats = [{ page: selectedPage(), rows: queueRows().length }];
    for (let p = 2; p <= pages; p++) {
      const before = queueRows()[0] ? queueRows()[0].getAttribute('data-res-id') : null;
      const nxt = document.querySelector('.m-page .znxt');
      if (!nxt) break;
      clickElement(nxt);
      const moved = await waitFor(() => {
        const f = queueRows()[0];
        return !!f && f.getAttribute('data-res-id') !== before;
      }, 6000, 150);
      if (!moved) break;
      await sleep(250);
      collect();
      pageStats.push({ page: selectedPage(), rows: queueRows().length });
    }
    return {
      pages, pageStats, count: all.length, ids: all,
      note: 'ids 为队列全部歌曲（已去重），可用于后续纯 API 下载，不再翻页',
    };
  };

  /** 把下载队列里的任务改成「走播放接口」重新取一遍 */
  OPS.fetch_queue = async (a) => {
    const level = normLevel(a.level);
    const dir = String(a.dir || defaultDir()).replace(/\/+$/, '');
    const limit = Math.max(1, Math.min(50, Number(a.limit) || 5));
    // 低并发：逐首之间留间隔，避免触发风控（默认 1.2s）
    const delayMs = Math.max(0, Math.min(15000, a.delayMs === undefined ? 1200 : Number(a.delayMs)));
    const q = await readDownloadQueue(limit, Number(a.waitMs) || 12000, a.offset, a.page);
    const items = [];
    for (const t of q.tasks) {
      const row = { id: t.id, title: t.title, status: t.status };
      try {
        const r = await OPS.fetch({
          id: t.id, level, dir,
          onExists: a.force ? 'overwrite' : (a.onExists || 'skip'),
          timeoutMs: a.timeoutMs,
        });
        row.ok = true;
        row.path = r.path;
        row.bytes = r.bytes;
        row.br = r.br;
        row.level = r.level;
        row.skipped = r.skipped || null;
        row.replacedExisting = !!r.replacedExisting;
      } catch (e) {
        row.ok = false;
        row.error = (e && e.code) || 'ERROR';
        row.message = String((e && e.message) || e);
      }
      items.push(row);
      writeStatus();
      if (delayMs) await sleep(delayMs);
    }
    return {
      queueTotal: q.total,
      page: q.page,
      pageCount: q.pageCount,
      offset: q.offset || 0,
      attempted: items.length,
      ok: items.filter((x) => x.ok && !x.skipped).length,
      skipped: items.filter((x) => x.skipped).length,
      failed: items.filter((x) => !x.ok).length,
      level, dir,
      items,
      note: '任务仍在客户端下载队列里（本插件不写入/不删除客户端队列）；文件已按播放接口落盘，可用 -Force 覆盖旧的低码率文件',
    };
  };

  /** 核对队列里每一首是否真的在库里；缺的补下（按播放接口、指定音质） */
  OPS.verify_queue = async (a) => {
    const level = normLevel(a.level);
    const dir = String(a.dir || defaultDir()).replace(/\/+$/, '');
    const limit = Math.max(1, Math.min(60, Number(a.limit) || 30));
    const q = await readDownloadQueue(limit, Number(a.waitMs) || 12000, a.offset, a.page);
    const items = [];
    let present = 0, downloaded = 0, failed = 0;
    for (const t of q.tasks) {
      const row = { id: t.id, title: t.title };
      try {
        const song = await getSong(t.id);
        const artist = song && song.artists.length ? song.artists[0] : '';
        const name = song && song.name ? song.name : t.title;
        const base = sanitize((artist ? artist + ' - ' : '') + name);
        let found = null;
        for (const ext of ['mp3', 'flac']) {
          const p = dir + '/' + base + '.' + ext;
          if (await safe(() => betterncm.fs.exists(p), false)) {
            let size = 0;
            const props = safe(() => (NFS && NFS.getProperties ? NFS.getProperties(p) : null), null);
            if (props && typeof props.size === 'number') size = props.size;
            if (!size) {
              size = await safe(async () => { const b = await betterncm.fs.readFile(p); return b ? b.size : 0; }, 0);
            }
            found = { path: p, bytes: size, format: ext };
            break;
          }
        }
        if (found) {
          present++;
          row.ok = true; row.present = true; row.path = found.path; row.bytes = found.bytes; row.format = found.format;
        } else {
          const r = await OPS.fetch({ id: t.id, level, dir, onExists: 'skip', timeoutMs: a.timeoutMs });
          downloaded++;
          row.ok = true; row.downloaded = true; row.path = r.path; row.bytes = r.bytes; row.format = r.format;
        }
      } catch (e) {
        failed++;
        row.ok = false; row.error = (e && e.code) || 'ERROR'; row.message = String((e && e.message) || e);
      }
      items.push(row);
      writeStatus();
    }
    return {
      queueTotal: q.total, page: q.page, pageCount: q.pageCount, offset: q.offset || 0, checked: items.length,
      present, downloaded, failed, level, dir, items,
      note: 'present=库里已有；downloaded=本次补下；failed=取不到（无版权/会员限制/网络）',
    };
  };

  /* ---------------- 推荐用的两个信号：播放次数 m_i / 加入歌单时间 t_i ---------------- */

  let cachedUid = null;

  async function currentUid() {
    if (cachedUid) return cachedUid;
    const j = await api('/api/nuser/account/get', 10000);
    const uid = j && j.profile && j.profile.userId;
    if (!uid) throw err('NO_LOGIN', '拿不到登录账号（客户端未登录？）', { code: j && j.code });
    cachedUid = String(uid);
    return cachedUid;
  }

  OPS.me = async () => {
    const j = await api('/api/nuser/account/get', 10000);
    const p = (j && j.profile) || {};
    return {
      code: j && j.code,
      uid: p.userId ? String(p.userId) : null,
      nickname: p.nickname || '',
      vipType: p.vipType || 0,
      avatar: p.avatarUrl || '',
    };
  };

  /** 听歌排行：type=0 全时段 / type=1 本周；都只有 Top100，无分页 */
  OPS.records = async (a) => {
    const uid = String(a.uid || (await currentUid()));
    const type = Number(a.type) === 1 ? 1 : 0;
    const j = await api('/api/v1/play/record?uid=' + encodeURIComponent(uid) + '&type=' + type, 15000);
    const list = (type === 1 ? j.weekData : j.allData) || [];
    const items = list.map((x) => ({
      id: String(x.song.id),
      name: x.song.name || '',
      artists: (x.song.ar || []).map((r) => r.name).filter(Boolean),
      playCount: x.playCount,
      score: x.score,
    }));
    return {
      uid, type, count: items.length, capped: 100, items,
      note: '听歌排行只给 Top100（type=0 全时段 / type=1 本周），limit/offset 无效；榜单外的歌没有次数',
    };
  };

  /** 歌单（API 版）：trackIds 带 at = 加入时间（毫秒） */
  async function fetchPlaylistApi(id) {
    const j = await api('/api/v6/playlist/detail?id=' + encodeURIComponent(id) + '&n=1000&s=0', 15000);
    const p = j && j.playlist;
    if (!p) throw err('NO_PLAYLIST', '歌单不存在/无权限', { id, code: j && j.code });
    const tids = p.trackIds || [];
    return {
      id: String(p.id),
      name: p.name || '',
      trackCount: p.trackCount || tids.length,
      creator: (p.creator && p.creator.nickname) || '',
      tracks: tids.map((t) => ({ id: String(t.id), addTime: t.at || null })),
    };
  }

  /** 批量歌曲详情（每批 100，避免 URL 过长） */
  async function songMetaMap(ids) {
    const map = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const c = encodeURIComponent(JSON.stringify(ids.slice(i, i + 100).map((id) => ({ id: Number(id) }))));
      const j = await api('/api/v3/song/detail?c=' + c, 20000);
      for (const s of (j.songs || [])) {
        map.set(String(s.id), {
          name: s.name || '',
          artists: (s.ar || []).map((r) => r.name).filter(Boolean),
          album: (s.al && s.al.name) || '',
          durationMs: s.dt || 0,
        });
      }
      if (i + 100 < ids.length) await sleep(200);
    }
    return map;
  }

  OPS.playlist_api = async (a) => {
    const id = String(a.id || '');
    if (!id) throw err('BAD_ARGS', '缺少歌单 id');
    const pl = await fetchPlaylistApi(id);
    let tracks = pl.tracks;
    if (a.detail !== false) {
      const meta = await songMetaMap(tracks.map((t) => t.id));
      tracks = tracks.map((t) => Object.assign({ addTimeISO: t.addTime ? new Date(t.addTime).toISOString() : null }, meta.get(t.id) || {}, t));
    }
    const off = Math.max(0, Number(a.offset) || 0);
    const lim = Math.max(1, Math.min(3000, Number(a.limit) || 3000));
    return {
      id: pl.id, name: pl.name, trackCount: pl.trackCount, creator: pl.creator,
      offset: off, returned: Math.max(0, Math.min(lim, tracks.length - off)),
      tracks: tracks.slice(off, off + lim),
      note: 'addTime = trackIds[].at（毫秒，加入歌单时间；部分歌单可能为 null）',
    };
  };

  /** 一次性给推荐模块的信号：t_i（加入时间）+ m_i（播放次数） */
  OPS.signals = async (a) => {
    const id = String(a.playlistId || a.id || '');
    if (!id) throw err('BAD_ARGS', '缺少歌单 id');
    const pl = await OPS.playlist_api({ id, limit: 3000 });
    const uid = await currentUid();
    const all = await OPS.records({ uid, type: 0 });
    const week = await OPS.records({ uid, type: 1 });
    const allMap = new Map(all.items.map((x) => [x.id, x.playCount]));
    const weekMap = new Map(week.items.map((x) => [x.id, x.playCount]));
    const tracks = pl.tracks.map((t) => Object.assign({}, t, {
      playCount: allMap.get(t.id) || 0,
      weekPlayCount: weekMap.get(t.id) || 0,
      inTopAll: allMap.has(t.id),
      inTopWeek: weekMap.has(t.id),
    }));
    return {
      playlist: { id: pl.id, name: pl.name, trackCount: pl.trackCount, creator: pl.creator },
      uid, topAll: all.items.length, topWeek: week.items.length,
      matchedInPlaylist: tracks.filter((t) => t.inTopAll).length,
      tracks,
      caveats: [
        'm_i(播放次数) 只覆盖全站 Top100（全时段）与 Top100（本周），其余歌为 0/未知（用 inTopAll/inTopWeek 区分“真的是0”和“没进榜”）',
        't_i(加入时间) 来自 trackIds[].at，毫秒；个别歌单可能为 null',
        '接口走渲染进程 cookie（interface.music.163.com），不依赖 music.163.com/api 直连',
      ],
    };
  };

  /**
   * 全量导出 m_i / t_i：遍历账号全部歌单，合并成一份 JSON 写到磁盘。
   * 只返回摘要，避免把几 MB 的数据塞进 RPC 结果。
   */
  OPS.signals_all = async (a) => {
    const uid = await currentUid();
    const j = await api('/api/user/playlist?uid=' + uid + '&limit=1000&offset=0', 20000);
    let pls = (j.playlist || [])
      .map((p) => ({ id: String(p.id), name: p.name || '', trackCount: p.trackCount || 0 }))
      .filter((p) => p.trackCount > 0);
    const maxPl = Math.max(1, Math.min(200, Number(a.limit) || 200));
    pls = pls.slice(0, maxPl);
    const all = await OPS.records({ uid, type: 0 });
    const week = await OPS.records({ uid, type: 1 });
    const allMap = new Map(all.items.map((x) => [x.id, x.playCount]));
    const weekMap = new Map(week.items.map((x) => [x.id, x.playCount]));
    const songs = new Map();
    const plOut = [];
    for (const p of pls) {
      let pl = null;
      try {
        pl = await fetchPlaylistApi(p.id);
      } catch (e) {
        plOut.push({ id: p.id, name: p.name, error: (e && e.code) || 'ERROR' });
        continue;
      }
      let meta = new Map();
      try { meta = await songMetaMap(pl.tracks.map((t) => t.id)); } catch (e) { /* 元数据失败也能给信号 */ }
      for (const t of pl.tracks) {
        let s = songs.get(t.id);
        if (!s) {
          const m = meta.get(t.id) || {};
          s = {
            id: t.id,
            name: m.name || '',
            artists: m.artists || [],
            album: m.album || '',
            durationMs: m.durationMs || 0,
            playCount: allMap.get(t.id) || 0,
            weekPlayCount: weekMap.get(t.id) || 0,
            inTopAll: allMap.has(t.id),
            inTopWeek: weekMap.has(t.id),
            playlists: {},
          };
          songs.set(t.id, s);
        }
        s.playlists[p.id] = t.addTime || null;
      }
      plOut.push({ id: p.id, name: p.name, trackCount: pl.trackCount, tracks: pl.tracks.length });
      writeStatus();
    }
    const payload = {
      uid,
      generatedAt: new Date().toISOString(),
      topAll: all.items.length,
      topWeek: week.items.length,
      playlists: plOut,
      songCount: songs.size,
      songs: Array.from(songs.values()),
      caveats: [
        'm_i(playCount) 只覆盖全站 Top100（全时段）与 Top100（本周），其余为 0 且 inTopAll=false（=未知，不是真的 0）',
        't_i 是 songs[].playlists[playlistId]（毫秒时间戳，加入该歌单的时间；可能为 null）',
        '同一首歌可能出现在多个歌单，playlists 里每个歌单一个加入时间',
      ],
    };
    const text = JSON.stringify(payload);
    const out = String(a.out || '').replace(/\\/g, '/') || (defaultDir() + '/playlist_signals.json');
    let saved = false;
    try {
      saved = await betterncm.fs.writeFile(out, new Blob([text], { type: 'application/json' }));
    } catch (e) { saved = false; }
    if (!saved && a.out) throw err('WRITE_FAILED', '写文件失败：' + out);
    if (!saved) {
      // 没指定路径就回退到 BetterNCM 数据目录
      const fallback = '/PlaybackDL-signals.json';
      saved = safe(() => nfWriteText(fallback, text), false);
      return {
        ok: saved, out: fallback, songCount: songs.size, playlists: plOut.length,
        topAll: all.items.length, topWeek: week.items.length, bytes: text.length,
        note: '默认目录写入失败，已存到 BetterNCM 数据目录（可用 -Out 指定绝对路径）',
      };
    }
    return {
      out, songCount: songs.size, playlists: plOut.length,
      topAll: all.items.length, topWeek: week.items.length, bytes: text.length,
      playlistSummary: plOut.slice(0, 10),
      caveats: payload.caveats,
    };
  };

  /* ---------------- eapi（AES-128-ECB）与「歌曲百科·累计播放」 ---------------- */

  const AES_SBOX = [    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
  ];
  const AES_RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

  function aesExpandKey(key) {
    const w = new Array(176).fill(0);
    for (let i = 0; i < 16; i++) w[i] = key[i];
    let rcon = 0;
    for (let i = 16; i < 176; i += 4) {
      let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
      if (i % 16 === 0) {
        const tmp = t0;
        t0 = AES_SBOX[t1] ^ AES_RCON[rcon++];
        t1 = AES_SBOX[t2];
        t2 = AES_SBOX[t3];
        t3 = AES_SBOX[tmp];
      }
      w[i] = w[i - 16] ^ t0;
      w[i + 1] = w[i - 15] ^ t1;
      w[i + 2] = w[i - 14] ^ t2;
      w[i + 3] = w[i - 13] ^ t3;
    }
    return w;
  }

  function aesEncryptBlock(w, block) {
    const s = block.slice();
    const add = (r) => { for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i]; };
    const sub = () => { for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]]; };
    // state 列主序：s[r + 4c]
    const shift = () => {
      let t;
      t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
      t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
      t = s[3]; s[3] = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = t;
    };
    const xt = (x) => ((x << 1) ^ ((x & 0x80) ? 0x1b : 0)) & 0xff;
    const mix = () => {
      for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
        const t = a0 ^ a1 ^ a2 ^ a3;
        s[i] ^= t ^ xt(a0 ^ a1);
        s[i + 1] ^= t ^ xt(a1 ^ a2);
        s[i + 2] ^= t ^ xt(a2 ^ a3);
        s[i + 3] ^= t ^ xt(a3 ^ a0);
      }
    };
    add(0);
    for (let r = 1; r < 10; r++) { sub(); shift(); mix(); add(r); }
    sub(); shift(); add(10);
    return s;
  }

  function aesEcbEncryptHex(text) {
    const key = [];
    const kstr = 'e82ckenh8dichen8';
    for (let i = 0; i < 16; i++) key.push(kstr.charCodeAt(i));
    const w = aesExpandKey(key);
    let bytes = [];
    const enc = new TextEncoder();
    bytes = Array.from(enc.encode(text));
    const pad = 16 - (bytes.length % 16);
    for (let i = 0; i < pad; i++) bytes.push(pad);
    let out = '';
    for (let off = 0; off < bytes.length; off += 16) {
      const block = bytes.slice(off, off + 16);
      const c = aesEncryptBlock(w, block);
      for (let i = 0; i < 16; i++) out += (c[i] < 16 ? '0' : '') + c[i].toString(16);
    }
    return out.toUpperCase();
  }

  function md5Hex(str) {
    const bytes = Array.from(new TextEncoder().encode(str));
    const origLen = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const bitLen = origLen * 8;
    const lo = bitLen % 4294967296;
    const hi = Math.floor(bitLen / 4294967296);
    for (let i = 0; i < 4; i++) bytes.push((lo >>> (8 * i)) & 0xff);
    for (let i = 0; i < 4; i++) bytes.push((hi >>> (8 * i)) & 0xff);
    const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
      5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
      4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
      6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = [];
    for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
    for (let off = 0; off < bytes.length; off += 64) {
      const M = [];
      for (let i = 0; i < 16; i++) {
        const p = off + i * 4;
        M.push((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0);
      }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const hex = (n) => {
      let s = '';
      for (let i = 0; i < 4; i++) s += ((n >>> (8 * i)) & 0xff).toString(16).padStart(2, '0');
      return s;
    };
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }
  function eapiParams(path, json) {
    const sign = md5Hex('nobody' + path + 'use' + json + 'md5forencrypt');
    return aesEcbEncryptHex(path + '-36cd479b6b5-' + json + '-36cd479b6b5-' + sign);
  }

  /** 歌曲百科「累计播放」：playCount = 你听过多少次 */
  OPS.wiki = async (a) => {
    const id = String(a.id || '');
    if (!id) throw err('BAD_ARGS', '缺少歌曲 id');
    const ext = JSON.stringify({ states: { playingResource: { current: id, scene: 'songWiki' } } });
    const body = JSON.stringify({ e_r: false, extJson: ext, positionCode: 'songWikiMainPosition', header: '{}' });
    const params = eapiParams('/api/link/page/parent/relation/construct/info', body);
    const url = 'https://interface3.music.163.com/eapi/link/page/parent/relation/construct/info'
      + '?extJson=' + encodeURIComponent(ext) + '&positionCode=songWikiMainPosition';
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, Number(a.timeoutMs) || 15000) : null;
    let r;
    let text;
    try {
      r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'params=' + params,
        signal: ctrl ? ctrl.signal : undefined,
      });
      text = await r.text();
    } catch (e) {
      throw err('NETWORK', '请求失败：' + String((e && e.message) || e), { id });
    } finally {
      if (timer) clearTimeout(timer);
    }
    let j = null;
    try { j = JSON.parse(text); } catch (e) { throw err('BAD_RESPONSE', '响应不是 JSON：' + text.slice(0, 120), { status: r.status }); }
    const blocks = (j.data && j.data.blocks) || [];
    let b0 = null;
    for (const b of blocks) {
      if (b && b.rnData && (b.rnData.totalPlay || b.rnData.firstListen)) { b0 = b; break; }
    }
    if (!b0) b0 = blocks[0] || {};
    const rn = b0.rnData || {};
    const tp = rn.totalPlay || {};
    const fl = rn.firstListen || {};
    return {
      id,
      code: j.code,
      playCount: typeof tp.playCount === 'number' ? tp.playCount : null,
      durationMin: typeof tp.duration === 'number' ? tp.duration : null,
      firstListenAt: fl.timestamp || null,
      firstListenISO: fl.timestamp ? new Date(fl.timestamp).toISOString() : null,
      blockCode: b0.blockCode || null,
      text: tp.text || '',
    };
  };

  OPS.wiki_batch = async (a) => {
    const ids = (a.ids || []).map(String);
    const delay = Math.max(0, Number(a.delayMs) || 600);
    const items = [];
    for (const id of ids) {
      try {
        const r = await OPS.wiki({ id });
        items.push(r);
      } catch (e) {
        items.push({ id, error: (e && e.code) || 'ERROR', message: String((e && e.message) || e).slice(0, 120) });
      }
      writeStatus();
      if (delay) await sleep(delay);
    }
    return { count: items.length, ok: items.filter((x) => !x.error).length, items };
  };

  OPS.js = async (a) => {
    const code = String(a.code || '');
    if (!code) throw err('BAD_ARGS', '缺少 code');
    // eslint-disable-next-line no-eval
    let v = eval(code);
    if (v && typeof v.then === 'function') v = await withTimeout(v, Number(a.timeoutMs) || 8000, 'js');
    return { value: jsonSafe(v) };
  };

  OPS.log = async () => ({ entries: log.slice(0, 40) });

  /* ---------------- 队列 ---------------- */

  function pushLog(e) { log.unshift(e); if (log.length > 40) log.pop(); }

  async function handleCommand(cmd, cmdPath) {
    const started = Date.now();
    const op = cmd && cmd.op ? String(cmd.op) : '';
    const args = (cmd && cmd.args) || {};
    const id = String((cmd && cmd.id) || baseName(cmdPath).replace(/\.json$/, ''));
    let payload;
    try {
      const fn = OPS[op];
      if (!fn) throw err('UNKNOWN_OP', '未知操作：' + op + '（可用：' + Object.keys(OPS).join(', ') + '）');
      const data = await withTimeout(Promise.resolve(fn(args)), Number(cmd.timeoutMs) || 180000, op);
      payload = { id, ok: true, op, data, ms: Date.now() - started, ts: Date.now() };
      pushLog({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), op, ok: true, ms: payload.ms });
    } catch (e) {
      payload = {
        id, ok: false, op,
        error: { code: (e && e.code) || 'ERROR', message: String((e && e.message) || e), extra: jsonSafe(e && e.extra) },
        ms: Date.now() - started, ts: Date.now(),
      };
      pushLog({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), op, ok: false, ms: payload.ms, note: payload.error.code });
    }
    if (!disposed && fsRoot) writeJson(join(fsRoot, 'outbox') + '/' + id + '.res.json', payload);
    writeStatus();
    return payload;
  }

  async function scanInbox() {
    if (disposed || scanning || !fsRoot) return;
    scanning = true;
    try {
      const dir = join(fsRoot, 'inbox');
      for (const file of nfReadDir(dir).filter((p) => /\.json$/i.test(p))) {
        const name = baseName(file);
        if (handled.has(name)) continue;
        handled.set(name, Date.now());
        let cmd = null;
        try {
          const raw = nfReadText(file);
          cmd = raw ? JSON.parse(raw) : null;
        } catch (e) {
          const badId = name.replace(/\.json$/i, '');
          writeJson(join(fsRoot, 'outbox') + '/' + badId + '.res.json', {
            id: badId, ok: false, error: { code: 'BAD_JSON', message: '命令不是合法 JSON' }, ts: Date.now(),
          });
        }
        try {
          if (cmd) await handleCommand(cmd, file);
        } finally {
          nfRemove(file);
        }
      }
      const cutoff = Date.now() - 30000;
      for (const [k, ts] of handled) if (ts < cutoff) handled.delete(k);
    } finally {
      scanning = false;
    }
  }

  /* ---------------- 心跳 / 设置页 ---------------- */

  let lastStatus = '';

  function writeStatus(force) {
    if (!fsRoot) return;
    const s = {
      plugin: 'ncm-playback-dl', version: VERSION, session: SESSION,
      defaultDir: defaultDir(), fsRoot, levels: Object.keys(LEVELS),
      log: log.slice(0, 8), ts: Date.now(),
    };
    const text = JSON.stringify(s);
    if (!force && text === lastStatus) return;
    lastStatus = text;
    writeJson(join(fsRoot, 'status.json'), s);
  }

  function buildConfigPanel() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:22px 26px;font-size:13px;line-height:1.7;max-width:720px';
    wrap.innerHTML =
      '<h2 style="font-size:20px;margin:0 0 4px">NCM Playback DL</h2>' +
      '<div style="opacity:.65;margin-bottom:14px">让下载走播放接口 · v' + VERSION + '</div>' +
      '<div style="padding:12px 14px;border:1px solid rgba(128,128,128,.35);border-radius:10px;margin-bottom:12px">' +
      '<div>播放接口：<code>/api/song/enhance/player/url/v1</code>（level=standard/higher/exhigh/lossless/hires）</div>' +
      '<div>默认保存目录：<code>' + defaultDir() + '</code></div>' +
      '</div>' +
      '<div style="font-family:Consolas,monospace;font-size:12px;max-height:180px;overflow:auto;padding:8px 10px;border:1px solid rgba(128,128,128,.25);border-radius:10px">' +
      (log.length ? log.slice(0, 15).map((x) => x.t + '  ' + x.op + '  ' + (x.ok ? '✓' : '✗ ' + (x.note || '')) + '  ' + x.ms + 'ms').join('<br>') : '还没有收到过命令') +
      '</div>' +
      '<div style="margin-top:12px;opacity:.6;font-size:12px">命令行：<code>tools\\ncmdl.ps1 fetch -Id &lt;歌曲ID&gt; -Level exhigh</code></div>';
    return wrap;
  }

  /* ---------------- 启动 ---------------- */

  async function start() {
    await mkdirp(join(ROOT, 'inbox'));
    await mkdirp(join(ROOT, 'outbox'));
    fsRoot = await resolveRoot();

    writeJson(join(fsRoot, 'hello.json'), {
      plugin: 'ncm-playback-dl', version: VERSION, session: SESSION,
      defaultDir: defaultDir(), fsRoot, startedAt: new Date().toISOString(),
    });

    await scanInbox();
    safe(() => NFS.watchDirectory(join(fsRoot, 'inbox'), function () { scanInbox(); }));
    const t1 = setInterval(scanInbox, 250);
    const t2 = setInterval(() => writeStatus(false), 3000);
    timers.push(t1, t2);

    writeStatus(true);
    pushLog({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), op: 'plugin.loaded', ok: true, ms: 0 });
  }

  plugin.onConfig(function () { return buildConfigPanel(); });

  window.__ncmPlaybackDL = {
    version: VERSION,
    ops: OPS,
    fetch: (id, level, dir) => OPS.fetch({ id, level, dir }),
    dispose() {
      disposed = true;
      timers.forEach((t) => clearInterval(t));
    },
  };

  try {
    await start();
  } catch (e) {
    try {
      writeJson('/PlaybackDL/plugin-error.json', { message: String((e && e.stack) || e), ts: Date.now() });
    } catch (e2) { /* ignore */ }
    console.error('[NCM Playback DL] 启动失败', e);
  }
});

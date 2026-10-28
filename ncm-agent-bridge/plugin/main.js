/*
 * NCM Agent Bridge — BetterNCM 插件
 * ---------------------------------
 * 让外部 Agent（脚本 / AI）能够操作网易云音乐。
 *
 * 设计要点：
 *   1. 插件里没有服务器端口可开，所以走「本地文件队列」：
 *        <BetterNCM 数据目录>/AgentBridge/inbox/<id>.json      ← 外部写入命令
 *        <BetterNCM 数据目录>/AgentBridge/outbox/<id>.res.json ← 插件写回结果
 *        <BetterNCM 数据目录>/AgentBridge/status.json          ← 实时状态心跳
 *   2. 用 BetterNCM Native API 的同步 fs + watchDirectory，延迟 < 100ms。
 *   3. 播放控制走网易云自己的播放条 DOM（与用户点击完全一致），并在执行后回读状态校验。
 *   4. 额外提供 js / channel / query / click / type 等原始工具，方便继续探测网易云。
 *
 * 适配版本：网易云音乐 2.10.x + BetterNCM 1.3.x（已在 2.10.13.202675 / 1.3.4 上验证）
 */
plugin.onLoad(async function (tools) {
  'use strict';

  const VERSION = '1.3.0';
  const ROOT = '/AgentBridge';
  const SESSION = Math.random().toString(36).slice(2, 8);
  const MAX_LOG = 40;

  /* ========================= 基础环境 ========================= */

  const NF = window.betterncm_native || null;
  const NFS = NF && NF.fs ? NF.fs : null;

  // 防止 dev 版本与正式版本同时被加载时重复运行
  if (window.__ncmAgentBridge && typeof window.__ncmAgentBridge.dispose === 'function') {
    try { window.__ncmAgentBridge.dispose(); } catch (e) { /* ignore */ }
  }

  const state = {
    trackId: null,
    title: '',
    artists: [],
    album: '',
    cover: '',
    durationMs: 0,
    playing: false,
    domPlaying: null,
    apiState: null,
    nativeState: null,
    nativeStateAt: 0,
    progressMs: 0,
    progressAt: 0,
    progressSource: null,
    volume: null,
    mode: null,
    modeTitle: '',
    quality: '',
    lastRefresh: 0,
  };

  const log = [];
  let fsRoot = null;
  let disposed = false;
  let scanning = false;
  const handled = new Map();
  let healthy = false;
  const timers = [];
  const later = (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; };

  /* ========================= 小工具 ========================= */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function err(code, message, extra) {
    const e = new Error(message || code);
    e.code = code;
    if (extra) e.extra = extra;
    return e;
  }

  async function withTimeout(promise, ms, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, rej) => { timer = setTimeout(() => rej(err('TIMEOUT', (label || '操作') + '超时（' + ms + 'ms）')), ms); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

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

  function jsonSafe(v, depth, seen) {
    depth = depth === undefined ? 4 : depth;
    seen = seen || new WeakSet();
    if (v === undefined || v === null) return null;
    const t = typeof v;
    if (t === 'string') return v.length > 4000 ? v.slice(0, 4000) + '…(' + v.length + ')' : v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (t === 'symbol' || t === 'bigint') return String(v);
    if (t !== 'object') return String(v);
    if (typeof Element !== 'undefined' && v instanceof Element) {
      const cls = typeof v.className === 'string' && v.className.trim() ? '.' + v.className.trim().split(/\s+/).join('.') : '';
      return '[<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + cls + '>]';
    }
    if (typeof Node !== 'undefined' && v instanceof Node) return '[Node]';
    if (depth <= 0) return '[Object depth-limit]';
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 60).map((x) => jsonSafe(x, depth - 1, seen));
    const out = {};
    let i = 0;
    for (const k of Object.keys(v)) {
      if (i++ > 80) { out['…'] = 'truncated'; break; }
      try { out[k] = jsonSafe(v[k], depth - 1, seen); } catch (e) { out[k] = '[threw]'; }
    }
    return out;
  }

  const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback === undefined ? null : fallback; } };
  async function safeAsync(fn) { try { return await fn(); } catch (e) { return null; } }

  function channelApi() { return safe(() => (typeof channel !== 'undefined' ? channel : null)); }
  function nativeCmder() { return safe(() => (typeof legacyNativeCmder !== 'undefined' ? legacyNativeCmder : null)); }

  /* ========================= 文件系统（RPC 通道） ========================= */

  const join = (dir, name) => String(dir).replace(/\/+$/, '') + '/' + name;
  const baseName = (p) => String(p).split(/[\\/]/).pop();

  function nfExists(p) { return safe(() => !!(NFS && NFS.exists(p)), false); }
  function nfReadText(p) { return safe(() => NFS.readFileText(p), null); }
  function nfWriteText(p, text) { return safe(() => !!NFS.writeFileText(p, text), false); }
  function nfRemove(p) { return safe(() => { NFS.remove(p); return true; }, false); }

  function nfReadDir(p) {
    return safe(() => {
      const list = NFS.readDir(p);
      if (!list) return [];
      return Array.from(list).map((x) => {
        const s = String(x);
        return /[\\/]/.test(s) ? s : join(p, s);
      });
    }, []);
  }

  async function mkdirp(dir) {
    if (nfExists(dir)) return true;
    await safeAsync(() => betterncm.fs.mkdir(dir));
    if (!nfExists(dir)) safe(() => NFS.rename(dir));
    return nfExists(dir);
  }

  /** 找到可用的根路径（兼容 /AgentBridge、./AgentBridge、绝对路径三种解析方式） */
  async function resolveRoot() {
    const candidates = [ROOT, '.' + ROOT, ROOT.slice(1)];
    safe(() => {
      const dp = String(NF.app.datapath() || '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (dp) candidates.push(dp + ROOT);
    });
    for (const c of candidates) {
      const dir = join(c, 'inbox');
      if (!nfExists(dir)) continue;
      const probe = join(dir, '.probe');
      if (nfWriteText(probe, String(Date.now())) && nfExists(probe)) {
        nfRemove(probe);
        return c;
      }
    }
    return ROOT;
  }

  function writeJson(path, obj) { return safe(() => nfWriteText(path, JSON.stringify(obj)), false); }

  /* ========================= 网易云状态采集 ========================= */

  function ncmApi() { return safe(() => (betterncm && betterncm.ncm ? betterncm.ncm : null)); }
  function ncmVersion() { return safe(() => ncmApi().getNCMVersion(), 'unknown'); }
  function ncmFullVersion() { return safe(() => ncmApi().getNCMFullVersion(), 'unknown'); }

  let playingFullFn = null;

  /** 网易云内部 getPlaying()：返回 { data: 完整歌曲信息, state, from } */
  function readPlayingFull() {
    try {
      if (!playingFullFn) {
        const f = ncmApi().findApiFunction && ncmApi().findApiFunction('getPlaying');
        if (f && typeof f[0] === 'function') playingFullFn = f[0].bind(f[1]);
      }
      if (!playingFullFn) return null;
      const r = playingFullFn();
      return r && r.data ? r : null;
    } catch (e) { return null; }
  }

  /* ---- 播放条 DOM（网易云 2.10：#main-player.m-player） ---- */

  const $ = (sel) => document.querySelector(sel);
  const playerEl = () => $('#main-player') || $('.m-player');
  /** 只查播放条内部，避免匹配到其它页面残留的同名 class */
  const P = (sel) => { const p = playerEl(); return p ? p.querySelector(sel) : null; };

  function playButton() {
    const p = playerEl();
    return p ? (p.querySelector('.btnp') || null) : null;
  }

  function readPlayingDom() {
    const btn = playButton();
    if (!btn) return null;
    // 播放中按钮带 btnp-pause（图标显示暂停）；class 名作为主判断
    return btn.classList.contains('btnp-pause');
  }

  function parseClock(text) {
    if (!text) return null;
    const parts = String(text).trim().split(':').map((x) => parseInt(x, 10));
    if (parts.some((n) => isNaN(n))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function readPrgPercent() {
    const el = P('.prg .has') || P('.prg .track');
    if (!el) return null;
    const w = parseFloat(el.style.width);
    return isFinite(w) ? w : null;
  }

  function readVolumePercent() {
    const el = P('.prg-spk .has');
    if (!el) return null;
    const h = parseFloat(el.style.height);
    return isFinite(h) ? h : null;
  }

  function readModeDom() {
    const el = P('.type');
    if (!el) return null;
    const cls = String(el.className || '');
    const m = cls.match(/type-([a-zA-Z]+)/);
    return {
      key: m ? m[1] : null,
      title: el.getAttribute('title') || '',
      className: cls,
    };
  }

  function readQualityDom() {
    const el = P('.brt .brttext');
    return el ? (el.textContent || '').trim() : '';
  }

  /** 重新采集一次状态（所有命令执行前都会调用） */
  function refresh() {
    const now = Date.now();
    const full = readPlayingFull();
    if (full) {
      const d = full.data;
      state.trackId = String(d.id);
      state.title = d.name || state.title;
      state.artists = (d.artists || []).map((a) => a.name).filter(Boolean);
      state.album = (d.album && d.album.name) || '';
      state.cover = (d.album && d.album.picUrl) || '';
      if (d.duration) state.durationMs = d.duration;
      state.apiState = full.state;
    }

    const domPlaying = readPlayingDom();
    state.domPlaying = domPlaying;

    if (state.nativeStateAt && now - state.nativeStateAt < 8000) {
      // 原生 PlayState 事件最准（音频在 C++ 进程里，页面重载不会打断它）
      state.playing = state.nativeState === 1;
    } else if (domPlaying !== null) {
      state.playing = domPlaying;
    }

    if (state.durationMs) {
      const domNow = parseClock(safe(() => (P('time.now') || {}).textContent));
      if (!state.progressAt || now - state.progressAt > 2000) {
        if (domNow !== null) {
          state.progressMs = domNow * 1000;
          state.progressAt = now;
          state.progressSource = 'dom-time';
        } else {
          const pct = readPrgPercent();
          if (pct !== null) {
            state.progressMs = Math.round((pct / 100) * state.durationMs);
            state.progressAt = now;
            state.progressSource = 'dom-percent';
          }
        }
      }
    }

    const vol = readVolumePercent();
    if (vol !== null) state.volume = Math.round(vol);
    const mode = readModeDom();
    if (mode) { state.mode = mode.key; state.modeTitle = mode.title; }
    state.quality = readQualityDom();

    state.lastRefresh = now;
    return state;
  }

  function snapshot() {
    refresh();
    return {
      plugin: 'ncm-agent-bridge',
      pluginVersion: VERSION,
      session: SESSION,
      ncm: ncmVersion(),
      ncmFull: ncmFullVersion(),
      playing: state.playing,
      track: {
        id: state.trackId,
        title: state.title,
        artists: state.artists,
        album: state.album,
        cover: state.cover,
      },
      progressMs: Math.round(state.progressMs || 0),
      durationMs: Math.round(state.durationMs || 0),
      volume: state.volume,
      mode: state.mode,
      modeTitle: state.modeTitle,
      quality: state.quality,
      // 诊断用：三种状态来源，便于校准
      raw: {
        domPlaying: state.domPlaying,
        nativeState: state.nativeState,
        apiState: state.apiState,
        progressSource: state.progressSource,
      },
      ts: Date.now(),
    };
  }

  /* ========================= 交互原语 ========================= */

  function clickElement(el, opts) {
    if (!el) throw err('NO_ELEMENT', '元素不存在');
    const rect = el.getBoundingClientRect();
    const x = opts && opts.clientX !== undefined ? opts.clientX : rect.left + rect.width / 2;
    const y = opts && opts.clientY !== undefined ? opts.clientY : rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, clientX: x, clientY: y };
    if (typeof PointerEvent === 'function') {
      safe(() => el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, isPrimary: true, pointerType: 'mouse' }, base))));
    }
    el.dispatchEvent(new MouseEvent('mousedown', base));
    if (typeof PointerEvent === 'function') {
      safe(() => el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ buttons: 0 }, base))));
    }
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { buttons: 0 })));
    el.dispatchEvent(new MouseEvent('click', Object.assign({}, base, { buttons: 0 })));
    return { x: Math.round(x), y: Math.round(y) };
  }

  function dragElement(el, xRatio, yRatio) {
    if (!el) throw err('NO_ELEMENT', '元素不存在');
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width * Math.min(1, Math.max(0, xRatio === undefined ? 0.5 : xRatio));
    const y = rect.top + rect.height * Math.min(1, Math.max(0, yRatio === undefined ? 0.5 : yRatio));
    const mk = (type, target) => {
      const o = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, clientX: x, clientY: y };
      target.dispatchEvent(new MouseEvent(type, o));
    };
    mk('mousedown', el);
    mk('mousemove', document);
    mk('mouseup', document);
    mk('click', el);
    return { x: Math.round(x), y: Math.round(y) };
  }

  function describeEl(el) {
    if (!el) return null;
    const cls = typeof el.className === 'string' ? el.className : '';
    return {
      tag: el.tagName,
      id: el.id || '',
      class: cls,
      text: (el.textContent || '').trim().slice(0, 120),
      title: el.getAttribute('title') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      href: el.getAttribute('href') || '',
      rect: safe(() => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }),
    };
  }

  function channelCall(name, args, timeoutMs) {
    const ch = channelApi();
    if (!ch || typeof ch.call !== 'function') return Promise.reject(err('NO_CHANNEL', '当前环境没有 channel API'));
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ acked: false, note: '通道未在 ' + (timeoutMs || 1200) + 'ms 内回调' });
      }, timeoutMs || 1200);
      try {
        ch.call(name, function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ acked: true, args: jsonSafe(Array.prototype.slice.call(arguments, 0, 4)) });
        }, args || []);
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err('CHANNEL_THREW', '调用 ' + name + ' 抛错：' + ((e && e.message) || e)));
      }
    });
  }

  /* ========================= 播放控制 ========================= */

  async function opToggle() {
    refresh();
    const before = readPlayingDom();
    const btn = playButton();
    if (!btn) throw err('NO_PLAYER_BUTTON', '未找到播放/暂停按钮（#main-player .btnp）');
    const pos = clickElement(btn);
    const ok = await waitFor(() => { refresh(); return readPlayingDom() !== before; }, 2500, 100);
    refresh();
    if (!ok) {
      throw err('NOT_CONFIRMED', '点击了播放按钮，但播放状态没有变化', { before, after: readPlayingDom(), pos });
    }
    return { changed: true, playing: refresh().playing, before: before, pos };
  }

  async function opSetPlaying(desired) {
    refresh();
    if (state.playing === desired) return { changed: false, playing: desired };
    const before = readPlayingDom();
    const btn = playButton();
    if (!btn) throw err('NO_PLAYER_BUTTON', '未找到播放/暂停按钮');
    clickElement(btn);
    let ok = await waitFor(() => { refresh(); return state.playing === desired; }, 3000, 100);
    if (!ok) {
      // 兜底：直接调原生播放/暂停通道
      await safeAsync(() => channelCall(desired ? 'audioplayer.play' : 'audioplayer.pause', [], 900));
      ok = await waitFor(() => { refresh(); return state.playing === desired; }, 2000, 100);
    }
    refresh();
    if (!ok) throw err('NOT_CONFIRMED', '无法把播放状态切换为' + (desired ? '播放' : '暂停'), { before, after: readPlayingDom(), playing: state.playing });
    return { changed: true, playing: state.playing };
  }

  async function opNext(direction) {
    refresh();
    const before = state.trackId;
    const el = direction > 0 ? P('.btnc-nxt') : P('.btnc-prv');
    if (!el) throw err('NO_NEXT_BUTTON', '未找到' + (direction > 0 ? '下一首' : '上一首') + '按钮（.btnc-nxt/.btnc-prv）');
    clickElement(el);
    const ok = await waitFor(() => { refresh(); return state.trackId && state.trackId !== before; }, 6000, 120);
    refresh();
    if (!ok) throw err('NOT_CONFIRMED', '已触发切歌，但曲目没有变化（可能队列只有一首或正在缓冲）', { before, after: state.trackId });
    return { changed: true, from: before, to: state.trackId, track: snapshot().track };
  }

  function seekTargets(seconds) {
    return [
      { sel: '.prg .has', type: 'progress' },
      { sel: '.prg', type: 'progress' },
    ];
  }

  async function opSeek(seconds) {
    refresh();
    const target = Math.max(0, Number(seconds) || 0);
    if (!state.trackId) throw err('NO_TRACK', '当前没有正在播放的歌曲');
    if (!state.durationMs) throw err('NO_DURATION', '还没拿到歌曲时长，稍后再试');
    const before = state.progressMs;
    const tol = 4000; // 播放中进度会持续前进，给 4s 容差
    const near = () => Math.abs(state.progressMs - target * 1000) < tol;
    if (near()) return { seeked: true, seconds: target, progressMs: state.progressMs, strategy: 'already-there' };

    // 注意：暂停状态下网易云会忽略 seek 并重置进度，建议先 play 再 seek
    const resumed = false;

    // 1) 网易云内部通道（不依赖页面状态，最稳）
    const token = state.trackId + '|seek|' + Math.random().toString(36).slice(2);
    const ch = await safeAsync(() => channelCall('audioplayer.seek', [state.trackId, token, target], 1200));
    let ok = await waitFor(() => { refresh(); return near(); }, 2500, 100);
    if (ok) return { seeked: true, seconds: target, progressMs: state.progressMs, strategy: 'channel', resumed, channel: ch };

    // 2) 兜底：点进度条
    const ratio = Math.min(1, target * 1000 / state.durationMs);
    for (const sel of ['.prg .has', '.prg']) {
      const el = P(sel);
      if (!el) continue;
      const pos = dragElement(el, ratio, 0.5);
      ok = await waitFor(() => { refresh(); return near(); }, 1800, 100);
      if (ok) return { seeked: true, seconds: target, progressMs: state.progressMs, strategy: 'dom:' + sel, resumed, pos };
    }
    throw err('NOT_CONFIRMED', '跳转进度没有被确认', { target, before, now: state.progressMs, resumed, channel: ch });
  }

  async function opVolume(value) {
    refresh();
    const target = Math.max(0, Math.min(100, Math.round(Number(value))));
    if (!isFinite(target)) throw err('BAD_ARGS', 'volume 需要 0-100 的数字');
    const before = state.volume;
    const el = P('.prg-spk .wrap') || P('.prg-spk');
    if (!el) throw err('NO_VOLUME_SLIDER', '未找到音量条（.prg-spk）');
    const pos = dragElement(el, 0.5, 1 - target / 100);
    const ok = await waitFor(() => {
      refresh();
      return state.volume !== null && Math.abs(state.volume - target) <= 4;
    }, 1800, 100);
    refresh();
    return { requested: target, previous: before, volume: state.volume, verified: ok, strategy: 'dom:.prg-spk', pos };
  }

  const MODE_MAP = {
    random: { key: 'random', title: '随机播放' },
    single: { key: 'single', title: '单曲循环' },
    order: { key: 'order', title: '顺序播放' },
    loop: { key: 'loop', title: '列表循环' },
    fm: { key: 'fm', title: '私人FM' },
  };

  async function opMode(mode) {
    refresh();
    const want = String(mode || '').toLowerCase();
    if (!want) throw err('BAD_ARGS', '缺少 mode（random/single/order/loop/fm）');
    const before = state.mode;
    if (state.mode === want) return { changed: false, mode: state.mode, modeTitle: state.modeTitle };
    const btn = P('.type');
    if (!btn) throw err('NO_MODE_BUTTON', '未找到播放模式按钮（.type）');
    for (let i = 0; i < 6; i++) {
      clickElement(btn);
      await sleep(280);
      refresh();
      if (state.mode === want) return { changed: true, from: before, mode: state.mode, modeTitle: state.modeTitle, clicks: i + 1 };
    }
    throw err('NOT_CONFIRMED', '没有切换到模式 ' + want + '（当前 ' + state.mode + '）', { before, after: state.mode, available: Object.keys(MODE_MAP) });
  }

  async function opQuality(quality) {
    refresh();
    const q = String(quality || '');
    if (!q) throw err('BAD_ARGS', '缺少 quality（standard/higher/exhigh/lossless）');
    const map = { standard: '128', higher: '192', exhigh: '320', lossless: '999' };
    const brt = map[q] || q;
    const current = state.quality;
    if (current && current.indexOf('标准') >= 0 && brt === '128') return { changed: false, quality: current };
    const trigger = P('.brt .brttext');
    if (!trigger) throw err('NO_QUALITY_MENU', '未找到音质菜单（.brt .brttext）');
    clickElement(trigger);
    await sleep(250);
    const item = P('.brtlist li[data-brt="' + brt + '"]');
    if (!item) throw err('NO_QUALITY_ITEM', '音质菜单里没有 data-brt=' + brt + ' 的选项');
    clickElement(item);
    await sleep(600);
    refresh();
    return { requested: q, bitrate: brt, quality: state.quality, changed: state.quality !== current };
  }

  /* ========================= 歌单 / 下载 ========================= */

  const SONG_ROW = '.itm[data-res-id]';

  function songRows() {
    return Array.from(document.querySelectorAll(SONG_ROW)).filter((n) => {
      const t = n.getAttribute('data-res-type');
      return t === '4' || /tid-/.test(String(n.className || ''));
    });
  }

  /** 播放列表行（data-res-data 就是所属歌单 id） */
  function rowsByPlaylist(id) {
    return songRows().filter((r) => String(r.getAttribute('data-res-data')) === String(id));
  }

  /** 等歌单页渲染完成：出现目标歌单的行，并且数量稳定下来 */
  async function waitForRows(id, timeoutMs) {
    const t0 = Date.now();
    let last = -1;
    let stableSince = 0;
    while (Date.now() - t0 < timeoutMs) {
      const n = rowsByPlaylist(id).length;
      if (n > 0) {
        if (n === last) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince > 400) return rowsByPlaylist(id);
        } else {
          last = n;
          stableSince = 0;
        }
      }
      await sleep(200);
    }
    return rowsByPlaylist(id);
  }

  function scrapeRow(li) {
    const titEl = li.querySelector('.tit');
    const cols = Array.from(li.querySelectorAll('.td.col'));
    const artistCol = cols[1] || null;
    const albumCol = cols[2] || null;
    const durCol = cols[3] || null;
    const artists = artistCol
      ? Array.from(artistCol.querySelectorAll('a')).map((a) => (a.textContent || '').trim()).filter(Boolean)
      : [];
    return {
      id: li.getAttribute('data-res-id'),
      title: titEl ? (titEl.getAttribute('title') || (titEl.textContent || '').trim()) : '',
      artists: artists,
      album: albumCol ? (albumCol.textContent || '').trim().slice(0, 80) : '',
      duration: durCol ? (durCol.textContent || '').trim() : '',
      downloaded: /z-dld|dld-ok/.test(String((li.querySelector('[class*="offline-"]') || {}).className || '')),
    };
  }

  function hoverEl(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    ['mouseover', 'mouseenter', 'mousemove'].forEach((t) => el.dispatchEvent(new MouseEvent(t, o)));
  }

  /** 侧边栏里的歌单列表（不需要切页，随时可读） */
  function readPlaylists() {
    const out = [];
    const seen = {};
    Array.from(document.querySelectorAll('a[href*="/m/playlist/"]')).forEach((a) => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/[?&]id=(\d+)/);
      const id = a.getAttribute('data-id') || (m ? m[1] : '');
      const name = (a.textContent || '').trim();
      if (!id || !/^\d+$/.test(String(id)) || !name || seen[id]) return;
      seen[id] = 1;
      const r = a.getBoundingClientRect();
      out.push({ id: String(id), name: name, visible: r.width > 0, x: Math.round(r.left), y: Math.round(r.top) });
    });
    return out;
  }

  async function opPlaylists() {
    if (readPlaylists().length < 2) {
      await waitFor(() => readPlaylists().length > 1, 4000, 250);
    }
    const items = readPlaylists();
    return {
      count: items.length,
      playlists: items,
      note: '来自左侧「我的音乐」侧边栏；用 playlist op 读取某个歌单的歌曲列表'
        + (items.some((x) => x.visible) ? '' : '（侧边栏收起时 visible 为 false，但 id 依然可用）'),
    };
  }

  async function opNavigate(a) {
    const hash = String(a.hash || a.url || '');
    if (!hash) throw err('BAD_ARGS', '缺少 hash，例如 #/m/offline/download/');
    if (location.hash !== hash) {
      location.hash = hash;
      await waitFor(() => location.hash === hash, 3000, 100);
    }
    await sleep(Number(a.waitMs) || 1500);
    return {
      hash: location.hash,
      rows: songRows().length,
      page: safe(() => (document.querySelector('[id^="page_"]') || {}).id),
    };
  }

  async function opPlaylist(a) {
    const id = String(a.id || a.playlistId || '');
    if (!id) throw err('BAD_ARGS', '缺少歌单 id（可先用 playlists op 查）');
    const target = '#/m/playlist/?id=' + id;
    if (location.hash !== target) {
      location.hash = target;
      await waitForRows(id, 20000);
    } else {
      await waitForRows(id, 6000);
    }
    await sleep(Number(a.waitMs) || 300);
    const matched = rowsByPlaylist(id);
    const rows = matched.length ? matched : songRows();
    const offset = Math.max(0, Number(a.offset) || 0);
    const limit = Math.max(1, Math.min(1000, Number(a.limit) || 100));
    return {
      playlistId: id,
      hash: location.hash,
      total: rows.length,
      offset,
      tracks: rows.slice(offset, offset + limit).map(scrapeRow),
    };
  }

  async function opDownload(a) {
    refresh();
    const id = String(a.id || state.trackId || '');
    if (!id) throw err('BAD_ARGS', '缺少歌曲 id，也没有正在播放的歌曲');
    const row = document.querySelector('.itm[data-res-id="' + id + '"]');
    if (!row) {
      throw err('NO_ROW', '当前页面上没有这首歌的行；先打开包含它的歌单（playlist / navigate）再下载', { id, hash: location.hash });
    }
    hoverEl(row);
    await sleep(200);
    const icon = row.querySelector('[class*="offline-"]');
    if (!icon) throw err('NO_DOWNLOAD_ICON', '没找到这一行的下载按钮（.offline-*）');
    clickElement(icon);
    const ok = await waitFor(() => /z-dld|dld_ok|dlding|dld-ing/.test(String(icon.className)), 4000, 200);
    return {
      id,
      triggered: true,
      verified: !!ok,
      rowFound: true,
      iconClass: String(icon.className),
      note: ok
        ? '已开始/完成下载'
        : '已点击下载按钮但没有回读到下载状态：网易云的下载按钮需要真实鼠标悬停/会员权限，脚本点击通常不生效（见 README 的“已知限制”）',
    };
  }

  /** 下载管理页：任务列表 + 存储目录 */
  async function opDownloads(a) {
    if (a.navigate !== false) {
      if (!/offline\/download/.test(location.hash)) {
        location.hash = '#/m/offline/download/';
        await waitFor(() => /offline\/download/.test(location.hash), 5000, 150);
      }
      await waitFor(() => document.querySelectorAll('.itm[data-res-id]').length > 0, 12000, 300);
      await sleep(Number(a.waitMs) || 300);
    }
    // 下载页有多个 tab（已下载单曲/声音/MV、正在下载），需要时显式指定 tab
    const tabName = String(a.tab || '');
    if (tabName) {
      const hit = Array.from(document.querySelectorAll('.g-mn [class*="tab"], .g-mn .f-cp')).find((e) => {
        const r = e.getBoundingClientRect();
        return (e.textContent || '').trim() === tabName && r.width > 0 && r.width < 240 && r.height < 80;
      });
      if (hit) { clickElement(hit); await sleep(900); }
    }
    const box = document.querySelector('.g-mn') || document.body;
    const text = (box.textContent || '').replace(/\s+/g, ' ');
    const dir = text.match(/存储目录[：:]\s*([A-Za-z]:[^ ]+)/);
    const limit = Math.max(1, Math.min(200, Number(a.limit) || 50));
    const tasks = Array.from(document.querySelectorAll('.itm[data-res-id]')).slice(0, limit).map((r) => {
      const t = (r.textContent || '').replace(/\s+/g, ' ').trim();
      const status = /已暂停/.test(t) ? 'paused'
        : /下载中|正在下载/.test(t) ? 'downloading'
          : /已下载|已完成/.test(t) ? 'done' : '';
      return {
        id: r.getAttribute('data-res-id'),
        title: ((r.querySelector('.tit') || {}).textContent || '').trim() || t.slice(0, 40),
        status,
        text: t.slice(0, 80),
      };
    });
    return {
      hash: location.hash,
      storageDir: dir ? dir[1] : null,
      total: document.querySelectorAll('.itm[data-res-id]').length,
      tasks,
      note: '网易云下载管理页；开始新下载需要客户端自己的下载按钮（真实鼠标悬停），见 README',
    };
  }

  /* ========================= 诊断 ========================= */

  function keysOf(obj, limit) {
    return safe(() => (obj ? Object.keys(obj).slice(0, limit || 80) : null), null);
  }

  async function probeChannel(name, args) {
    const ch = channelApi();
    if (!ch || typeof ch.call !== 'function') return { name, result: 'no-channel' };
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(Object.assign({ name }, v)); };
      try {
        ch.call(name, function () {
          finish({ result: 'replied', args: jsonSafe(Array.prototype.slice.call(arguments, 0, 2)) });
        }, args || []);
      } catch (e) {
        finish({ result: 'threw', message: String((e && e.message) || e) });
        return;
      }
      setTimeout(() => finish({ result: 'silent' }), 350);
    });
  }

  let wpRequire = null;
  function webpackRequire() {
    if (wpRequire) return wpRequire;
    const wp = window.webpackJsonp;
    if (!Array.isArray(wp)) return null;
    const key = 'agentbridge_' + Date.now();
    const mods = {};
    mods[key] = function (m, e, r) { wpRequire = r; };
    try { wp.push([[key], mods, [[key]]]); } catch (e) { return null; }
    return wpRequire;
  }

  function moduleIdsWith(markers) {
    const req = webpackRequire();
    if (!req || !req.m) return [];
    const out = [];
    for (const id of Object.keys(req.m)) {
      const fn = req.m[id];
      if (typeof fn !== 'function') continue;
      const src = safe(() => String(fn), '');
      if (markers.every((m) => src.indexOf(m) >= 0)) out.push(id);
    }
    return out;
  }

  function moduleExports(markers) {
    const ids = moduleIdsWith(markers);
    const out = [];
    for (const id of ids) {
      let ex = null;
      try { ex = webpackRequire()(id); } catch (e) { continue; }
      if (ex) out.push({ id, exports: ex });
    }
    return out;
  }

  async function opDiagnose() {
    const d = {
      plugin: { version: VERSION, session: SESSION, fsRoot, dirs: { inbox: nfExists(join(ROOT, 'inbox')), outbox: nfExists(join(ROOT, 'outbox')) } },
      page: { href: location.href, hash: location.hash, title: document.title, visibility: document.visibilityState },
      versions: { ncm: ncmVersion(), ncmFull: ncmFullVersion(), native: safe(() => NF.app.version()) },
      globals: {
        betterncm: keysOf(betterncm),
        betterncmNcm: keysOf(ncmApi()),
        betterncmNative: keysOf(NF),
        nativeFs: keysOf(NFS),
        channel: safe(() => (channelApi() ? keysOf(channelApi()) : null)),
        legacyNativeCmder: safe(() => (nativeCmder() ? keysOf(nativeCmder()) : null)),
        webpackJsonp: safe(() => (Array.isArray(window.webpackJsonp) ? 'array' : typeof window.webpackJsonp)),
      },
      state: snapshot(),
      dom: {
        player: describeEl(playerEl()),
        btnp: describeEl(playButton()),
        prg: describeEl(P('.prg')),
        volume: describeEl(P('.prg-spk')),
        mode: describeEl(P('.type')),
        quality: describeEl(P('.brt .brttext')),
        audios: safe(() => Array.from(document.querySelectorAll('audio')).length, 0),
      },
      webpackModules: {
        audioPlayer: moduleIdsWith(['setAudioPlayerPlay', 'seekAudioPlayer']),
        playerApi: moduleIdsWith(['switchQuality', 'setPosition', 'getPlayingInfo']),
      },
      channelProbe: [],
    };
    d.versions.betterncm = await safeAsync(() => betterncm.app.getBetterNCMVersion());
    for (const n of ['app.getLocalConfig', 'audioplayer.isDeviceMute', 'os.getSystemInfo']) {
      d.channelProbe.push(await probeChannel(n, []));
    }
    return d;
  }

  /* ========================= 命令实现 ========================= */

  const OPS = Object.create(null);

  OPS.ping = async () => ({
    plugin: 'ncm-agent-bridge', version: VERSION, session: SESSION,
    fsRoot, ncm: ncmVersion(), ready: healthy, ts: Date.now(),
  });

  OPS.status = async () => { refresh(); return snapshot(); };

  OPS.toggle = () => opToggle();
  OPS.play = () => opSetPlaying(true);
  OPS.pause = () => opSetPlaying(false);
  OPS.next = () => opNext(1);
  OPS.prev = () => opNext(-1);
  OPS.seek = async (a) => opSeek(a.seconds !== undefined ? a.seconds : (Number(a.ms) || 0) / 1000);
  OPS.volume = (a) => opVolume(a.value !== undefined ? a.value : a.volume);
  OPS.mode = (a) => opMode(a.mode || a.value);
  OPS.quality = (a) => opQuality(a.quality || a.value);
  OPS.diagnose = () => opDiagnose();
  OPS.playlists = () => opPlaylists();
  OPS.playlist = (a) => opPlaylist(a);
  OPS.download = (a) => opDownload(a);
  OPS.downloads = (a) => opDownloads(a);
  OPS.navigate = (a) => opNavigate(a);

  OPS.query = async (a) => {
    const sel = String(a.selector || '');
    if (!sel) throw err('BAD_ARGS', '缺少 selector');
    const limit = Math.max(1, Math.min(200, Number(a.limit) || 20));
    const list = Array.from(document.querySelectorAll(sel)).slice(0, limit);
    return { selector: sel, count: list.length, elements: list.map(describeEl) };
  };

  OPS.html = async (a) => {
    const sel = String(a.selector || '#main-player');
    const limit = Math.max(200, Math.min(60000, Number(a.limit) || 6000));
    const el = $(sel);
    if (!el) throw err('NO_ELEMENT', '找不到元素：' + sel);
    return { selector: sel, html: el.outerHTML.slice(0, limit) };
  };

  OPS.click = async (a) => {
    const sel = String(a.selector || '');
    if (!sel) throw err('BAD_ARGS', '缺少 selector');
    const list = document.querySelectorAll(sel);
    const idx = Math.max(0, Number(a.index) || 0);
    const el = list[idx];
    if (!el) throw err('NO_ELEMENT', '找不到元素：' + sel + '[' + idx + ']');
    const before = describeEl(el);
    let pos;
    if (a.xRatio !== undefined || a.yRatio !== undefined) {
      const r = el.getBoundingClientRect();
      pos = clickElement(el, {
        clientX: r.left + r.width * (a.xRatio === undefined ? 0.5 : Number(a.xRatio)),
        clientY: r.top + r.height * (a.yRatio === undefined ? 0.5 : Number(a.yRatio)),
      });
    } else {
      pos = clickElement(el);
    }
    await sleep(Number(a.waitMs) || 150);
    return { clicked: true, element: before, pos };
  };

  OPS.type = async (a) => {
    const sel = String(a.selector || '');
    const text = String(a.text === undefined ? (a.value === undefined ? '' : a.value) : a.text);
    const el = $(sel);
    if (!el) throw err('NO_ELEMENT', '找不到输入框：' + sel);
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (a.enter !== false) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    await sleep(Number(a.waitMs) || 300);
    return { typed: true, value: el.value, selector: sel };
  };

  OPS.channel = async (a) => {
    const name = String(a.name || '');
    if (!name) throw err('BAD_ARGS', '缺少 name');
    const r = await channelCall(name, Array.isArray(a.args) ? a.args : [], Number(a.timeoutMs) || 1500);
    return { name, args: jsonSafe(a.args || []), result: r };
  };

  OPS.js = async (a) => {
    const code = String(a.code || a.body || '');
    if (!code) throw err('BAD_ARGS', '缺少 code');
    // 直接 eval：可以访问插件内部变量，方便调试
    // eslint-disable-next-line no-eval
    let value = eval(code);
    if (value && typeof value.then === 'function') value = await withTimeout(value, Number(a.timeoutMs) || 5000, 'js');
    return { value: jsonSafe(value) };
  };

  OPS.log = async () => ({ entries: log.slice(0, MAX_LOG) });

  OPS.reload = async () => {
    setTimeout(() => { safe(() => NF.app.reloadIgnoreCache()); }, 300);
    return { reloading: true };
  };

  /* ========================= 命令分发 ========================= */

  function pushLog(entry) {
    log.unshift(entry);
    if (log.length > MAX_LOG) log.pop();
    renderBadge();
  }

  async function handleCommand(cmd, cmdPath) {
    const started = Date.now();
    const op = cmd && cmd.op ? String(cmd.op) : '';
    const args = (cmd && cmd.args) || {};
    const id = String((cmd && cmd.id) || baseName(cmdPath).replace(/\.json$/, ''));
    let payload;
    try {
      const fn = OPS[op];
      if (!fn) throw err('UNKNOWN_OP', '未知操作：' + op + '（可用：' + Object.keys(OPS).join(', ') + '）');
      // 每条命令先刷新一次状态，避免状态过期
      safe(refresh);
      const data = await withTimeout(Promise.resolve(fn(args)), Number(cmd.timeoutMs) || 15000, op);
      payload = { id, ok: true, op, data, ms: Date.now() - started, ts: Date.now() };
      pushLog({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), op, ok: true, ms: payload.ms });
    } catch (e) {
      const code = (e && e.code) || 'ERROR';
      payload = {
        id, ok: false, op,
        error: { code, message: String((e && e.message) || e), extra: jsonSafe(e && e.extra) },
        ms: Date.now() - started, ts: Date.now(),
      };
      pushLog({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), op, ok: false, ms: payload.ms, note: code });
    }
    if (!disposed && fsRoot) writeJson(join(fsRoot, 'outbox') + '/' + id + '.res.json', payload);
    return payload;
  }

  async function scanInbox() {
    if (disposed || scanning || !fsRoot) return;
    scanning = true;
    try {
      const dir = join(fsRoot, 'inbox');
      const files = nfReadDir(dir).filter((p) => /\.json$/i.test(p));
      for (const file of files) {
        const name = baseName(file);
        if (handled.has(name)) continue;
        handled.set(name, Date.now());
        let cmd = null;
        let raw = null;
        try {
          raw = nfReadText(file);
          cmd = raw ? JSON.parse(raw) : null;
        } catch (e) {
          cmd = null;
          const badId = name.replace(/\.json$/i, '');
          writeJson(join(fsRoot, 'outbox') + '/' + badId + '.res.json', {
            id: badId, ok: false, error: { code: 'BAD_JSON', message: '命令文件不是合法 JSON' }, ts: Date.now(),
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

  /* ========================= 心跳 / 悬浮标 / 设置页 ========================= */

  let lastStatusJson = '';

  function writeStatus(force) {
    if (!fsRoot) return;
    const s = snapshot();
    s.dirs = { inbox: nfExists(join(fsRoot, 'inbox')), outbox: nfExists(join(fsRoot, 'outbox')) };
    s.log = log.slice(0, 8);
    s.healthy = healthy;
    const text = JSON.stringify(s);
    if (!force && text === lastStatusJson) return;
    lastStatusJson = text;
    writeJson(join(fsRoot, 'status.json'), s);
  }

  let badgeEl = null;

  function badgeEnabled() { return safe(() => plugin.getConfig('badge', 'true') !== 'false', true); }

  function renderBadge() {
    safe(() => {
      if (!badgeEnabled()) { if (badgeEl) { badgeEl.remove(); badgeEl = null; } return; }
      if (!badgeEl || !badgeEl.isConnected) {
        badgeEl = document.createElement('div');
        badgeEl.id = 'ncm-agent-badge';
        badgeEl.style.cssText = [
          'position:fixed', 'right:14px', 'bottom:82px', 'z-index:2147483000',
          'padding:3px 9px', 'border-radius:999px', 'font-size:11px', 'line-height:16px',
          'font-family:Consolas,Menlo,monospace', 'letter-spacing:.4px',
          'background:rgba(0,0,0,.42)', 'color:#fff', 'pointer-events:none',
          'opacity:.55', 'transition:opacity .2s', 'white-space:nowrap',
        ].join(';');
        document.body.appendChild(badgeEl);
      }
      const last = log[0];
      badgeEl.textContent = 'AGENT · ' + (last ? (last.op + (last.ok ? '' : ' !')) : '待命');
    });
  }

  function buildConfigPanel() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:22px 26px;font-size:13px;line-height:1.7;max-width:760px';
    const title = document.createElement('h2');
    title.textContent = 'NCM Agent Bridge';
    title.style.cssText = 'font-size:20px;margin:0 0 4px';
    const sub = document.createElement('div');
    sub.style.cssText = 'opacity:.65;margin-bottom:16px';
    sub.textContent = '让 AI / 脚本通过本地文件队列操作网易云音乐 · v' + VERSION;
    wrap.appendChild(title);
    wrap.appendChild(sub);

    const info = document.createElement('div');
    info.style.cssText = 'padding:12px 14px;border:1px solid rgba(128,128,128,.35);border-radius:10px;margin-bottom:14px';
    wrap.appendChild(info);

    const refreshInfo = () => {
      const s = snapshot();
      info.innerHTML = '';
      const line = (k, v) => {
        const row = document.createElement('div');
        row.innerHTML = '<span style="opacity:.55">' + k + '：</span><span>' + String(v) + '</span>';
        info.appendChild(row);
      };
      line('状态', s.playing ? '▶ 正在播放' : '⏸ 已暂停');
      line('歌曲', (s.track.title || '（未知）') + (s.track.artists.length ? ' — ' + s.track.artists.join('/') : ''));
      line('进度', (s.progressMs / 1000).toFixed(1) + 's / ' + (s.durationMs / 1000).toFixed(1) + 's');
      line('音量 / 模式', (s.volume === null ? '未知' : s.volume) + ' / ' + (s.mode || '未知'));
      line('网易云', s.ncm);
      line('数据目录', fsRoot || '（未知）');
    };
    refreshInfo();
    timers.push(setInterval(() => { if (!disposed) refreshInfo(); }, 1000));

    const logBox = document.createElement('div');
    logBox.style.cssText = 'font-family:Consolas,Menlo,monospace;font-size:12px;max-height:180px;overflow:auto;padding:8px 10px;border:1px solid rgba(128,128,128,.25);border-radius:10px;margin-bottom:14px';
    wrap.appendChild(logBox);
    const renderLog = () => {
      logBox.innerHTML = log.length
        ? log.slice(0, 15).map((x) => '<div style="opacity:' + (x.ok ? '.8' : '1') + '">' + x.t + '  ' + x.op + '  ' + (x.ok ? '✓ ' + x.ms + 'ms' : '✗ ' + (x.note || '')) + '</div>').join('')
        : '<div style="opacity:.5">还没有收到过命令</div>';
    };
    renderLog();
    timers.push(setInterval(() => { if (!disposed) renderLog(); }, 1000));

    const btnStyle = 'padding:6px 12px;margin-right:8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer';
    const mkBtn = (label, onclick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = btnStyle;
      b.onclick = onclick;
      return b;
    };

    wrap.appendChild(mkBtn('打开数据目录', async () => {
      const dir = (safe(() => NF.app.datapath()) || 'C:\\betterncm') + '\\AgentBridge';
      await safeAsync(() => betterncm.app.exec('explorer.exe "' + dir + '"'));
    }));
    wrap.appendChild(mkBtn('运行自检', async () => {
      const r = await safeAsync(() => opDiagnose());
      writeJson(join(fsRoot || ROOT, 'diagnose.json'), r);
      alert('自检结果已写入 AgentBridge/diagnose.json');
    }));
    wrap.appendChild(mkBtn('清空日志', () => { log.length = 0; renderLog(); }));

    const badgeLabel = document.createElement('label');
    badgeLabel.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:6px;opacity:.8';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = badgeEnabled();
    cb.onchange = () => { safe(() => plugin.setConfig('badge', cb.checked ? 'true' : 'false')); renderBadge(); };
    badgeLabel.appendChild(cb);
    badgeLabel.appendChild(document.createTextNode('显示悬浮标'));
    wrap.appendChild(badgeLabel);

    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:16px;opacity:.6;font-size:12px;line-height:1.7';
    hint.innerHTML = '外部程序把命令 JSON 写进 <code>' + (safe(() => NF.app.datapath()) || 'C:\\betterncm') + '\\AgentBridge\\inbox</code> 即可；'
      + '结果在 <code>outbox</code>，实时状态在 <code>status.json</code>。'
      + '<br>命令行客户端：<code>tools\\ncm.ps1 status</code>';
    wrap.appendChild(hint);
    return wrap;
  }

  /* ========================= 启动 ========================= */

  async function start() {
    await mkdirp(join(ROOT, 'inbox'));
    await mkdirp(join(ROOT, 'outbox'));
    fsRoot = await resolveRoot();

    // 订阅网易云原生播放事件：进度 / 时长 / 播放状态（音频在 C++ 侧，页面重载也不会断）
    const cm = nativeCmder();
    if (cm && typeof cm.appendRegisterCall === 'function') {
      safe(() => cm.appendRegisterCall('Load', 'audioplayer', function (_a, info) {
        if (info && typeof info.duration === 'number') state.durationMs = info.duration * 1000;
      }));
      safe(() => cm.appendRegisterCall('PlayProgress', 'audioplayer', function (_a, progress) {
        if (typeof progress === 'number') {
          state.progressMs = progress * 1000;
          state.progressAt = Date.now();
          state.progressSource = 'native';
        }
      }));
      safe(() => cm.appendRegisterCall('PlayState', 'audioplayer', function (_a, _b, st) {
        state.nativeState = st;
        state.nativeStateAt = Date.now();
      }));
    }

    writeJson(join(fsRoot, 'hello.json'), {
      plugin: 'ncm-agent-bridge', version: VERSION, session: SESSION,
      ncm: ncmVersion(), ncmFull: ncmFullVersion(), fsRoot,
      dataPath: safe(() => NF.app.datapath()),
      startedAt: new Date().toISOString(),
    });

    await scanInbox();
    safe(() => {
      if (NFS && typeof NFS.watchDirectory === 'function') {
        NFS.watchDirectory(join(fsRoot, 'inbox'), function () { scanInbox(); });
      }
    });

    later(() => { scanInbox(); }, 200);
    later(() => { writeStatus(false); }, 1500);

    healthy = true;
    renderBadge();
    pushLog({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), op: 'plugin.loaded', ok: true, ms: 0 });
    writeStatus(true);
  }

  plugin.onConfig(function () { return buildConfigPanel(); });

  window.__ncmAgentBridge = {
    version: VERSION,
    get state() { return snapshot(); },
    ops: OPS,
    webpack: {
      req: () => webpackRequire(),
      modulesWith: (markers) => moduleIdsWith(Array.isArray(markers) ? markers : [markers]),
      exportsOf: (markers) => moduleExports(Array.isArray(markers) ? markers : [markers]),
    },
    dispose() {
      disposed = true;
      timers.forEach((t) => clearInterval(t));
      if (badgeEl) { safe(() => badgeEl.remove()); badgeEl = null; }
    },
  };

  try {
    await start();
  } catch (e) {
    try {
      writeJson('/AgentBridge/plugin-error.json', {
        plugin: 'ncm-agent-bridge', version: VERSION,
        message: String((e && e.stack) || e), ts: Date.now(),
      });
    } catch (e2) { /* ignore */ }
    console.error('[NCM Agent Bridge] 启动失败', e);
  }
});

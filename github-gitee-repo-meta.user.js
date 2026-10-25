// ==UserScript==
// @name         Repo Meta — GitHub / Gitee 仓库元信息
// @name:en      Repo Meta — Created & Last Push Time for GitHub / Gitee
// @namespace    https://github.com/wkkwky/repo-meta
// @version      1.2.8
// @description  在 GitHub / Gitee 仓库页的 About（简介）侧栏显示创建时间、最后推送、最后更新、项目年龄、代码活跃度、仓库大小（可拖动悬浮面板）
// @description:en  Show repo created time, last push, last update, age, activity and size in the About sidebar on GitHub / Gitee (optional draggable floating panel)
// @author       wkkwky
// @license      MIT
// @homepageURL  https://github.com/wkkwky/repo-meta
// @supportURL   https://github.com/wkkwky/repo-meta/issues
// @downloadURL  https://raw.githubusercontent.com/wkkwky/repo-meta/main/github-gitee-repo-meta.user.js
// @updateURL    https://raw.githubusercontent.com/wkkwky/repo-meta/main/github-gitee-repo-meta.user.js
// @match        https://github.com/*
// @match        https://gitee.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.github.com
// @connect      gitee.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 模块结构：
 *   1. 常量与路径黑名单  确定哪些 URL 属于仓库页面
 *   2. 设置读写          悬浮面板开关、收起状态、拖动坐标、临时静音，持久化于 localStorage
 *   3. 数据层            调用平台 REST API，6 小时缓存，并将两端字段名归一
 *   4. 格式化            日期、相对时间、项目年龄、活跃度、体积
 *   5. 渲染              面板 DOM、样式、拖动、菜单
 *   6. 注入策略          优先插入侧栏信息区；不可用时按设置回退为悬浮面板
 */
(function () {
  'use strict';

  // 结果缓存有效期（毫秒）。GitHub 未认证接口限额为每小时 60 次，缓存用于避免超限。
  var CACHE_TTL = 6 * 60 * 60 * 1000;
  // 面板根节点的 id。用于判断当前页面是否已注入，以及切换仓库时移除旧节点。
  var BOARD_ID = 'repo-meta-board';
  // 设置项的 localStorage 键。
  var SETTINGS_KEY = 'repoMeta:settings';
  // 可选 GitHub 访问令牌的存储键。配置后接口额度由每小时 60 次提升至 5000 次。
  var TOKEN_KEY = 'repoMeta:ghToken';
  // 可选 Gitee 私人令牌的存储键。Gitee /api/v5 对匿名请求返回 404，必须携带 access_token。
  var GITEE_TOKEN_KEY = 'repoMeta:giteeToken';
  // 调试开关。置为 true 时输出注入、缓存与错误日志。
  var DEBUG = false;

  // GitHub 与 Gitee 的仓库 URL 均为 /{owner}/{repo}，与功能页路径形态一致，
  // 因此以保留路径黑名单排除非仓库页面（例如 /settings/profile、/topics/javascript）。
  var RESERVED = [
    'about', 'account', 'apps', 'api', 'codespaces', 'collections', 'contact', 'customer-stories',
    'dashboard', 'discussions', 'enterprise', 'enterprises', 'events', 'explore', 'features', 'gists',
    'help', 'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'oauth',
    'openapi', 'org', 'organizations', 'orgs', 'packages', 'pricing', 'projects', 'pulls', 'readme',
    'search', 'security', 'service', 'sessions', 'settings', 'signup', 'site', 'sponsors', 'stars',
    'team', 'terms', 'topics', 'trending', 'users', 'wiki', 'gitee', 'following', 'followers',
    'repositories', 'watching', 'ai', 'mcp', 'backend', 'inactive'
  ];
  // 第二段为用户名下的子页面时同样不是仓库（例如 /wkkwk/following、/wkkwk/stars）。
  var RESERVED_SUB = ['trending', 'followers', 'following', 'repositories', 'projects', 'stars', 'sponsors', 'watching'];

  function log() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[repo-meta]');
    console.log.apply(console, args);
  }

  function lsGet(k) {
    try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
  }

  /*
   * 设置模型，整体存为一个 JSON：
   *   float     悬浮面板总开关，属于用户偏好；关闭菜单中的「关闭悬浮面板」直接修改该项
   *   collapsed 悬浮面板是否收起
   *   left/top  拖动后的面板坐标
   *   muteUntil 24 小时静音的截止时间戳，临时状态，与 float 相互独立
   * 旧版本以 mutedForever 表示「不再自动显示」，现统一折算为 float = false；
   * 读取时自动迁移，使设置菜单始终只呈现一个开关。
   */
  function loadSettings() {
    var s = {};
    try { s = JSON.parse(lsGet(SETTINGS_KEY) || '{}') || {}; } catch (e) { s = {}; }
    return {
      float: s.mutedForever ? false : !!s.float,
      collapsed: !!s.collapsed,
      left: typeof s.left === 'number' ? s.left : null,
      top: typeof s.top === 'number' ? s.top : null,
      muteUntil: Number(s.muteUntil) || 0
    };
  }

  function saveSettings(patch) {
    var s = loadSettings();
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }

  // 解析当前 URL 得到 {site, owner, repo}。非仓库页面返回 null，后续流程以 null 表示不处理。
  function parseRepo() {
    var host = location.hostname;
    var site = null;
    if (/^(www\.)?github\.com$/.test(host)) site = 'github';
    else if (/^(www\.)?gitee\.com$/.test(host)) site = 'gitee';
    if (!site) return null;

    var m = location.pathname.match(/^\/([^/]+)\/([^/]+)/);
    if (!m) return null;
    var owner = decodeURIComponent(m[1]);
    var repo = decodeURIComponent(m[2]).replace(/\.git$/, '');
    if (!owner || !repo) return null;
    if (RESERVED.indexOf(owner.toLowerCase()) !== -1) return null;
    if (RESERVED_SUB.indexOf(repo.toLowerCase()) !== -1) return null;
    return { site: site, owner: owner, repo: repo, key: site + '/' + owner + '/' + repo };
  }

  // 判断是否为仓库首页（/owner/repo），用于区分首页与 Issues、PR、代码浏览等子页面。
  function isRepoHome() {
    return location.pathname.replace(/\/+$/, '').split('/').length === 3;
  }

  // 优先使用 GM_xmlhttpRequest 以规避跨域限制；不可用时回退到 fetch（需 @connect 授权）。
  function httpJson(url, headers) {
    return new Promise(function (resolve, reject) {
      var gm = null;
      if (typeof GM_xmlhttpRequest === 'function') gm = GM_xmlhttpRequest;
      else if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') gm = GM.xmlHttpRequest.bind(GM);
      if (gm) {
        try {
          gm({
            method: 'GET',
            url: url,
            headers: headers || {},
            timeout: 15000,
            onload: function (r) {
              if (r.status >= 400) {
                var e1 = new Error('HTTP ' + r.status);
                e1.status = r.status;
                return reject(e1);
              }
              try { resolve(JSON.parse(r.responseText)); }
              catch (e) { reject(new Error('响应不是 JSON')); }
            },
            onerror: function () { reject(new Error('网络错误（被拦截或离线）')); },
            ontimeout: function () { reject(new Error('请求超时')); }
          });
          return;
        } catch (e) {
          log('GM_xmlhttpRequest 调用失败，回退 fetch', e);
        }
      }
      fetch(url, { headers: headers || {}, credentials: 'omit' })
        .then(function (r) {
          if (!r.ok) {
            var e2 = new Error('HTTP ' + r.status);
            e2.status = r.status;
            throw e2;
          }
          return r.json();
        })
        .then(resolve, function (e) { reject(e && e.status ? e : new Error('网络错误（可能被 CORS 拦截，请确认油猴已授权 @connect）')); });
    });
  }

  function friendlyError(site, status) {
    if (site === 'github') {
      if (status === 403 || status === 429) return 'GitHub API 限流（未登录 60 次/小时），设置 ghToken 后刷新';
      if (status === 404) return '仓库不存在或无权限（私有仓库需 ghToken）';
    } else {
      if (status === 401 || status === 403 || status === 404) {
        return 'Gitee 拒绝匿名访问（' + status + '），需配置 giteeToken，详见使用说明';
      }
    }
    return status ? 'HTTP ' + status : null;
  }

  // 6 小时本地缓存。GitHub 未认证接口限额为每小时 60 次，用于避免频繁请求。
  function cacheGet(key) {
    try {
      var raw = localStorage.getItem('repoMeta:cache:' + key);
      if (!raw) return null;
      var box = JSON.parse(raw);
      if (!box || !box.t || Date.now() - box.t > CACHE_TTL) return null;
      return box.d;
    } catch (e) { return null; }
  }

  function cacheSet(key, data) {
    try { localStorage.setItem('repoMeta:cache:' + key, JSON.stringify({ t: Date.now(), d: data })); } catch (e) {}
  }

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (obj && obj[keys[i]] !== undefined && obj[keys[i]] !== null && obj[keys[i]] !== '') return obj[keys[i]];
    }
    return null;
  }

  /*
   * 仓库体积字段在两个平台并不统一：GitHub REST 返回 KB 整数，Gitee 的仓库接口可能缺失该字段，
   * 也可能给出带单位的字符串。此函数统一折算为 KB；无法确定时返回 null，由渲染层隐藏该行。
   */
  function parseSizeKb(raw) {
    var v = pick(raw, ['size', 'size_kb', 'repo_size', 'disk_usage', 'repository_size']);
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) && v >= 0 ? v : null;
    var m = String(v).trim().match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/i);
    if (!m) return null;
    var n = Number(m[1]);
    if (!isFinite(n) || n < 0) return null;
    var unit = (m[2] || 'kb').toLowerCase();
    var factor = { b: 1 / 1024, kb: 1, mb: 1024, gb: 1024 * 1024, tb: 1024 * 1024 * 1024 };
    return n * (factor[unit] || 1);
  }

  // 将 GitHub 与 Gitee 的字段名归一为统一结构；pushed_at 缺失时以 updated_at 代替。
  function normalize(info, raw) {
    return {
      createdAt: pick(raw, ['created_at', 'createdAt', 'create_at']),
      updatedAt: pick(raw, ['updated_at', 'updatedAt', 'last_modified_at']),
      pushedAt: pick(raw, ['pushed_at', 'pushedAt', 'last_push_at', 'last_push']) || pick(raw, ['updated_at', 'updatedAt']),
      sizeKb: parseSizeKb(raw),
      site: info.site
    };
  }

  function fetchMeta(info) {
    var cached = cacheGet(info.key);
    if (cached) {
      log('缓存命中', info.key);
      return Promise.resolve(cached);
    }
    var url, headers;
    if (info.site === 'github') {
      url = 'https://api.github.com/repos/' + encodeURIComponent(info.owner) + '/' + encodeURIComponent(info.repo);
      headers = { Accept: 'application/vnd.github+json' };
      var tk = lsGet(TOKEN_KEY);
      if (tk) headers.Authorization = 'Bearer ' + tk;
    } else {
      url = 'https://gitee.com/api/v5/repos/' + encodeURIComponent(info.owner) + '/' + encodeURIComponent(info.repo);
      var gt = lsGet(GITEE_TOKEN_KEY);
      // 调试时也可直接写死令牌；正式使用请通过 localStorage 设置，避免令牌随脚本一并公开
      // var gt = '<在此填写 Gitee 私人令牌>';
      if (gt) url += '?access_token=' + encodeURIComponent(gt);
      headers = { Accept: 'application/json' };
    }
    return httpJson(url, headers).then(function (raw) {
      var data = normalize(info, raw || {});
      if (!data.createdAt && !data.updatedAt) throw new Error('接口未返回时间字段');
      cacheSet(info.key, data);
      return data;
    }, function (err) {
      throw new Error(friendlyError(info.site, err && err.status) || (err && err.message) || '请求失败');
    });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtIso(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }

  function monthsBetween(from, to) {
    var months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    if (to.getDate() < from.getDate()) months -= 1;
    return months;
  }

  function ageText(iso) {
    if (!iso) return '—';
    var then = new Date(iso);
    if (isNaN(then.getTime())) return '—';
    var now = new Date();
    var months = monthsBetween(then, now);
    if (months < 1) return Math.max(0, Math.floor((now - then) / 86400000)) + ' 天';
    var y = Math.floor(months / 12);
    var m = months % 12;
    var out = '';
    if (y) out += y + ' 年';
    if (m) out += (out ? ' ' : '') + m + ' 个月';
    return out || '不到 1 个月';
  }

  function relText(iso) {
    if (!iso) return '';
    var then = new Date(iso);
    if (isNaN(then.getTime())) return '';
    var sec = Math.max(0, Math.floor((Date.now() - then.getTime()) / 1000));
    if (sec < 60) return '刚刚';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + ' 分钟前';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    var day = Math.floor(hr / 24);
    if (day < 30) return day + ' 天前';
    var mon = Math.floor(day / 30);
    if (mon < 12) return mon + ' 个月前';
    return Math.floor(day / 365) + ' 年前';
  }

  function activity(pushedAt) {
    if (!pushedAt) return { label: '—', rel: '' };
    var then = new Date(pushedAt);
    if (isNaN(then.getTime())) return { label: '—', rel: '' };
    var days = (Date.now() - then.getTime()) / 86400000;
    var label;
    if (days <= 7) label = '活跃';
    else if (days <= 30) label = '较活跃';
    else if (days <= 180) label = '一般';
    else if (days <= 365) label = '冷淡';
    else label = '沉寂';
    return { label: label, rel: relText(pushedAt) };
  }

  function fmtSize(kb) {
    if (kb === null || kb === undefined) return '—';
    if (kb < 1024) return Math.round(kb) + ' KB';
    var mb = kb / 1024;
    if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
  }

  function injectStyle() {
    if (document.getElementById('repo-meta-style')) return;
    var css = ''
      + '#repo-meta-board{box-sizing:border-box;position:relative;margin-top:12px;padding:8px 10px;border:1px solid var(--rm-border,#d0d7de);border-radius:6px;font-size:12px;line-height:1.7;color:var(--rm-fg,#1f2328);background:var(--rm-bg,transparent)}'
      + '#repo-meta-board .rm-head{display:flex;align-items:center;justify-content:space-between;gap:6px}'
      + '#repo-meta-board .rm-title{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--rm-dim,#57606a);text-transform:uppercase;user-select:none}'
      + '#repo-meta-board .rm-tools{display:flex;gap:2px}'
      + '#repo-meta-board .rm-btn{cursor:pointer;border:0;background:none;color:var(--rm-dim,#57606a);font-size:13px;line-height:1;padding:2px 4px;border-radius:4px}'
      + '#repo-meta-board .rm-btn:hover{background:var(--rm-hover,rgba(127,127,127,.18))}'
      + '#repo-meta-board .rm-row{display:flex;gap:8px;justify-content:space-between;align-items:baseline}'
      + '#repo-meta-board .rm-k{color:var(--rm-dim,#57606a);white-space:nowrap}'
      + '#repo-meta-board .rm-v{font-variant-numeric:tabular-nums;text-align:right;word-break:break-all}'
      + '#repo-meta-board .rm-v b{font-weight:600}'
      + '#repo-meta-board .rm-sub{font-style:normal;color:var(--rm-dim,#57606a);margin-left:6px;font-size:11px}'
      + '#repo-meta-board .rm-note{margin-top:6px;padding-top:6px;border-top:1px dashed var(--rm-border,#d0d7de);color:var(--rm-dim,#57606a);font-size:11px;line-height:1.5}'
      + '#repo-meta-board .rm-err{color:var(--rm-warn,#bc4c00)}'
      + '#repo-meta-board .rm-loading{opacity:.6}'
      + '#repo-meta-board.rm-collapsed .rm-body{display:none}'
      + '#repo-meta-board.rm-floating{position:fixed;right:16px;top:96px;z-index:2147483000;width:280px;margin-top:0;background:var(--rm-card,#fff);box-shadow:0 8px 24px rgba(0,0,0,.18);border-radius:8px}'
      + '#repo-meta-board.rm-floating .rm-head{cursor:move}'
      + '.rm-menu-fixed{position:fixed;z-index:2147483001;display:flex;flex-direction:column;min-width:200px;max-width:300px;box-sizing:border-box;padding:4px;border:1px solid var(--rm-border,#d0d7de);border-radius:6px;background:var(--rm-card,#fff);color:var(--rm-fg,#1f2328);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;font-family:inherit}'
      + '.rm-menu-fixed button{cursor:pointer;border:0;background:none;color:inherit;text-align:left;font-size:12px;padding:6px 8px;border-radius:4px}'
      + '.rm-menu-fixed button:hover{background:var(--rm-hover,rgba(127,127,127,.18))}'
      + '.rm-menu-fixed .rm-hint{padding:2px 8px 6px;font-size:11px;line-height:1.5;color:var(--rm-dim,#57606a)}'
      + '#repo-meta-board .rm-hint{padding:0 8px 6px;font-size:11px;line-height:1.5;color:var(--rm-dim,#57606a)}'
      + '@media (prefers-color-scheme:dark){#repo-meta-board,.rm-menu-fixed{--rm-border:#30363d;--rm-fg:#e6edf3;--rm-dim:#8b949e;--rm-warn:#db6d28;--rm-card:#161b22;--rm-hover:rgba(255,255,255,.10)}}';
    var el = document.createElement('style');
    el.id = 'repo-meta-style';
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  function row(k, v, sub, title) {
    return '<div class="rm-row"><span class="rm-k">' + k + '</span><span class="rm-v"' + (title ? ' title="' + title + '"' : '') + '>' + v + (sub ? '<i class="rm-sub">' + sub + '</i>' : '') + '</span></div>';
  }

  var NOTE = '「最后更新」含 Issue / PR / Release / 仓库设置等变动，不一定有新代码；看代码请用「最后推送」。';

  function buildBoard(isFloat) {
    var box = document.createElement('div');
    box.id = BOARD_ID;
    if (isFloat) box.classList.add('rm-floating');
    var s = loadSettings();
    if (isFloat && s.collapsed) box.classList.add('rm-collapsed');
    box.innerHTML = '<div class="rm-head">'
      + '<div class="rm-title">Quick Metadata</div>'
      + '<div class="rm-tools">'
      + '<button class="rm-btn" data-act="settings" title="设置">&#9881;</button>'
      + (isFloat
        ? '<button class="rm-btn" data-act="collapse" title="收起 / 展开">&minus;</button>'
          + '<button class="rm-btn" data-act="close" title="关闭">&#215;</button>'
        : '')
      + '</div>'
      + '</div>'
      + '<div class="rm-body rm-loading">读取中…</div>';
    return box;
  }

  function paint(box, data) {
    var body = box.querySelector('.rm-body');
    if (!body) return;
    var act = activity(data.pushedAt);
    body.classList.remove('rm-loading');
    var rows = ''
      + row('创建时间', fmtDate(data.createdAt), '', 'created_at — 仓库创建时间')
      + row('最后推送', fmtDate(data.pushedAt), relText(data.pushedAt), 'pushed_at — 代码最后一次 push')
      + row('最后更新', fmtDate(data.updatedAt), relText(data.updatedAt), 'updated_at — 仓库信息最后变更（含 Issue/PR/Release 等）')
      + row('项目年龄', ageText(data.createdAt), '', '从创建时间算起')
      + row('代码活跃度', '<b>' + act.label + '</b>', act.rel, '按最后一次代码 push 判定');
    // 体积字段并非两个平台都提供；取不到时隐藏该行，避免显示无意义的占位符
    if (data.sizeKb !== null && data.sizeKb !== undefined) {
      rows += row('仓库大小', fmtSize(data.sizeKb), '', '仓库体积');
    }
    body.innerHTML = rows + '<div class="rm-note">' + NOTE + '</div>';
  }

  function fail(box, err) {
    var body = box.querySelector('.rm-body');
    if (!body) return;
    body.classList.remove('rm-loading');
    body.innerHTML = '<span class="rm-err">获取失败：' + String(err && err.message ? err.message : err) + '</span>';
  }

  // 判断依据：GitHub 页面中存在多个 "About" 节点（含水合过程产生的隐藏副本），
  // 仅判断元素是否存在会把卡片插入宽高为 0 的节点，导致内容不可见。
  function visible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    var r = el.getBoundingClientRect();
    return !!r && r.width > 0 && r.height > 0;
  }

  function inRightHalf(el) {
    try {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.left > window.innerWidth * 0.45;
    } catch (e) { return false; }
  }

  function candidates(sel, re) {
    var list = Array.prototype.slice.call(document.querySelectorAll(sel));
    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (!visible(list[i])) continue;
      if (re.test((list[i].textContent || '').trim())) found = list[i];
    }
    return found;
  }

  function findByText(needles, tags) {
    var list = document.querySelectorAll(tags || 'h1,h2,h3,h4,div,span,a,strong');
    for (var i = 0; i < list.length; i++) {
      var t = (list[i].textContent || '').trim();
      if (t.length > 24) continue;
      for (var j = 0; j < needles.length; j++) {
        if (t !== needles[j] && t.toLowerCase() !== needles[j].toLowerCase()) continue;
        if (!visible(list[i]) || !inRightHalf(list[i])) continue;
        // 向上取「整段内容即为该文本」的最外层节点。否则插入到内层 span / h3 之前时，
        // 卡片会落在「发行版」区块内部，而非其上方
        var node = list[i];
        var up = node.parentElement;
        for (var k = 0; k < 6 && up && up !== document.body; k++) {
          if ((up.textContent || '').trim() !== t) break;
          node = up;
          up = node.parentElement;
        }
        return node;
      }
    }
    return null;
  }

  function findAnchorNode() {
    var stats = document.querySelectorAll('a, span, div, li');
    for (var i = 0; i < stats.length; i++) {
      var t = (stats[i].textContent || '').trim();
      if (t.length > 40) continue;
      if (/watching|fork|star|关注|收藏|星标/i.test(t) && /\d/.test(t) && visible(stats[i]) && inRightHalf(stats[i])) {
        var node = stats[i];
        for (var up = 0; up < 5 && node.parentElement; up++) {
          var p = node.parentElement;
          if ((p.textContent || '').length > t.length + 8) return p;
          node = p;
        }
        return stats[i].parentElement || stats[i];
      }
    }
    return null;
  }

  /*
   * 插入位置以「动作」描述，而非直接给出容器：
   *   { mode: 'append', el }  作为 el 的最后一个子节点插入
   *   { mode: 'before', el }  插入到 el 之前（同级）
   *   { mode: 'after',  el }  插入到 el 之后（同级）
   * GitHub：取 "Report repository" 所在单元格，其次取 h2 "About" 所在单元格；
   * Gitee：插入到「发行版」标题之前，使卡片紧随「简介」卡片；
   * 含 Watching / Fork / Star 的统计块作为后备锚点，仅在仓库首页启用。
   */
  function getInsertSpot(site) {
    if (site === 'github') {
      var report = candidates('a, button', /^report repository$/i);
      if (report) return { mode: 'append', el: report.closest('.BorderGrid-cell') || report.parentElement };
      var heads = Array.prototype.slice.call(document.querySelectorAll('h2'))
        .filter(function (h) { return /^about$/i.test((h.textContent || '').trim()) && visible(h); });
      if (heads.length) {
        var h = heads[heads.length - 1];
        return { mode: 'append', el: h.closest('.BorderGrid-cell') || h.parentElement };
      }
      if (!isRepoHome()) return null;
      var ghStats = findAnchorNode();
      if (ghStats) return { mode: 'append', el: ghStats.closest('.BorderGrid-cell') || ghStats.parentElement || ghStats };
      return null;
    }

    // Gitee 首选位置：紧随「简介」卡片，位于「发行版」之前。
    var releases = findByText(['发行版', 'Releases']);
    if (releases && releases.parentElement) return { mode: 'before', el: releases };
    // 无发行版区块时，退到含 Stars / Watching / Forks 的统计块之后。
    var stats = findAnchorNode();
    if (stats && stats.parentElement) return { mode: 'after', el: stats };
    // 最后回退为插入「简介」面板内部。
    var title = findByText(['简介', 'About']);
    if (title && title.parentElement) return { mode: 'append', el: title.parentElement };
    return null;
  }

  /*
   * 同级插入（Gitee）时的垂直间距：
   * 参照元素自带 margin-bottom，而卡片默认带有 margin-top: 12px，两者叠加会使上方间距过大，
   * 下方则没有任何外边距。此处清除自身 margin-top，并将 margin-bottom 对齐参照元素的
   * margin-bottom，使上下间距保持一致。
   */
  function applySiblingSpacing(box, spot) {
    if (!spot || spot.mode !== 'before') return;
    var gap = 16;
    try {
      var ref = spot.el.previousElementSibling;
      if (ref && window.getComputedStyle) {
        var mb = parseFloat(window.getComputedStyle(ref).marginBottom);
        if (isFinite(mb) && mb > 0) gap = Math.round(mb);
      }
    } catch (e) {}
    if (box.style) {
      box.style.marginTop = '0px';
      box.style.marginBottom = gap + 'px';
    }
  }

  function placeBoard(box, spot) {
    if (!spot || !spot.el) return false;
    var mode = spot.mode;
    var el = spot.el;
    if (mode === 'append') {
      if (!el.appendChild) return false;
      el.appendChild(box);
      return true;
    }
    var parent = el.parentElement;
    if (!parent || !parent.insertBefore) return false;
    if (mode === 'before') {
      parent.insertBefore(box, el);
      return true;
    }
    parent.insertBefore(box, el.nextSibling || null);
    return true;
  }

  var inflight = {};
  var currentKey = null;
  var firstSeen = {};
  var closedSession = {};
  var memData = {};
  var loggedInject = {};

  // 悬浮面板的显示条件，依次为：用户总开关、24 小时临时静音、当前仓库在本次会话中被关闭。
  function floatAllowed(info) {
    var s = loadSettings();
    if (!s.float) return false;
    if (s.muteUntil && Date.now() < s.muteUntil) return false;
    if (closedSession[info.key]) return false;
    return true;
  }

  function placeFloating(box) {
    var s = loadSettings();
    if (s.left !== null && s.top !== null) {
      box.style.left = s.left + 'px';
      box.style.top = s.top + 'px';
      box.style.right = 'auto';
    }
  }

  // 拖动仅响应标题栏（在按钮上按下不触发），位置限制在视口内，松开时写入设置。
  function makeDraggable(box) {
    var head = box.querySelector('.rm-head');
    if (!head || !head.addEventListener) return;
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

    head.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      var r = box.getBoundingClientRect();
      dragging = true;
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      box.style.left = ox + 'px';
      box.style.top = oy + 'px';
      box.style.right = 'auto';
      if (head.setPointerCapture) { try { head.setPointerCapture(e.pointerId); } catch (err) {} }
      if (e.preventDefault) e.preventDefault();
    });

    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var nx = ox + (e.clientX - sx);
      var ny = oy + (e.clientY - sy);
      nx = Math.max(4, Math.min(window.innerWidth - 80, nx));
      ny = Math.max(4, Math.min(window.innerHeight - 40, ny));
      box.style.left = nx + 'px';
      box.style.top = ny + 'px';
    });

    head.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      // 显式释放指针捕获。否则后续 click 的 target 会被改写为标题栏，导致按钮无法响应。
      if (head.releasePointerCapture && e && e.pointerId !== undefined) {
        try { head.releasePointerCapture(e.pointerId); } catch (err) {}
      }
      var r = box.getBoundingClientRect();
      saveSettings({ left: r.left, top: r.top });
    });
  }

  /*
   * 设置 / 关闭菜单统一挂载到 document.body，并以 position: fixed 定位在触发按钮下方。
   * 早期实现将菜单作为面板内的绝对定位子元素，会受面板层叠上下文与拖动时的指针捕获影响，
   * 出现无法响应或无法显示的问题；挂载到 body 后与面板解耦，不受父级裁剪影响。
   */
  var activeMenu = null;

  function closeActiveMenu() {
    if (activeMenu && activeMenu.el && activeMenu.el.remove) activeMenu.el.remove();
    activeMenu = null;
  }

  function menuHtml(kind) {
    if (kind === 'close') {
      return '<button data-act="close-session">只关这一次（刷新后恢复）</button>'
        + '<button data-act="close-24h">24 小时内不再显示</button>'
        + '<button data-act="close-float">关闭悬浮面板（在设置里可重开）</button>';
    }
    var s = loadSettings();
    // 只暴露一个开关：实际状态仅为开 / 关两种，避免引入「静音」这一中间状态。
    var html = '<button data-act="toggle-float">悬浮面板：<b>' + (s.float ? '开' : '关') + '</b>（点击切换）</button>'
      + '<div class="rm-hint">仓库首页始终用侧栏卡片；子页面才用悬浮面板</div>';
    // 处于 24 小时静音期间时补充说明，指明开关为开但面板未显示的原因。
    if (s.float && s.muteUntil && Date.now() < s.muteUntil) {
      html += '<div class="rm-hint">24 小时内暂停显示中，点上方开关可立即恢复</div>';
    }
    return html;
  }

  function openMenu(kind, anchor, box, info) {
    // 再次点击同一按钮时收起菜单。
    if (activeMenu && activeMenu.kind === kind && activeMenu.anchor === anchor) {
      closeActiveMenu();
      return;
    }
    closeActiveMenu();
    var menu = document.createElement('div');
    menu.className = 'rm-menu rm-menu-fixed';
    menu.setAttribute('data-kind', kind);
    menu.innerHTML = menuHtml(kind);
    document.body.appendChild(menu);

    // 定位在按钮下沿，右对齐并限制在视口内。
    var r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    if (r && menu.style) {
      var width = 210;
      menu.style.position = 'fixed';
      menu.style.top = Math.round(r.bottom + 4) + 'px';
      menu.style.left = Math.round(Math.max(4, Math.min(window.innerWidth - width - 8, r.right - width))) + 'px';
    }

    activeMenu = { el: menu, kind: kind, anchor: anchor };

    // 菜单项直接绑定事件：菜单不在面板内，无法依赖面板的事件委托。
    var items = menu.querySelectorAll ? menu.querySelectorAll('button[data-act]') : [];
    for (var i = 0; i < items.length; i++) {
      (function (btn) {
        if (!btn.addEventListener) return;
        btn.addEventListener('click', function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          var act = btn.getAttribute('data-act');
          closeActiveMenu();
          runAction(act, box, info);
        });
      })(items[i]);
    }
  }

  // 面板内按钮的动作分发：⚙ 与 × 打开菜单，其余动作直接执行。
  function runAction(act, box, info) {
    var b = box || document.getElementById(BOARD_ID);
    if (act === 'collapse') {
      if (!b) return;
      var nowCollapsed = !b.classList.contains('rm-collapsed');
      b.classList[nowCollapsed ? 'add' : 'remove']('rm-collapsed');
      saveSettings({ collapsed: nowCollapsed });
      return;
    }
    // 仅本次关闭：当前会话内不再为该仓库显示，刷新页面后恢复。
    if (act === 'close-session') { closedSession[info.key] = true; if (b) b.remove(); return; }
    // 24 小时静音：临时状态，不修改用户偏好。
    if (act === 'close-24h') { saveSettings({ muteUntil: Date.now() + 86400000 }); if (b) b.remove(); return; }
    // 关闭悬浮面板：直接写入用户偏好，设置菜单中的开关随之显示为「关」。
    if (act === 'close-float') { saveSettings({ float: false }); if (b) b.remove(); return; }
    // 切换总开关，同时清除 24 小时静音，避免出现开关为开但面板不显示的情况。
    if (act === 'toggle-float') {
      var on = loadSettings().float;
      saveSettings({ float: !on, muteUntil: 0 });
      refreshAfterSettingChange();
      return;
    }
  }

  function bindBoard(box, info, isFloat) {
    if (isFloat) makeDraggable(box);
    var onClick = function (e) {
      if (!e || e.__rmHandled) return;   // 直绑已处理过就别重复执行
      var t = e.target;
      if (!t || !t.closest) return;
      var hit = t.closest('[data-act]');
      if (!hit) return;
      e.__rmHandled = true;
      var act = hit.getAttribute('data-act');
      if (act === 'settings' || act === 'close') return openMenu(act, hit, box, info);
      runAction(act, box, info);
    };
    if (box.addEventListener) box.addEventListener('click', onClick);
    /*
     * 按钮额外直接绑定一次事件：拖动时标题栏调用了 setPointerCapture，
     * 部分情况下 click 的 target 会被改写为标题栏，事件无法冒泡到面板的委托处理，
     * 因此在按钮上直接绑定，以覆盖该场景。
     */
    var btns = box.querySelectorAll ? box.querySelectorAll('.rm-btn[data-act]') : [];
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].addEventListener) btns[i].addEventListener('click', onClick);
    }
  }

  // 侧栏无法插入或插入后不可见时的回退方案：改为可拖动的悬浮面板。
  function floatize(box, info) {
    closeActiveMenu();
    if (box && box.remove) box.remove();
    injectStyle();
    var f = buildBoard(true);
    document.body.appendChild(f);
    placeFloating(f);
    bindBoard(f, info, true);
    log('改用悬浮面板', info.key);
    hydrate(info);
  }

  // 渲染后自检：宽高仍为 0 说明插入到了隐藏节点，立即转为悬浮面板。
  function ensureVisible(box, info) {
    setTimeout(function () {
      if (box !== document.getElementById(BOARD_ID)) return;
      var r = box.getBoundingClientRect();
      if (r && r.width > 0 && r.height >= 8) return;
      floatize(box, info);
    }, 300);
  }

  // 获取数据并渲染；命中内存缓存时直接重绘，避免 GitHub 重渲染后再次显示「读取中」。
  function hydrate(info) {
    if (memData[info.key]) {
      var warm = document.getElementById(BOARD_ID);
      if (warm) {
        paint(warm, memData[info.key]);
        ensureVisible(warm, info);
      }
      return;
    }
    if (inflight[info.key]) return;
    inflight[info.key] = true;
    fetchMeta(info).then(function (data) {
      inflight[info.key] = false;
      memData[info.key] = data;
      var box = document.getElementById(BOARD_ID);
      if (!box) return;
      paint(box, data);
      ensureVisible(box, info);
    }, function (err) {
      inflight[info.key] = false;
      var box = document.getElementById(BOARD_ID);
      if (!box) return;
      log('请求失败', info.key, err);
      fail(box, err);
      ensureVisible(box, info);
    });
  }

  /*
   * 幂等注入：任何 DOM 变动都会进入此函数，若卡片已存在则直接返回。
   * 因此 GitHub 水合移除卡片后会自动重新插入，且不会产生重复节点。
   */
  function tick() {
    var info = parseRepo();
    if (!info) return;
    if (info.key !== currentKey) {
      currentKey = info.key;
      closeActiveMenu();
      var stale = document.getElementById(BOARD_ID);
      if (stale) stale.remove();
    }
    if (document.getElementById(BOARD_ID)) return;

    var spot = getInsertSpot(info.site);
    if (spot) {
      injectStyle();
      var box = buildBoard(false);
      applySiblingSpacing(box, spot);
      if (placeBoard(box, spot)) {
        bindBoard(box, info, false);
        if (!loggedInject[info.key]) {
          loggedInject[info.key] = true;
          log('已注入侧栏', info.site, info.key, '方式=' + spot.mode + ' 锚点=' + (spot.el.className || spot.el.tagName));
        }
        hydrate(info);
        return;
      }
    }

    if (!floatAllowed(info)) return;
    if (!firstSeen[info.key]) firstSeen[info.key] = Date.now();
    var wait = 800 - (Date.now() - firstSeen[info.key]);
    if (wait <= 0) {
      floatize(null, info);
      return;
    }
    setTimeout(schedule, wait + 50);
  }

  function refreshAfterSettingChange() {
    closeActiveMenu();
    var b = document.getElementById(BOARD_ID);
    if (b) b.remove();
    currentKey = null;
    schedule();
  }

  function registerMenu() {
    var fn = null;
    if (typeof GM_registerMenuCommand === 'function') fn = GM_registerMenuCommand;
    else if (typeof GM !== 'undefined' && GM && typeof GM.registerMenuCommand === 'function') fn = GM.registerMenuCommand.bind(GM);
    if (!fn) return;
    try {
      fn('Repo Meta：开启 / 关闭悬浮面板', function () {
        var s = loadSettings();
        saveSettings({ float: !s.float, muteUntil: 0 });
        refreshAfterSettingChange();
      });
      fn('Repo Meta：恢复默认设置', function () {
        saveSettings({ float: false, collapsed: false, muteUntil: 0 });
        refreshAfterSettingChange();
      });
    } catch (e) { log('注册油猴菜单失败', e); }
  }

  window.repoMetaSettings = function (patch) {
    if (patch === undefined) {
      var cur = loadSettings();
      console.log('[repo-meta] settings', cur);
      return cur;
    }
    saveSettings(patch);
    refreshAfterSettingChange();
    var next = loadSettings();
    console.log('[repo-meta] 设置已更新', next);
    return next;
  };

  var timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      try { tick(); } catch (e) { log('tick 异常', e); }
    }, 300);
  }

  ['turbo:load', 'pjax:end', 'DOMContentLoaded'].forEach(function (ev) {
    document.addEventListener(ev, schedule, true);
  });
  window.addEventListener('popstate', schedule);

  try {
    var wrap = function (name) {
      var orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function () {
        var ret = orig.apply(this, arguments);
        schedule();
        return ret;
      };
    };
    wrap('pushState');
    wrap('replaceState');
  } catch (e) {}

  window.repoMetaDoctor = function () {
    var info = parseRepo();
    var box = document.getElementById(BOARD_ID);
    var spot = info ? getInsertSpot(info.site) : null;
    var target = spot ? spot.el : null;
    var s = loadSettings();
    var report = {
      url: location.href,
      repoHome: isRepoHome(),
      parsed: info,
      settings: s,
      muted: !!(s.muteUntil && Date.now() < s.muteUntil),
      boardPresent: !!box,
      boardVisible: box ? visible(box) : false,
      floating: box ? String(box.className || '').indexOf('rm-floating') !== -1 : false,
      anchorMode: spot ? spot.mode : null,
      anchorTag: target ? target.tagName : null,
      anchorClass: target ? String(target.className || '') : null,
      anchorVisible: target ? visible(target) : false,
      cache: info ? cacheGet(info.key) : null,
      ghToken: !!lsGet(TOKEN_KEY),
      giteeToken: !!lsGet(GITEE_TOKEN_KEY)
    };
    console.log('[repo-meta] doctor', report);
    return report;
  };

  // 菜单不会自己消失：菜单与触发按钮之外的任何一次点击都把它收起
  function bindOutsideClose() {
    document.addEventListener('click', function (e) {
      if (!activeMenu) return;
      var t = e.target;
      var el = activeMenu.el;
      var anchor = activeMenu.anchor;
      if (el && el.contains && el.contains(t)) return;
      // 触发按钮自己的点击留给 toggle 处理，避免"刚打开就被收起"
      if (anchor && anchor.contains && anchor.contains(t)) return;
      closeActiveMenu();
    }, true);
  }

  registerMenu();
  bindOutsideClose();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();

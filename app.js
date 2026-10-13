/* 本机计算器 · 全部逻辑（单文件，无构建、无依赖、不使用 ES 模块）
 *
 * 区块划分
 *   §1  常量配置      §2  工具函数       §3  存储层 Store
 *   §4  状态与路由    §5  计算引擎       §6  换算引擎      §7  日期引擎
 *   §8  计算视图      §9  换算视图       §10 日期视图      §11 历史视图
 *   §12 设置与备份    §13 初始化         §14 对外导出
 */
(function () {
  'use strict';

  /* ==================== §1 常量配置 ==================== */

  const APP_VERSION = 1;

  const STORE_KEYS = {
    settings: 'calcapp.settings.v1',
    history: 'calcapp.history.v1'
  };

  const VIEWS = ['calc', 'convert', 'date', 'history'];

  const DEFAULT_SETTINGS = {
    version: APP_VERSION,
    lastView: 'calc',
    historyLimit: 500,
    thousandSeparator: true,
    lastConvertCategory: 'length',
    lastUnits: {},
    lastDates: {}
  };

  const TYPE_LABEL = { calc: '计算', convert: '换算', date: '日期' };

  const MSG = {
    storageFailed: '记录保存失败，请检查浏览器设置',
    divZero: '无法除以零',
    emptyHistory: '还没有记录。算点什么，这里会自动留下痕迹。',
    noMatch: '没有找到匹配的记录。',
    importBad: '文件格式不正确，未导入任何数据',
    importVersion: '备份文件版本不兼容，未导入任何数据',
    clearConfirm: '确定清空全部 {n} 条记录？此操作无法撤销。',
    importConfirm: '导入将覆盖当前全部记录，确定继续？',
    importDone: '已恢复 {n} 条记录',
    importSkipped: '（已跳过 {n} 条无效记录）',
    exportDone: '备份文件已生成',
    limitInvalid: '历史上限需为 1 到 5000 之间的整数'
  };

  const NOTICE_MS = 4000;
  const DEBOUNCE_MS = 800;

  const LocalCalc = {};

  /* ==================== §2 工具函数 ==================== */

  function pad2(n) { return String(n).padStart(2, '0'); }

  function todayStr(d) {
    const t = d || new Date();
    return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
  }

  function formatStamp(ts) {
    const d = new Date(ts);
    const now = new Date();
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (sameDay(d, now)) return '今天 ' + hm;
    if (sameDay(d, new Date(now.getTime() - 86400000))) return '昨天 ' + hm;
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments, self = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; fn.apply(self, args); }, wait);
    };
  }

  /* ==================== §3 存储层 ==================== */

  const Store = {
    available: true,
    failedOnce: false,
    _lastDedupeKey: null,

    _ls() {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return null;
        return localStorage;
      } catch (e) {
        return null;
      }
    },

    _read(key, fallback) {
      const ls = this._ls();
      if (!ls) { this._fail(); return fallback; }
      try {
        const raw = ls.getItem(key);
        if (raw === null || raw === undefined || raw === '') return fallback;
        const val = JSON.parse(raw);
        return (val === null || val === undefined) ? fallback : val;
      } catch (e) {
        return fallback;
      }
    },

    _write(key, value) {
      const ls = this._ls();
      if (!ls) { this._fail(); return false; }
      try {
        ls.setItem(key, JSON.stringify(value));
        this.available = true;
        return true;
      } catch (e) {
        this._fail();
        return false;
      }
    },

    _fail() {
      this.available = false;
      if (!this.failedOnce) {
        this.failedOnce = true;
        if (typeof onStoreFailed === 'function') onStoreFailed();
      }
    },

    loadSettings() {
      const raw = this._read(STORE_KEYS.settings, null);
      const out = {};
      for (const k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k];
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const k in DEFAULT_SETTINGS) {
          if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
          const dv = DEFAULT_SETTINGS[k];
          const rv = raw[k];
          if (dv !== null && typeof dv === 'object') {
            if (rv && typeof rv === 'object' && !Array.isArray(rv)) out[k] = rv;
          } else if (typeof rv === typeof dv) {
            out[k] = rv;
          }
        }
      }
      out.version = APP_VERSION;
      if (VIEWS.indexOf(out.lastView) < 0) out.lastView = 'calc';
      if (['length', 'weight', 'temperature', 'area', 'volume'].indexOf(out.lastConvertCategory) < 0) {
        out.lastConvertCategory = 'length';
      }
      out.thousandSeparator = out.thousandSeparator !== false;
      const lim = Number(out.historyLimit);
      out.historyLimit = (isFinite(lim) && lim >= 1) ? Math.min(Math.floor(lim), 5000) : DEFAULT_SETTINGS.historyLimit;
      return out;
    },

    saveSettings(patch) {
      const next = Object.assign(this.loadSettings(), patch || {});
      this._write(STORE_KEYS.settings, next);
      return next;
    },

    loadHistory() {
      const raw = this._read(STORE_KEYS.history, []);
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (r) {
        return r && typeof r === 'object' && !Array.isArray(r) &&
          typeof r.id === 'string' && TYPE_LABEL[r.type] &&
          typeof r.title === 'string' && typeof r.result === 'string' &&
          isFinite(Number(r.createdAt));
      }).map(function (r) {
        return {
          id: r.id,
          type: r.type,
          title: r.title,
          result: r.result,
          detail: (r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail)) ? r.detail : {},
          createdAt: Number(r.createdAt)
        };
      });
    },

    saveHistory(items) {
      this._write(STORE_KEYS.history, items || []);
      return items || [];
    },

    addRecord(type, title, result, detail, dedupeKey) {
      if (!TYPE_LABEL[type]) return null;
      if (dedupeKey && this._lastDedupeKey === dedupeKey) return null;
      const items = this.loadHistory();
      const now = Date.now();
      const rec = {
        id: now + '-' + Math.random().toString(36).slice(2, 7),
        type: type,
        title: String(title),
        result: String(result),
        detail: detail || {},
        createdAt: now
      };
      items.unshift(rec);
      const limit = this.loadSettings().historyLimit;
      if (items.length > limit) items.length = limit;
      this.saveHistory(items);
      this._lastDedupeKey = dedupeKey || null;
      return rec;
    },

    deleteRecord(id) {
      const items = this.loadHistory().filter(function (r) { return r.id !== id; });
      this.saveHistory(items);
      return items;
    },

    clearHistory() {
      this._lastDedupeKey = null;
      this.saveHistory([]);
      return [];
    },

    count() { return this.loadHistory().length; },

    exportPayload() {
      return {
        app: 'local-calculator',
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
        settings: this.loadSettings(),
        history: this.loadHistory()
      };
    },

    exportFileName() {
      return 'calculator-backup-' + todayStr() + '.json';
    },

    validateImport(raw) {
      let data = raw;
      if (typeof raw === 'string') {
        try { data = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'format' }; }
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'format' };
      if (Number(data.version) !== APP_VERSION) return { ok: false, reason: 'version' };
      if (!Array.isArray(data.history)) return { ok: false, reason: 'format' };
      const good = [];
      let skipped = 0;
      for (let i = 0; i < data.history.length; i++) {
        const r = data.history[i];
        if (r && typeof r === 'object' && !Array.isArray(r) &&
            typeof r.id === 'string' && TYPE_LABEL[r.type] &&
            typeof r.title === 'string' && typeof r.result === 'string' &&
            isFinite(Number(r.createdAt))) {
          good.push({
            id: r.id,
            type: r.type,
            title: r.title,
            result: r.result,
            detail: (r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail)) ? r.detail : {},
            createdAt: Number(r.createdAt)
          });
        } else {
          skipped++;
        }
      }
      const settings = (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings))
        ? data.settings : null;
      return { ok: true, payload: { settings: settings, history: good }, skipped: skipped };
    },

    importPayload(payload) {
      const ls = this._ls();
      if (!ls) { this._fail(); return { ok: false, reason: 'storage' }; }
      if (payload && payload.settings) {
        const clean = {};
        for (const k in DEFAULT_SETTINGS) {
          if (Object.prototype.hasOwnProperty.call(payload.settings, k)) clean[k] = payload.settings[k];
        }
        this._write(STORE_KEYS.settings, Object.assign(this.loadSettings(), clean));
      }
      const limit = this.loadSettings().historyLimit;
      const hist = (payload && Array.isArray(payload.history)) ? payload.history.slice(0, limit) : [];
      this._write(STORE_KEYS.history, hist);
      this._lastDedupeKey = null;
      return { ok: true, count: hist.length, history: this.loadHistory() };
    }
  };

  /* ==================== §4 状态与路由 ==================== */

  const state = {
    view: 'calc',
    calc: { entries: [], current: '0', typing: false, error: null, done: false, lastExpression: '', justEvaluated: null },
    convert: { category: 'length', from: '', to: '', left: '', right: '', activeSide: 'left' },
    convertAllOpen: true,
    dates: {
      diff: { start: '', end: '' },
      shift: { start: '', dir: 1, amount: '30', unit: 'day' },
      age: { birth: '' }
    },
    history: { items: [], query: '', filter: 'all' },
    settings: Object.assign({}, DEFAULT_SETTINGS),
    dirty: {}
  };

  let noticeTimer = null;

  function showNotice(text, kind) {
    if (typeof document === 'undefined' || !document) return;
    const el = document.getElementById('notice');
    if (!el) return;
    el.textContent = text;
    el.className = 'notice' + (kind === 'info' ? ' notice-info' : '');
    el.hidden = false;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { el.hidden = true; }, NOTICE_MS);
  }

  function hideNotice() {
    if (typeof document === 'undefined' || !document) return;
    const el = document.getElementById('notice');
    if (el) el.hidden = true;
  }

  function onStoreFailed() {
    showNotice(MSG.storageFailed);
  }

  function currentViewFromDom() {
    return state.view;
  }

  function setView(name, opts) {
    if (VIEWS.indexOf(name) < 0) name = 'calc';
    state.view = name;
    if (typeof document !== 'undefined' && document) {
      for (let i = 0; i < VIEWS.length; i++) {
        const sec = document.getElementById('view-' + VIEWS[i]);
        if (sec) sec.hidden = (VIEWS[i] !== name);
      }
      const btns = document.querySelectorAll('.nav-item');
      for (let i = 0; i < btns.length; i++) {
        const on = btns[i].getAttribute('data-view') === name;
        if (on) btns[i].classList.add('active'); else btns[i].classList.remove('active');
        btns[i].setAttribute('aria-current', on ? 'page' : 'false');
      }
    }
    if (!opts || opts.persist !== false) {
      state.settings = Store.saveSettings({ lastView: name });
    }
    onEnterView(name);
    return name;
  }

  /* 视图进入钩子：各视图在自己的区块里注册刷新逻辑 */
  const enterHooks = {};

  function registerEnterHook(view, fn) {
    enterHooks[view] = fn;
  }

  function onEnterView(name) {
    if (enterHooks[name]) enterHooks[name]();
  }

  /* ==================== §5 计算引擎 ==================== */

  const OP_SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷' };
  const MAX_INPUT_DIGITS = 16;

  function createCalcState() { return calcReset({}); }

  function calcReset(cs) {
    cs.entries = [];
    cs.current = '0';
    cs.typing = false;
    cs.error = null;
    cs.done = false;
    cs.lastExpression = '';
    cs.justEvaluated = null;
    return cs;
  }

  /* --- 数字格式化 --- */

  function trimExp(s) {
    const m = String(s).match(/^(-?[\d.]+)e([+-])(\d+)$/);
    if (!m) return String(s);
    let mant = m[1];
    if (mant.indexOf('.') >= 0) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
    return mant + 'e' + m[2] + m[3];
  }

  /* 12 位有效数字裁剪，消除浮点误差；超过 14 位改用科学计数法 */
  function formatNumber(n) {
    if (typeof n !== 'number' || !isFinite(n)) return MSG.divZero;
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs >= 1e14 || abs < 1e-9) return trimExp(n.toExponential(8));
    let s = n.toPrecision(12);
    if (s.indexOf('e') >= 0) return trimExp(s);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  function addThousands(str) {
    if (!/^-?\d+(\.\d*)?$/.test(str)) return str;
    const neg = str.charAt(0) === '-';
    const body = neg ? str.slice(1) : str;
    const dot = body.indexOf('.');
    let intPart = dot >= 0 ? body.slice(0, dot) : body;
    const tail = dot >= 0 ? body.slice(dot) : '';
    if (intPart.length > 3) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + intPart + tail;
  }

  /* --- 表达式求值：两趟扫描，天然支持标准优先级，不使用 eval --- */

  function evaluateItems(items) {
    if (!items || !items.length) { const e = new Error('EMPTY'); e.code = 'EMPTY'; throw e; }
    const t = items.slice();
    let i = 1;
    while (i < t.length) {
      const op = t[i];
      if (op === '*' || op === '/') {
        const a = t[i - 1], b = t[i + 1];
        if (op === '/' && b === 0) { const e = new Error('DIV_ZERO'); e.code = 'DIV_ZERO'; throw e; }
        t.splice(i - 1, 3, op === '*' ? a * b : a / b);
      } else {
        i += 2;
      }
    }
    let acc = t[0];
    for (let j = 1; j < t.length; j += 2) acc = (t[j] === '+') ? acc + t[j + 1] : acc - t[j + 1];
    return acc;
  }

  /* --- 显示 --- */

  function calcExpressionText(cs) {
    if (cs.done) return cs.lastExpression || '';
    const parts = [];
    for (let i = 0; i < cs.entries.length; i++) {
      const t = cs.entries[i];
      parts.push(typeof t === 'number' ? formatNumber(t) : OP_SYMBOL[t]);
    }
    if (cs.typing) parts.push(cs.current);
    return parts.join(' ');
  }

  function calcDisplayText(cs, thousand) {
    if (cs.error) return cs.error;
    const raw = cs.current;
    if (thousand) return addThousands(raw);
    return raw;
  }

  /* --- 输入 --- */

  function calcDigitCount(str) {
    return str.replace('-', '').replace('.', '').length;
  }

  function calcInputDigit(cs, d) {
    if (cs.error || cs.done) calcReset(cs);
    if (!cs.typing) {
      cs.current = (d === '0') ? '0' : d;
      cs.typing = true;
      return cs;
    }
    if (cs.current === '0') {
      if (d !== '0') cs.current = d;
      return cs;
    }
    if (calcDigitCount(cs.current) >= MAX_INPUT_DIGITS) return cs;
    cs.current = cs.current + d;
    return cs;
  }

  function calcInputDot(cs) {
    if (cs.error || cs.done) calcReset(cs);
    if (!cs.typing) { cs.current = '0.'; cs.typing = true; return cs; }
    if (cs.current.indexOf('.') < 0) cs.current = cs.current + '.';
    return cs;
  }

  function calcBackspace(cs) {
    if (cs.error) { calcReset(cs); return cs; }
    if (cs.done) return cs;
    if (cs.typing) {
      const s = cs.current.slice(0, -1);
      if (s === '' || s === '-') { cs.current = '0'; cs.typing = false; }
      else cs.current = s;
      return cs;
    }
    const last = cs.entries.length ? cs.entries[cs.entries.length - 1] : null;
    if (typeof last === 'string') {
      cs.entries.pop();
      const num = cs.entries.pop();
      if (typeof num === 'number') { cs.current = formatNumber(num); cs.typing = true; }
    }
    return cs;
  }

  function calcToggleSign(cs) {
    if (cs.error) calcReset(cs);
    if (cs.done) {
      const v = parseFloat(cs.current);
      cs.current = isFinite(v) ? formatNumber(-v) : cs.current;
      cs.done = false;
      cs.lastExpression = '';
      cs.typing = true;
      return cs;
    }
    const v = parseFloat(cs.current);
    if (!isFinite(v) || v === 0) return cs;
    cs.current = (cs.current.charAt(0) === '-') ? cs.current.slice(1) : '-' + cs.current;
    cs.typing = true;
    return cs;
  }

  function calcOperator(cs, op) {
    if (cs.error) return cs;
    if (cs.done) {
      cs.entries = [parseFloat(cs.current), op];
      cs.current = '0';
      cs.typing = false;
      cs.done = false;
      cs.lastExpression = '';
      return cs;
    }
    if (cs.typing) {
      cs.entries.push(parseFloat(cs.current));
      cs.current = '0';
      cs.typing = false;
    }
    if (!cs.entries.length) return cs;
    const last = cs.entries[cs.entries.length - 1];
    if (typeof last === 'string') cs.entries[cs.entries.length - 1] = op;
    else cs.entries.push(op);
    return cs;
  }

  /* 百分号：加减法按「左值的百分之几」处理，乘除法按「除以 100」处理 */
  function calcPercent(cs) {
    if (cs.error) return cs;
    if (cs.done) {
      const v = parseFloat(cs.current);
      if (isFinite(v)) { cs.current = formatNumber(v / 100); cs.typing = true; cs.done = false; cs.lastExpression = ''; }
      return cs;
    }
    if (!cs.typing) return cs;
    const base = parseFloat(cs.current);
    if (!isFinite(base)) return cs;
    const last = cs.entries.length ? cs.entries[cs.entries.length - 1] : null;
    let val = base / 100;
    if (last === '+' || last === '-') {
      let left = 0;
      try { left = evaluateItems(cs.entries.slice(0, -1)); } catch (e) { left = 0; }
      val = left * base / 100;
    }
    cs.current = formatNumber(val);
    cs.typing = true;
    return cs;
  }

  function calcItemsForEval(cs) {
    const items = cs.entries.slice();
    if (cs.typing) items.push(parseFloat(cs.current));
    while (items.length && typeof items[items.length - 1] === 'string') items.pop();
    return items;
  }

  function calcEquals(cs) {
    if (cs.error) return cs;
    if (cs.done) return cs;
    const items = calcItemsForEval(cs);
    if (!items.length) return cs;
    const parts = [];
    for (let i = 0; i < items.length; i++) {
      parts.push(typeof items[i] === 'number' ? formatNumber(items[i]) : OP_SYMBOL[items[i]]);
    }
    let value;
    try {
      value = evaluateItems(items);
    } catch (e) {
      cs.error = (e && e.code === 'DIV_ZERO') ? MSG.divZero : '无法计算';
      cs.done = false;
      return cs;
    }
    cs.lastExpression = parts.join(' ');
    cs.current = formatNumber(value);
    cs.entries = [];
    cs.typing = false;
    cs.done = true;
    cs.justEvaluated = { expression: cs.lastExpression, result: cs.current };
    return cs;
  }

  function calcApply(cs, action) {
    cs.justEvaluated = null;
    if (!action) return cs;
    switch (action.t) {
      case 'digit': calcInputDigit(cs, action.v); break;
      case 'dot': calcInputDot(cs); break;
      case 'op': calcOperator(cs, action.v); break;
      case 'equals': calcEquals(cs); break;
      case 'back': calcBackspace(cs); break;
      case 'clear': calcReset(cs); break;
      case 'sign': calcToggleSign(cs); break;
      case 'percent': calcPercent(cs); break;
      default: break;
    }
    return cs;
  }

  /* ==================== §6 换算引擎 ==================== */

  const CATEGORY_LABEL = { length: '长度', weight: '重量', temperature: '温度', area: '面积', volume: '体积' };

  const DEFAULT_UNIT_PAIR = {
    length: ['m', 'ft'],
    weight: ['kg', 'lb'],
    temperature: ['C', 'F'],
    area: ['m2', 'ft2'],
    volume: ['L', 'galUS']
  };

  /* 除温度外统一用「系数 × 基准单位」表示；温度带偏移，单独走公式 */
  const UNITS = {
    length: {
      base: 'm',
      units: [
        { k: 'mm', label: '毫米', factor: 0.001 },
        { k: 'cm', label: '厘米', factor: 0.01 },
        { k: 'm', label: '米', factor: 1 },
        { k: 'km', label: '千米', factor: 1000 },
        { k: 'in', label: '英寸', factor: 0.0254 },
        { k: 'ft', label: '英尺', factor: 0.3048 },
        { k: 'yd', label: '码', factor: 0.9144 },
        { k: 'mi', label: '英里', factor: 1609.344 }
      ]
    },
    weight: {
      base: 'kg',
      units: [
        { k: 'mg', label: '毫克', factor: 0.000001 },
        { k: 'g', label: '克', factor: 0.001 },
        { k: 'kg', label: '千克', factor: 1 },
        { k: 't', label: '吨', factor: 1000 },
        { k: 'oz', label: '盎司', factor: 0.028349523125 },
        { k: 'lb', label: '磅', factor: 0.45359237 }
      ]
    },
    temperature: {
      base: 'C',
      units: [
        { k: 'C', label: '摄氏度', factor: null },
        { k: 'F', label: '华氏度', factor: null },
        { k: 'K', label: '开尔文', factor: null }
      ]
    },
    area: {
      base: 'm2',
      units: [
        { k: 'cm2', label: '平方厘米', factor: 0.0001 },
        { k: 'm2', label: '平方米', factor: 1 },
        { k: 'km2', label: '平方千米', factor: 1000000 },
        { k: 'ha', label: '公顷', factor: 10000 },
        { k: 'ft2', label: '平方英尺', factor: 0.09290304 },
        { k: 'acre', label: '英亩', factor: 4046.8564224 },
        { k: 'mi2', label: '平方英里', factor: 2589988.110336 }
      ]
    },
    volume: {
      base: 'L',
      units: [
        { k: 'mL', label: '毫升', factor: 0.001 },
        { k: 'cm3', label: '立方厘米', factor: 0.001 },
        { k: 'L', label: '升', factor: 1 },
        { k: 'm3', label: '立方米', factor: 1000 },
        { k: 'galUS', label: '美制加仑', factor: 3.785411784 },
        { k: 'galUK', label: '英制加仑', factor: 4.54609 },
        { k: 'floz', label: '液盎司', factor: 0.0295735295625 }
      ]
    }
  };

  const TEMP_TO_C = {
    C: function (v) { return v; },
    F: function (v) { return (v - 32) * 5 / 9; },
    K: function (v) { return v - 273.15; }
  };

  const TEMP_FROM_C = {
    C: function (c) { return c; },
    F: function (c) { return c * 9 / 5 + 32; },
    K: function (c) { return c + 273.15; }
  };

  function findUnit(category, key) {
    const cat = UNITS[category];
    if (!cat) return null;
    for (let i = 0; i < cat.units.length; i++) {
      if (cat.units[i].k === key) return cat.units[i];
    }
    return null;
  }

  function unitLabel(category, key) {
    const u = findUnit(category, key);
    return u ? u.label : key;
  }

  function convertValue(category, fromKey, toKey, value) {
    if (category === 'temperature') {
      if (!TEMP_TO_C[fromKey] || !TEMP_FROM_C[toKey]) return NaN;
      return TEMP_FROM_C[toKey](TEMP_TO_C[fromKey](value));
    }
    const f = findUnit(category, fromKey);
    const t = findUnit(category, toKey);
    if (!f || !t || !f.factor || !t.factor) return NaN;
    return value * f.factor / t.factor;
  }

  /* 换算结果保留 6 位小数并去掉尾零，过大或过小改科学计数法 */
  function formatConvert(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '';
    if (v === 0) return '0';
    const abs = Math.abs(v);
    if (abs >= 1e12 || abs < 1e-6) return trimExp(v.toExponential(6));
    let s = v.toFixed(6);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  function parseNumericInput(str) {
    const s = String(str == null ? '' : str).trim();
    if (s === '') return { ok: true, empty: true, value: null };
    if (!/^-?\d*\.?\d*$/.test(s)) return { ok: false, empty: false, value: null };
    if (s === '-' || s === '.' || s === '-.') return { ok: true, empty: true, value: null };
    const v = parseFloat(s);
    if (!isFinite(v)) return { ok: false, empty: false, value: null };
    return { ok: true, empty: false, value: v };
  }

  function byId(id) {
    if (typeof document === 'undefined' || !document) return null;
    return document.getElementById(id);
  }

  /* ==================== §7 日期引擎 ==================== */

  const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const SHIFT_UNIT_LABEL = { day: '天', week: '周', month: '月', year: '年' };

  /* 一律用「年月日」构造本地时间，禁止 new Date('2026-10-13')，后者按 UTC 解析会整体差一天 */
  function parseDate(s) {
    if (typeof s !== 'string') return null;
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  function formatDate(dt) {
    if (!(dt instanceof Date) || isNaN(dt.getTime())) return '';
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
  }

  function weekdayCN(dt) {
    if (!(dt instanceof Date) || isNaN(dt.getTime())) return '';
    return WEEKDAY_CN[dt.getDay()];
  }

  function daysBetween(a, b) {
    const A = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    const B = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((B.getTime() - A.getTime()) / 86400000);
  }

  function addDays(dt, n) {
    const r = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    r.setDate(r.getDate() + n);
    return r;
  }

  /* 月份加减：若目标月没有该日号，取目标月最后一天（1/31 + 1 月 = 2/28 或 2/29） */
  function addMonths(dt, n) {
    const target = new Date(dt.getFullYear(), dt.getMonth() + n, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    return new Date(target.getFullYear(), target.getMonth(), Math.min(dt.getDate(), lastDay));
  }

  function addYears(dt, n) { return addMonths(dt, n * 12); }

  function shiftDate(dt, dir, amount, unit) {
    const n = (dir < 0 ? -1 : 1) * amount;
    if (unit === 'day') return addDays(dt, n);
    if (unit === 'week') return addDays(dt, n * 7);
    if (unit === 'month') return addMonths(dt, n);
    if (unit === 'year') return addYears(dt, n);
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  /* 精确年龄：先定位不超过参照日的最大整月锚点，剩余部分即为天数。
     这样 1 月 31 日 → 3 月 1 日 会得到 0 年 1 月 1 天，而不是负数。 */
  function ageFrom(birth, ref) {
    let months = (ref.getFullYear() - birth.getFullYear()) * 12 + (ref.getMonth() - birth.getMonth());
    let anchor = addMonths(birth, months);
    if (anchor.getTime() > ref.getTime()) {
      months -= 1;
      anchor = addMonths(birth, months);
    }
    return { y: Math.floor(months / 12), m: months % 12, d: daysBetween(anchor, ref) };
  }

  /* 周年日期：2 月 29 日出生遇非闰年，按 3 月 1 日计算 */
  function anniversaryDate(birth, year) {
    const m = birth.getMonth() + 1;
    const dt = new Date(year, m - 1, birth.getDate());
    if (dt.getMonth() !== m - 1) return new Date(year, 2, 1);
    return dt;
  }

  function nextAnniversary(birth, ref) {
    let dt = anniversaryDate(birth, ref.getFullYear());
    if (daysBetween(ref, dt) < 0) dt = anniversaryDate(birth, ref.getFullYear() + 1);
    return dt;
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  /* --- 三个子功能的纯计算 --- */

  function computeDateDiff(startStr, endStr) {
    const a = parseDate(startStr);
    const b = parseDate(endStr);
    if (!a || !b) return { ok: false };
    const days = daysBetween(a, b);
    const abs = Math.abs(days);
    return {
      ok: true,
      days: days,
      includeFirst: days >= 0 ? days + 1 : days - 1,
      weeks: Math.floor(abs / 7),
      restDays: abs % 7,
      months: round1(days / 30.44),
      reversed: days < 0
    };
  }

  function computeDateShift(startStr, dir, amountStr, unit) {
    const a = parseDate(startStr);
    const n = Number(String(amountStr == null ? '' : amountStr).trim());
    if (!a) return { ok: false };
    if (!isFinite(n) || n < 0 || !SHIFT_UNIT_LABEL[unit]) return { ok: false, badAmount: true };
    const dt = shiftDate(a, Number(dir) < 0 ? -1 : 1, Math.floor(n), unit);
    return { ok: true, date: formatDate(dt), weekday: weekdayCN(dt), dateObj: dt };
  }

  function computeAge(birthStr, refStr) {
    const b = parseDate(birthStr);
    const ref = parseDate(refStr) || new Date();
    if (!b) return { ok: false };
    const age = ageFrom(b, ref);
    const next = nextAnniversary(b, ref);
    return {
      ok: true,
      age: age,
      passedDays: daysBetween(b, ref),
      nextDays: daysBetween(ref, next),
      nextDate: formatDate(next),
      nextWeekday: weekdayCN(next)
    };
  }

  /* ==================== §8 计算视图 ==================== */

  function renderCalc() {
    if (typeof document === 'undefined' || !document) return;
    const cs = state.calc;
    const exprEl = document.getElementById('calcExpr');
    const mainEl = document.getElementById('calcMain');
    if (exprEl) exprEl.textContent = calcExpressionText(cs);
    if (mainEl) {
      mainEl.textContent = calcDisplayText(cs, state.settings.thousandSeparator);
      if (cs.error) mainEl.classList.add('is-error');
      else mainEl.classList.remove('is-error');
    }
  }

  function calcActionFromButton(btn) {
    const kind = btn.getAttribute('data-key');
    if (kind === 'digit') return { t: 'digit', v: btn.getAttribute('data-digit') };
    if (kind === 'op') return { t: 'op', v: btn.getAttribute('data-op') };
    if (kind === 'dot') return { t: 'dot' };
    if (kind === 'equals') return { t: 'equals' };
    if (kind === 'back') return { t: 'back' };
    if (kind === 'clear') return { t: 'clear' };
    if (kind === 'sign') return { t: 'sign' };
    if (kind === 'percent') return { t: 'percent' };
    return null;
  }

  function calcRunAction(action) {
    if (!action) return;
    calcApply(state.calc, action);
    const ev = state.calc.justEvaluated;
    if (ev) {
      Store.addRecord('calc', ev.expression, ev.result, { expression: ev.expression });
      state.history.items = Store.loadHistory();
      state.calc.justEvaluated = null;
    }
    renderCalc();
  }

  function calcKeyFromKeyboard(e) {
    const k = e.key;
    if (k >= '0' && k <= '9') return { t: 'digit', v: k };
    if (k === '.' || k === ',') return { t: 'dot' };
    if (k === '+') return { t: 'op', v: '+' };
    if (k === '-') return { t: 'op', v: '-' };
    if (k === '*' || k === 'x' || k === 'X') return { t: 'op', v: '*' };
    if (k === '/') return { t: 'op', v: '/' };
    if (k === 'Enter' || k === '=') return { t: 'equals' };
    if (k === 'Backspace') return { t: 'back' };
    if (k === 'Escape' || k === 'Delete') return { t: 'clear' };
    if (k === '%') return { t: 'percent' };
    return null;
  }

  function onCalcKeydown(e) {
    if (state.view !== 'calc') return;
    const settingsOverlay = byId('settingsOverlay');
    if (settingsOverlay && !settingsOverlay.hidden) return;
    const confirmOverlay = byId('confirmOverlay');
    if (confirmOverlay && !confirmOverlay.hidden) return;
    const tag = (e.target && e.target.tagName) ? String(e.target.tagName).toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const action = calcKeyFromKeyboard(e);
    if (!action) return;
    if (e.preventDefault) e.preventDefault();
    calcRunAction(action);
  }

  function initCalcView() {
    calcReset(state.calc);
    renderCalc();

    const keypad = document.getElementById('keypad');
    if (keypad) {
      keypad.addEventListener('click', function (e) {
        const target = e.target;
        const btn = (target && target.closest) ? target.closest('[data-key]') : null;
        if (btn) calcRunAction(calcActionFromButton(btn));
      });
    }

    document.addEventListener('keydown', onCalcKeydown);
    registerEnterHook('calc', renderCalc);
  }

  /* ==================== §9 换算视图 ==================== */

  function applyUnitPair(category, useSaved) {
    const c = state.convert;
    const def = DEFAULT_UNIT_PAIR[category] || ['', ''];
    let pair = def;
    const saved = useSaved && state.settings.lastUnits ? state.settings.lastUnits[category] : null;
    if (saved && saved.length === 2 && findUnit(category, saved[0]) && findUnit(category, saved[1])) {
      pair = saved;
    }
    c.from = pair[0];
    c.to = pair[1];
  }

  function persistConvertSettings() {
    const c = state.convert;
    const units = Object.assign({}, state.settings.lastUnits);
    units[c.category] = [c.from, c.to];
    state.settings = Store.saveSettings({
      lastConvertCategory: c.category,
      lastUnits: units
    });
  }

  function fillUnitSelect(sel, category, current) {
    if (!sel) return;
    sel.innerHTML = '';
    const units = UNITS[category] ? UNITS[category].units : [];
    for (let i = 0; i < units.length; i++) {
      const opt = document.createElement('option');
      opt.value = units[i].k;
      opt.textContent = units[i].label;
      if (units[i].k === current) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function convertActiveSource() {
    const c = state.convert;
    const isRight = c.activeSide === 'right';
    return {
      isRight: isRight,
      text: isRight ? c.right : c.left,
      fromKey: isRight ? c.to : c.from,
      toKey: isRight ? c.from : c.to
    };
  }

  function renderConvertAll() {
    const box = byId('convertAllList');
    if (!box) return;
    box.hidden = !state.convertAllOpen;
    if (!state.convertAllOpen) return;
    const c = state.convert;
    const src = convertActiveSource();
    const parsed = parseNumericInput(src.text);
    const value = (parsed.ok && !parsed.empty) ? parsed.value : null;
    const units = UNITS[c.category] ? UNITS[c.category].units : [];

    box.innerHTML = '';
    for (let i = 0; i < units.length; i++) {
      const row = document.createElement('div');
      row.className = 'unit-all-row';
      const name = document.createElement('span');
      name.className = 'unit-all-name';
      name.textContent = units[i].label;
      const val = document.createElement('span');
      val.className = 'unit-all-value';
      val.textContent = (value === null) ? '—' : formatConvert(convertValue(c.category, src.fromKey, units[i].k, value));
      row.appendChild(name);
      row.appendChild(val);
      box.appendChild(row);
    }
  }

  function renderConvert() {
    if (typeof document === 'undefined' || !document) return;
    const c = state.convert;
    const tabs = document.querySelectorAll('#convertTabs .tab');
    for (let i = 0; i < tabs.length; i++) {
      const on = tabs[i].getAttribute('data-category') === c.category;
      if (on) tabs[i].classList.add('active'); else tabs[i].classList.remove('active');
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    fillUnitSelect(byId('convertFromUnit'), c.category, c.from);
    fillUnitSelect(byId('convertToUnit'), c.category, c.to);
    const leftEl = byId('convertLeft');
    const rightEl = byId('convertRight');
    if (leftEl) leftEl.value = c.left;
    if (rightEl) rightEl.value = c.right;
    const flag = byId('convertAllToggle');
    if (flag) {
      flag.setAttribute('aria-expanded', state.convertAllOpen ? 'true' : 'false');
      const caret = flag.querySelector('.caret');
      if (caret) caret.textContent = state.convertAllOpen ? '▾' : '▸';
    }
    renderConvertAll();
  }

  /* 以指定一侧为准重算另一侧；opts.record 为真时排入历史写入队列 */
  function recomputeConvert(side, opts) {
    const c = state.convert;
    const isRight = side === 'right';
    const srcEl = byId(isRight ? 'convertRight' : 'convertLeft');
    const dstEl = byId(isRight ? 'convertLeft' : 'convertRight');
    const parsed = parseNumericInput(isRight ? c.right : c.left);

    if (!parsed.ok) {
      if (srcEl) srcEl.classList.add('invalid');
      return;
    }
    if (srcEl) srcEl.classList.remove('invalid');

    let out = '';
    if (!parsed.empty) {
      const fromKey = isRight ? c.to : c.from;
      const toKey = isRight ? c.from : c.to;
      out = formatConvert(convertValue(c.category, fromKey, toKey, parsed.value));
    }
    if (isRight) c.left = out; else c.right = out;
    if (dstEl) dstEl.value = out;
    renderConvertAll();

    if (opts && opts.record) convertHistoryDebounced();
  }

  function writeConvertHistory() {
    const c = state.convert;
    const src = convertActiveSource();
    const parsed = parseNumericInput(src.text);
    if (!parsed.ok || parsed.empty) return;
    const out = src.isRight ? c.left : c.right;
    const title = formatConvert(parsed.value) + ' ' + unitLabel(c.category, src.fromKey) + ' → ' + unitLabel(c.category, src.toKey);
    const key = [c.category, src.fromKey, src.toKey, parsed.value].join('|');
    const rec = Store.addRecord('convert', title, out, {
      category: c.category,
      from: src.fromKey,
      to: src.toKey,
      value: parsed.value
    }, key);
    if (rec) state.history.items = Store.loadHistory();
  }

  const convertHistoryDebounced = debounce(writeConvertHistory, DEBOUNCE_MS);

  function initConvertView() {
    const c = state.convert;
    c.category = UNITS[state.settings.lastConvertCategory] ? state.settings.lastConvertCategory : 'length';
    applyUnitPair(c.category, true);
    c.activeSide = 'left';
    c.left = '1';
    recomputeConvert('left', { record: false });
    renderConvert();

    const tabs = byId('convertTabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        const target = e.target;
        const btn = (target && target.closest) ? target.closest('[data-category]') : null;
        if (!btn) return;
        const cat = btn.getAttribute('data-category');
        if (!UNITS[cat]) return;
        state.convert.category = cat;
        applyUnitPair(cat, true);
        state.convert.activeSide = 'left';
        recomputeConvert('left', { record: false });
        renderConvert();
        persistConvertSettings();
      });
    }

    const fromSel = byId('convertFromUnit');
    if (fromSel) {
      fromSel.addEventListener('change', function () {
        if (!findUnit(state.convert.category, fromSel.value)) return;
        state.convert.from = fromSel.value;
        recomputeConvert(state.convert.activeSide, { record: false });
        renderConvertAll();
        persistConvertSettings();
      });
    }

    const toSel = byId('convertToUnit');
    if (toSel) {
      toSel.addEventListener('change', function () {
        if (!findUnit(state.convert.category, toSel.value)) return;
        state.convert.to = toSel.value;
        recomputeConvert(state.convert.activeSide, { record: false });
        renderConvertAll();
        persistConvertSettings();
      });
    }

    const leftEl = byId('convertLeft');
    if (leftEl) {
      leftEl.addEventListener('input', function () {
        state.convert.left = leftEl.value;
        state.convert.activeSide = 'left';
        recomputeConvert('left', { record: true });
      });
    }

    const rightEl = byId('convertRight');
    if (rightEl) {
      rightEl.addEventListener('input', function () {
        state.convert.right = rightEl.value;
        state.convert.activeSide = 'right';
        recomputeConvert('right', { record: true });
      });
    }

    const swap = byId('convertSwap');
    if (swap) {
      swap.addEventListener('click', function () {
        const cur = state.convert;
        const f = cur.from;
        cur.from = cur.to;
        cur.to = f;
        cur.activeSide = 'left';
        recomputeConvert('left', { record: false });
        renderConvert();
        persistConvertSettings();
      });
    }

    const flag = byId('convertAllToggle');
    if (flag) {
      flag.addEventListener('click', function () {
        state.convertAllOpen = !state.convertAllOpen;
        renderConvert();
      });
    }

    registerEnterHook('convert', function () { renderConvert(); });
  }

  /* ==================== §10 日期视图 ==================== */

  function renderResultList(el, rows) {
    if (!el) return;
    el.innerHTML = '';
    for (let i = 0; i < rows.length; i++) {
      const row = document.createElement('div');
      row.className = 'result-row';
      const k = document.createElement('span');
      k.className = 'result-key';
      k.textContent = rows[i][0];
      const v = document.createElement('span');
      v.className = 'result-val' + (rows[i][2] ? ' ' + rows[i][2] : '');
      v.textContent = rows[i][1];
      row.appendChild(k);
      row.appendChild(v);
      el.appendChild(row);
    }
  }

  function renderDateDiff() {
    const d = state.dates.diff;
    const res = computeDateDiff(d.start, d.end);
    if (!res.ok) { renderResultList(byId('diffResult'), [['结果', '—']]); return; }
    const rows = [
      ['相差', res.days + ' 天'],
      ['含首日', res.includeFirst + ' 天'],
      ['折合', res.weeks + ' 周 ' + res.restDays + ' 天'],
      ['约合', res.months + ' 个月']
    ];
    if (res.reversed) rows.push(['提示', '结束日期早于起始日期', 'warn']);
    renderResultList(byId('diffResult'), rows);
  }

  function renderDateShift() {
    const s = state.dates.shift;
    const res = computeDateShift(s.start, s.dir, s.amount, s.unit);
    if (!res.ok) {
      renderResultList(byId('shiftResult'), [['结果日期', '—'], ['星期', '—']]);
      return;
    }
    renderResultList(byId('shiftResult'), [
      ['结果日期', res.date],
      ['星期', res.weekday]
    ]);
  }

  function renderDateAge() {
    const a = state.dates.age;
    const res = computeAge(a.birth, todayStr());
    if (!res.ok) { renderResultList(byId('ageResult'), [['结果', '—']]); return; }
    renderResultList(byId('ageResult'), [
      ['年龄', res.age.y + ' 年 ' + res.age.m + ' 月 ' + res.age.d + ' 天'],
      ['已经过去', res.passedDays + ' 天'],
      ['距离下次周年', res.nextDays + ' 天'],
      ['下次周年', res.nextDate + ' ' + res.nextWeekday]
    ]);
  }

  function renderDate() {
    if (typeof document === 'undefined' || !document) return;
    const d = state.dates;
    const startEl = byId('diffStart');
    const endEl = byId('diffEnd');
    const shiftStartEl = byId('shiftStart');
    const dirEl = byId('shiftDir');
    const amountEl = byId('shiftAmount');
    const unitEl = byId('shiftUnit');
    const birthEl = byId('ageBirth');
    if (startEl) startEl.value = d.diff.start;
    if (endEl) endEl.value = d.diff.end;
    if (shiftStartEl) shiftStartEl.value = d.shift.start;
    if (dirEl) dirEl.value = String(d.shift.dir);
    if (amountEl) amountEl.value = d.shift.amount;
    if (unitEl) unitEl.value = d.shift.unit;
    if (birthEl) birthEl.value = d.age.birth;
    renderDateDiff();
    renderDateShift();
    renderDateAge();
  }

  function validateShiftAmount() {
    const s = state.dates.shift;
    const el = byId('shiftAmount');
    const res = computeDateShift(s.start, s.dir, s.amount, s.unit);
    if (el) {
      if (!res.ok && res.badAmount) el.classList.add('invalid');
      else el.classList.remove('invalid');
    }
    return res.ok;
  }

  function persistDateSettings() {
    const d = state.dates;
    state.settings = Store.saveSettings({
      lastDates: { start: d.diff.start, end: d.diff.end, shiftStart: d.shift.start, birth: d.age.birth }
    });
  }

  let pendingDateCard = null;

  function writeDateHistory(card) {
    if (card === 'diff') {
      const d = state.dates.diff;
      const res = computeDateDiff(d.start, d.end);
      if (!res.ok) return;
      Store.addRecord('date', d.start + ' → ' + d.end, res.days + ' 天',
        { mode: 'diff', start: d.start, end: d.end },
        ['date', 'diff', d.start, d.end].join('|'));
    } else if (card === 'shift') {
      const s = state.dates.shift;
      const res = computeDateShift(s.start, s.dir, s.amount, s.unit);
      if (!res.ok) return;
      const dirLabel = Number(s.dir) < 0 ? '之前' : '之后';
      Store.addRecord('date', s.start + ' ' + dirLabel + ' ' + Number(s.amount) + ' ' + SHIFT_UNIT_LABEL[s.unit],
        res.date + ' ' + res.weekday,
        { mode: 'shift', start: s.start, dir: Number(s.dir), amount: Number(s.amount), unit: s.unit },
        ['date', 'shift', s.start, s.dir, s.amount, s.unit].join('|'));
    } else if (card === 'age') {
      const a = state.dates.age;
      const res = computeAge(a.birth, todayStr());
      if (!res.ok) return;
      Store.addRecord('date', a.birth + ' 年龄',
        res.age.y + ' 年 ' + res.age.m + ' 月 ' + res.age.d + ' 天',
        { mode: 'age', birth: a.birth },
        ['date', 'age', a.birth].join('|'));
    }
    state.history.items = Store.loadHistory();
  }

  const dateHistoryDebounced = debounce(function () {
    if (pendingDateCard) writeDateHistory(pendingDateCard);
    pendingDateCard = null;
  }, DEBOUNCE_MS);

  function scheduleDateHistory(card) {
    pendingDateCard = card;
    dateHistoryDebounced();
  }

  function initDateView() {
    const d = state.dates;
    const saved = state.settings.lastDates || {};
    d.diff.start = parseDate(saved.start) ? saved.start : todayStr();
    d.diff.end = parseDate(saved.end) ? saved.end : todayStr();
    d.shift.start = parseDate(saved.shiftStart) ? saved.shiftStart : todayStr();
    d.shift.dir = 1;
    d.shift.amount = '30';
    d.shift.unit = 'day';
    d.age.birth = parseDate(saved.birth) ? saved.birth : '';

    renderDate();

    const bind = function (id, handler) {
      const el = byId(id);
      if (!el) return;
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    };

    bind('diffStart', function () {
      state.dates.diff.start = byId('diffStart').value;
      renderDateDiff();
      persistDateSettings();
      scheduleDateHistory('diff');
    });

    bind('diffEnd', function () {
      state.dates.diff.end = byId('diffEnd').value;
      renderDateDiff();
      persistDateSettings();
      scheduleDateHistory('diff');
    });

    bind('shiftStart', function () {
      state.dates.shift.start = byId('shiftStart').value;
      validateShiftAmount();
      renderDateShift();
      persistDateSettings();
      scheduleDateHistory('shift');
    });

    bind('shiftDir', function () {
      state.dates.shift.dir = Number(byId('shiftDir').value);
      renderDateShift();
      scheduleDateHistory('shift');
    });

    bind('shiftAmount', function () {
      state.dates.shift.amount = byId('shiftAmount').value;
      validateShiftAmount();
      renderDateShift();
      scheduleDateHistory('shift');
    });

    bind('shiftUnit', function () {
      state.dates.shift.unit = byId('shiftUnit').value;
      renderDateShift();
      scheduleDateHistory('shift');
    });

    bind('ageBirth', function () {
      state.dates.age.birth = byId('ageBirth').value;
      renderDateAge();
      persistDateSettings();
      scheduleDateHistory('age');
    });

    validateShiftAmount();
    registerEnterHook('date', renderDate);
  }

  /* 历史回填：把记录里的参数还原到日期视图 */
  function setDateFromRecord(detail) {
    if (!detail) return;
    if (detail.mode === 'diff') {
      state.dates.diff.start = detail.start || '';
      state.dates.diff.end = detail.end || '';
    } else if (detail.mode === 'shift') {
      state.dates.shift.start = detail.start || '';
      state.dates.shift.dir = Number(detail.dir) < 0 ? -1 : 1;
      state.dates.shift.amount = String(detail.amount == null ? '' : detail.amount);
      if (SHIFT_UNIT_LABEL[detail.unit]) state.dates.shift.unit = detail.unit;
    } else if (detail.mode === 'age') {
      state.dates.age.birth = detail.birth || '';
    }
    renderDate();
  }

  /* ==================== §11 历史视图 ==================== */

  let confirmResolve = null;

  function confirmDialog(message) {
    return new Promise(function (resolve) {
      const overlay = byId('confirmOverlay');
      const textEl = byId('confirmText');
      if (!overlay || !textEl) { resolve(false); return; }
      textEl.textContent = message;
      overlay.hidden = false;
      confirmResolve = function (val) {
        overlay.hidden = true;
        confirmResolve = null;
        resolve(val);
      };
      const ok = byId('confirmOk');
      if (ok && ok.focus) ok.focus();
    });
  }

  function bindConfirmDialog() {
    const overlay = byId('confirmOverlay');
    const okBtn = byId('confirmOk');
    const cancelBtn = byId('confirmCancel');
    if (okBtn) okBtn.addEventListener('click', function () { if (confirmResolve) confirmResolve(true); });
    if (cancelBtn) cancelBtn.addEventListener('click', function () { if (confirmResolve) confirmResolve(false); });
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay && confirmResolve) confirmResolve(false);
      });
    }
  }

  function visibleHistoryItems() {
    const q = String(state.history.query || '').trim().toLowerCase();
    const f = state.history.filter;
    return state.history.items.filter(function (r) {
      if (f !== 'all' && r.type !== f) return false;
      if (!q) return true;
      return (r.title + ' ' + r.result).toLowerCase().indexOf(q) >= 0;
    });
  }

  function buildHistoryRow(rec) {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.setAttribute('data-id', rec.id);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'history-main';
    main.setAttribute('data-open', rec.id);
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = rec.title;
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = TYPE_LABEL[rec.type] + ' · ' + formatStamp(rec.createdAt);
    main.appendChild(title);
    main.appendChild(meta);

    const result = document.createElement('span');
    result.className = 'history-result';
    result.textContent = rec.result;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-del';
    del.setAttribute('data-del', rec.id);
    del.setAttribute('aria-label', '删除这条记录');
    del.textContent = '✕';

    row.appendChild(main);
    row.appendChild(result);
    row.appendChild(del);
    return row;
  }

  function renderHistory() {
    if (typeof document === 'undefined' || !document) return;
    state.history.items = Store.loadHistory();

    const searchEl = byId('historySearch');
    if (searchEl && searchEl.value !== state.history.query) searchEl.value = state.history.query;

    const segs = document.querySelectorAll('#historyFilter .seg-item');
    for (let i = 0; i < segs.length; i++) {
      const on = segs[i].getAttribute('data-filter') === state.history.filter;
      if (on) segs[i].classList.add('active'); else segs[i].classList.remove('active');
      segs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }

    const clearBtn = byId('historyClear');
    if (clearBtn) clearBtn.disabled = state.history.items.length === 0;

    const list = byId('historyList');
    if (!list) return;

    const items = visibleHistoryItems();
    list.innerHTML = '';
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'history-empty';
      p.textContent = state.history.items.length ? MSG.noMatch : MSG.emptyHistory;
      list.appendChild(p);
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < items.length; i++) frag.appendChild(buildHistoryRow(items[i]));
    list.appendChild(frag);
  }

  function deleteHistoryRecord(id) {
    state.history.items = Store.deleteRecord(id);
    renderHistory();
    return state.history.items;
  }

  function clearAllHistory() {
    const n = state.history.items.length;
    if (!n) return Promise.resolve(false);
    return confirmDialog(MSG.clearConfirm.replace('{n}', n)).then(function (ok) {
      if (!ok) return false;
      state.history.items = Store.clearHistory();
      renderHistory();
      return true;
    });
  }

  function typeNumberIntoCalc(cs, str) {
    const s = String(str);
    if (s.indexOf('e') >= 0 || s.indexOf('E') >= 0) {
      cs.current = s;
      cs.typing = true;
      return;
    }
    let neg = false;
    let body = s;
    if (body.charAt(0) === '-') { neg = true; body = body.slice(1); }
    for (let i = 0; i < body.length; i++) {
      const ch = body.charAt(i);
      if (ch === '.') calcApply(cs, { t: 'dot' });
      else if (ch >= '0' && ch <= '9') calcApply(cs, { t: 'digit', v: ch });
    }
    if (neg) calcApply(cs, { t: 'sign' });
  }

  function setCalcFromRecord(detail) {
    const cs = state.calc;
    calcReset(cs);
    const expression = detail && detail.expression ? String(detail.expression) : '';
    if (expression) {
      const symToOp = { '+': '+', '-': '-', '−': '-', '×': '*', '÷': '/', '*': '*', '/': '/' };
      const tokens = expression.split(/\s+/);
      for (let i = 0; i < tokens.length; i++) {
        const tk = tokens[i];
        if (!tk) continue;
        if (symToOp[tk]) { calcApply(cs, { t: 'op', v: symToOp[tk] }); continue; }
        if (isFinite(Number(tk))) typeNumberIntoCalc(cs, tk);
      }
    }
    renderCalc();
  }

  function setConvertFromRecord(detail) {
    if (!detail) return;
    const c = state.convert;
    if (UNITS[detail.category]) c.category = detail.category;
    if (findUnit(c.category, detail.from)) c.from = detail.from;
    if (findUnit(c.category, detail.to)) c.to = detail.to;
    c.activeSide = 'left';
    c.left = (detail.value === null || detail.value === undefined || !isFinite(Number(detail.value)))
      ? '' : formatConvert(Number(detail.value));
    recomputeConvert('left', { record: false });
    renderConvert();
  }

  function openHistoryRecord(id) {
    const rec = state.history.items.filter(function (r) { return r.id === id; })[0];
    if (!rec) return null;
    if (rec.type === 'calc') {
      setCalcFromRecord(rec.detail);
      setView('calc');
    } else if (rec.type === 'convert') {
      setConvertFromRecord(rec.detail);
      setView('convert');
    } else if (rec.type === 'date') {
      setDateFromRecord(rec.detail);
      setView('date');
    }
    return rec;
  }

  function initHistoryView() {
    renderHistory();

    const searchEl = byId('historySearch');
    if (searchEl) {
      searchEl.addEventListener('input', function () {
        state.history.query = searchEl.value;
        renderHistory();
      });
    }

    const filterEl = byId('historyFilter');
    if (filterEl) {
      filterEl.addEventListener('click', function (e) {
        const target = e.target;
        const btn = (target && target.closest) ? target.closest('[data-filter]') : null;
        if (!btn) return;
        const f = btn.getAttribute('data-filter');
        if (f !== 'all' && !TYPE_LABEL[f]) return;
        state.history.filter = f;
        renderHistory();
      });
    }

    const clearBtn = byId('historyClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () { clearAllHistory(); });
    }

    const list = byId('historyList');
    if (list) {
      list.addEventListener('click', function (e) {
        const target = e.target;
        const delBtn = (target && target.closest) ? target.closest('[data-del]') : null;
        if (delBtn) { deleteHistoryRecord(delBtn.getAttribute('data-del')); return; }
        const openBtn = (target && target.closest) ? target.closest('[data-open]') : null;
        if (openBtn) openHistoryRecord(openBtn.getAttribute('data-open'));
      });
    }

    bindConfirmDialog();
    registerEnterHook('history', renderHistory);
  }

  /* ==================== §12 设置与备份 ==================== */

  let settingsOpen = false;

  function renderSettings() {
    if (typeof document === 'undefined' || !document) return;
    const s = state.settings;
    const cb = byId('setThousand');
    if (cb) cb.checked = s.thousandSeparator !== false;
    const limit = byId('setLimit');
    if (limit && document.activeElement !== limit) limit.value = String(s.historyLimit);
    const count = byId('setCount');
    if (count) count.textContent = '已存 ' + Store.count() + ' 条记录';
  }

  function toggleSettings(open) {
    settingsOpen = (open === undefined) ? !settingsOpen : !!open;
    const overlay = byId('settingsOverlay');
    if (overlay) overlay.hidden = !settingsOpen;
    if (settingsOpen) renderSettings();
    return settingsOpen;
  }

  /* --- 备份导出 --- */

  function buildBackup() {
    const payload = Store.exportPayload();
    return { fileName: Store.exportFileName(), payload: payload, text: JSON.stringify(payload, null, 2) };
  }

  function triggerDownload(href, fileName) {
    const a = document.createElement('a');
    a.href = href;
    a.download = fileName;
    if (document.body && document.body.appendChild) document.body.appendChild(a);
    a.click();
    if (document.body && a.parentNode === document.body) document.body.removeChild(a);
  }

  function downloadBackup() {
    const b = buildBackup();
    if (typeof document === 'undefined' || !document) return b;
    let done = false;
    try {
      if (typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(new Blob([b.text], { type: 'application/json' }));
        triggerDownload(url, b.fileName);
        if (typeof URL.revokeObjectURL === 'function') {
          setTimeout(function () { URL.revokeObjectURL(url); }, 0);
        }
        done = true;
      }
    } catch (e) {
      done = false;
    }
    if (!done) {
      triggerDownload('data:application/json;charset=utf-8,' + encodeURIComponent(b.text), b.fileName);
    }
    showNotice(MSG.exportDone, 'info');
    return b;
  }

  /* --- 备份导入 --- */

  function refreshAllViews() {
    renderCalc();
    renderConvert();
    renderDate();
    renderHistory();
    renderSettings();
  }

  function importBackupText(text) {
    const res = Store.validateImport(text);
    if (!res.ok) {
      showNotice(res.reason === 'version' ? MSG.importVersion : MSG.importBad);
      return Promise.resolve({ ok: false, reason: res.reason });
    }
    return confirmDialog(MSG.importConfirm).then(function (yes) {
      if (!yes) return { ok: false, reason: 'cancel' };
      const done = Store.importPayload(res.payload);
      if (!done.ok) {
        showNotice(MSG.importBad);
        return { ok: false, reason: done.reason };
      }
      state.settings = Store.loadSettings();
      state.history.items = Store.loadHistory();
      refreshAllViews();
      let msg = MSG.importDone.replace('{n}', done.count);
      if (res.skipped) msg += ' ' + MSG.importSkipped.replace('{n}', res.skipped);
      showNotice(msg, 'info');
      return { ok: true, count: done.count, skipped: res.skipped };
    });
  }

  function importBackupFile(file) {
    if (!file) {
      showNotice(MSG.importBad);
      return Promise.resolve({ ok: false, reason: 'nofile' });
    }
    if (typeof FileReader === 'function') {
      return new Promise(function (resolve) {
        const reader = new FileReader();
        reader.onload = function () { resolve(typeof reader.result === 'string' ? reader.result : null); };
        reader.onerror = function () { resolve(null); };
        reader.readAsText(file);
      }).then(function (text) {
        if (text === null) {
          showNotice(MSG.importBad);
          return { ok: false, reason: 'read' };
        }
        return importBackupText(text);
      });
    }
    if (typeof file.text === 'function') return file.text().then(importBackupText);
    showNotice(MSG.importBad);
    return Promise.resolve({ ok: false, reason: 'reader' });
  }

  /* --- 清空全部数据 --- */

  function clearAllData() {
    const n = Store.count();
    return confirmDialog('确定清空全部数据？将删除 ' + n + ' 条记录并恢复默认设置，此操作无法撤销。')
      .then(function (ok) {
        if (!ok) return false;
        Store.clearHistory();
        Store.saveSettings(Object.assign({}, DEFAULT_SETTINGS, { lastView: state.view }));
        state.settings = Store.loadSettings();
        state.history.items = [];
        state.calc = calcReset(state.calc);
        refreshAllViews();
        return true;
      });
  }

  function applyHistoryLimit(raw) {
    const n = Number(String(raw).trim());
    const limitEl = byId('setLimit');
    if (!isFinite(n) || n < 1 || n > 5000 || Math.floor(n) !== n) {
      showNotice(MSG.limitInvalid);
      if (limitEl) limitEl.value = String(state.settings.historyLimit);
      return false;
    }
    state.settings = Store.saveSettings({ historyLimit: n });
    const items = Store.loadHistory();
    if (items.length > n) {
      Store.saveHistory(items.slice(0, n));
      state.history.items = Store.loadHistory();
      renderHistory();
    }
    renderSettings();
    return true;
  }

  function initSettings() {
    renderSettings();

    const close = byId('settingsClose');
    if (close) close.addEventListener('click', function () { toggleSettings(false); });

    const overlay = byId('settingsOverlay');
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) toggleSettings(false);
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && settingsOpen) toggleSettings(false);
    });

    const cb = byId('setThousand');
    if (cb) {
      cb.addEventListener('change', function () {
        state.settings = Store.saveSettings({ thousandSeparator: cb.checked });
        renderCalc();
      });
    }

    const limitEl = byId('setLimit');
    if (limitEl) {
      limitEl.addEventListener('change', function () { applyHistoryLimit(limitEl.value); });
    }

    const exportBtn = byId('backupExport');
    if (exportBtn) exportBtn.addEventListener('click', function () { downloadBackup(); });

    const importBtn = byId('backupImport');
    const fileInput = byId('backupFile');
    if (importBtn && fileInput) {
      importBtn.addEventListener('click', function () {
        fileInput.value = '';
        if (fileInput.click) fileInput.click();
      });
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files.length) importBackupFile(fileInput.files[0]);
      });
    }

    const clearAllBtn = byId('settingsClearAll');
    if (clearAllBtn) clearAllBtn.addEventListener('click', function () { clearAllData(); });
  }

  /* ==================== §13 初始化 ==================== */

  function bindShellEvents() {
    if (typeof document === 'undefined' || !document) return;

    const nav = document.getElementById('nav');
    if (nav) {
      nav.addEventListener('click', function (e) {
        const target = e.target;
        const btn = (target && target.closest) ? target.closest('[data-view]') : null;
        if (btn) setView(btn.getAttribute('data-view'));
      });
    }

    const settingsToggle = document.getElementById('settingsToggle');
    if (settingsToggle && typeof toggleSettings === 'function') {
      settingsToggle.addEventListener('click', function () { toggleSettings(true); });
    }
  }

  let inited = false;

  function init() {
    if (typeof document === 'undefined' || !document) return;
    if (inited) return;
    inited = true;

    state.settings = Store.loadSettings();
    state.history.items = Store.loadHistory();

    if (typeof initCalcView === 'function') initCalcView();
    if (typeof initConvertView === 'function') initConvertView();
    if (typeof initDateView === 'function') initDateView();
    if (typeof initHistoryView === 'function') initHistoryView();
    if (typeof initSettings === 'function') initSettings();

    bindShellEvents();

    if (!Store.available) showNotice(MSG.storageFailed);

    setView(state.settings.lastView, { persist: false });
  }

  /* ==================== §14 对外导出 ==================== */

  LocalCalc.APP_VERSION = APP_VERSION;
  LocalCalc.STORE_KEYS = STORE_KEYS;
  LocalCalc.VIEWS = VIEWS;
  LocalCalc.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  LocalCalc.TYPE_LABEL = TYPE_LABEL;
  LocalCalc.MSG = MSG;
  LocalCalc.Store = Store;
  LocalCalc.state = state;
  LocalCalc.setView = setView;
  LocalCalc.onEnterView = onEnterView;
  LocalCalc.registerEnterHook = registerEnterHook;
  LocalCalc.showNotice = showNotice;
  LocalCalc.hideNotice = hideNotice;
  LocalCalc.todayStr = todayStr;
  LocalCalc.formatStamp = formatStamp;
  LocalCalc.sameDay = sameDay;
  LocalCalc.debounce = debounce;
  LocalCalc.init = init;

  LocalCalc.OP_SYMBOL = OP_SYMBOL;
  LocalCalc.createCalcState = createCalcState;
  LocalCalc.calcReset = calcReset;
  LocalCalc.calcApply = calcApply;
  LocalCalc.calcEquals = calcEquals;
  LocalCalc.calcExpressionText = calcExpressionText;
  LocalCalc.calcDisplayText = calcDisplayText;
  LocalCalc.evaluateItems = evaluateItems;
  LocalCalc.formatNumber = formatNumber;
  LocalCalc.addThousands = addThousands;
  LocalCalc.trimExp = trimExp;
  LocalCalc.renderCalc = renderCalc;
  LocalCalc.calcRunAction = calcRunAction;
  LocalCalc.calcKeyFromKeyboard = calcKeyFromKeyboard;

  LocalCalc.UNITS = UNITS;
  LocalCalc.CATEGORY_LABEL = CATEGORY_LABEL;
  LocalCalc.DEFAULT_UNIT_PAIR = DEFAULT_UNIT_PAIR;
  LocalCalc.TEMP_TO_C = TEMP_TO_C;
  LocalCalc.TEMP_FROM_C = TEMP_FROM_C;
  LocalCalc.findUnit = findUnit;
  LocalCalc.unitLabel = unitLabel;
  LocalCalc.convertValue = convertValue;
  LocalCalc.formatConvert = formatConvert;
  LocalCalc.parseNumericInput = parseNumericInput;
  LocalCalc.renderConvert = renderConvert;
  LocalCalc.recomputeConvert = recomputeConvert;
  LocalCalc.writeConvertHistory = writeConvertHistory;
  LocalCalc.renderConvertAll = renderConvertAll;

  LocalCalc.WEEKDAY_CN = WEEKDAY_CN;
  LocalCalc.SHIFT_UNIT_LABEL = SHIFT_UNIT_LABEL;
  LocalCalc.parseDate = parseDate;
  LocalCalc.formatDate = formatDate;
  LocalCalc.weekdayCN = weekdayCN;
  LocalCalc.daysBetween = daysBetween;
  LocalCalc.addDays = addDays;
  LocalCalc.addMonths = addMonths;
  LocalCalc.addYears = addYears;
  LocalCalc.shiftDate = shiftDate;
  LocalCalc.ageFrom = ageFrom;
  LocalCalc.anniversaryDate = anniversaryDate;
  LocalCalc.nextAnniversary = nextAnniversary;
  LocalCalc.computeDateDiff = computeDateDiff;
  LocalCalc.computeDateShift = computeDateShift;
  LocalCalc.computeAge = computeAge;
  LocalCalc.renderDate = renderDate;
  LocalCalc.renderDateDiff = renderDateDiff;
  LocalCalc.renderDateShift = renderDateShift;
  LocalCalc.renderDateAge = renderDateAge;
  LocalCalc.writeDateHistory = writeDateHistory;
  LocalCalc.setDateFromRecord = setDateFromRecord;

  LocalCalc.confirmDialog = confirmDialog;
  LocalCalc.visibleHistoryItems = visibleHistoryItems;
  LocalCalc.renderHistory = renderHistory;
  LocalCalc.deleteHistoryRecord = deleteHistoryRecord;
  LocalCalc.clearAllHistory = clearAllHistory;
  LocalCalc.openHistoryRecord = openHistoryRecord;
  LocalCalc.setCalcFromRecord = setCalcFromRecord;
  LocalCalc.setConvertFromRecord = setConvertFromRecord;
  LocalCalc.typeNumberIntoCalc = typeNumberIntoCalc;

  LocalCalc.renderSettings = renderSettings;
  LocalCalc.toggleSettings = toggleSettings;
  LocalCalc.buildBackup = buildBackup;
  LocalCalc.downloadBackup = downloadBackup;
  LocalCalc.importBackupText = importBackupText;
  LocalCalc.importBackupFile = importBackupFile;
  LocalCalc.clearAllData = clearAllData;
  LocalCalc.applyHistoryLimit = applyHistoryLimit;

  const root = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  root.LocalCalc = LocalCalc;

  if (typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();

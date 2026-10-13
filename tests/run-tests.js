/* 本机计算器 · 自动化测试
 *
 * 运行方式
 *   npm install                      首次运行前装测试依赖（jsdom）
 *   npm test                         跑全部测试
 *   node tests/run-tests.js          同上，直接调用
 *   node tests/run-tests.js 1        只跑步骤 1 的测试
 *
 * 两类测试
 *   1) 纯逻辑沙箱：用 vm 在无 document 的环境里加载 app.js，只测引擎与存储层
 *   2) 真实 DOM 沙箱：用 jsdom 加载 index.html 并执行 app.js，模拟点击验证交互流程
 *
 * 依赖解析
 *   默认走 Node 标准解析，即项目根目录下的 node_modules。
 *   若 jsdom 装在别处，可用环境变量 LOCALCALC_NODE_MODULES 指向它的父目录，
 *   例如：LOCALCALC_NODE_MODULES=/path/to/node_modules node tests/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const APP_JS = path.join(ROOT, 'app.js');
const INDEX_HTML = path.join(ROOT, 'index.html');

const appCode = fs.readFileSync(APP_JS, 'utf8');
const htmlCode = fs.readFileSync(INDEX_HTML, 'utf8');

let JSDOMClass = null;
let VirtualConsoleClass = null;

let jsdomHintShown = false;

/** 按顺序尝试解析 jsdom：先环境变量指定目录，再走 Node 标准解析 */
function loadJsdom() {
  const candidates = [];
  if (process.env.LOCALCALC_NODE_MODULES) {
    candidates.push(path.join(process.env.LOCALCALC_NODE_MODULES, 'jsdom'));
  }
  candidates.push('jsdom');

  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return require(candidates[i]);
    } catch (e) {
      lastErr = e;
    }
  }

  // 依赖缺失属于环境问题，不是某个用例的失败，完整提示只打一次，避免刷屏
  if (jsdomHintShown) {
    throw new Error('jsdom 未安装（解决方式见上方提示）');
  }
  jsdomHintShown = true;
  throw new Error(
    '缺少测试依赖 jsdom，需要 DOM 沙箱的用例已全部跳过。\n' +
    '  解决方式：在项目根目录执行  npm install\n' +
    '  若 jsdom 已装在别处，可设置环境变量 LOCALCALC_NODE_MODULES 指向其父目录。\n' +
    '  原始错误：' + (lastErr && lastErr.message)
  );
}

function ensureJsdom() {
  if (JSDOMClass) return JSDOMClass;
  const mod = loadJsdom();
  JSDOMClass = mod.JSDOM;
  VirtualConsoleClass = mod.VirtualConsole;
  return JSDOMClass;
}

/* ---------- 沙箱：纯逻辑 ---------- */
function loadSandbox(opts) {
  const raw = new Map();
  const sandbox = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox._raw = raw;
  if (!(opts && opts.noStorage)) {
    sandbox.localStorage = {
      getItem: function (k) { return raw.has(k) ? raw.get(k) : null; },
      setItem: function (k, v) { raw.set(k, String(v)); },
      removeItem: function (k) { raw.delete(k); },
      clear: function () { raw.clear(); }
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox, { filename: 'app.js' });
  return sandbox;
}

/* ---------- 沙箱：真实 DOM ---------- */
function bootApp(opts) {
  const JSDOM = ensureJsdom();
  const vc = new VirtualConsoleClass();
  vc.on('jsdomError', function (e) {
    const msg = String(e && e.message ? e.message : e);
    /* 下载用的 <a download> 会触发 jsdom 未实现的导航，这里不算错误 */
    if (msg.indexOf('Not implemented: navigation') >= 0) return;
    console.error('[jsdom] ' + msg);
  });
  const dom = new JSDOM(htmlCode, {
    runScripts: 'outside-only',
    url: (opts && opts.url) || 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  if (opts && opts.preload) {
    for (const k in opts.preload) dom.window.localStorage.setItem(k, opts.preload[k]);
  }
  dom.window.eval(appCode);
  if (dom.window.document.readyState === 'loading') {
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  }
  return dom;
}

function $(dom, sel) { return dom.window.document.querySelector(sel); }

function click(dom, sel) {
  const el = $(dom, sel);
  assert.ok(el, '找不到元素：' + sel);
  el.click();
  return el;
}

function storeJson(dom, key) {
  const v = dom.window.localStorage.getItem(key);
  return v ? JSON.parse(v) : null;
}

/* 跨 vm 沙箱的对象来自不同 realm，原型不同，deepStrictEqual 会误判，
   这里统一按结构化 JSON 比较，判断标准一致 */
function sameJson(actual, expected, msg) {
  assert.strictEqual(
    JSON.stringify(actual),
    JSON.stringify(expected),
    msg || ('期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
  );
}

/* ---------- 测试注册与执行 ---------- */
const TESTS = [];
let stageNo = 0;
let groupTitle = '';

function stage(n, title) { stageNo = n; groupTitle = title; }
function test(name, fn) { TESTS.push({ stage: stageNo, group: groupTitle, name: name, fn: fn }); }

async function runAll() {
  const filter = process.argv[2];
  const list = filter ? TESTS.filter(function (t) { return String(t.stage) === String(filter); }) : TESTS;

  console.log('本机计算器 · 测试' + (filter ? '（仅步骤 ' + filter + '）' : '（全部）'));
  console.log('共 ' + list.length + ' 项\n');

  let pass = 0;
  const failures = [];
  let lastGroup = null;

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.group !== lastGroup) { console.log('▶ ' + t.group); lastGroup = t.group; }
    try {
      await t.fn();
      pass++;
      console.log('  ✓ ' + t.name);
    } catch (e) {
      failures.push({ t: t, e: e });
      console.log('  ✗ ' + t.name);
      console.log('      ' + String(e && e.message ? e.message : e).split('\n').join('\n      '));
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log('通过 ' + pass + ' / ' + list.length + '，失败 ' + failures.length);
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(function (f, i) {
      console.log('  ' + (i + 1) + ') [' + f.t.group + '] ' + f.t.name);
      console.log('     ' + String(f.e && f.e.message ? f.e.message : f.e));
    });
    process.exit(1);
  }
}

/* ==================================================================
 * 步骤 1 · 存储层 Store
 * ================================================================== */
stage(1, '步骤 1 · 存储层 Store');

test('首次运行返回完整默认设置', function () {
  const s = loadSandbox();
  const st = s.LocalCalc.Store.loadSettings();
  assert.strictEqual(st.version, 1);
  assert.strictEqual(st.lastView, 'calc');
  assert.strictEqual(st.historyLimit, 500);
  assert.strictEqual(st.thousandSeparator, true);
  assert.strictEqual(st.lastConvertCategory, 'length');
  sameJson(st.lastUnits, {});
  sameJson(st.lastDates, {});
});

test('保存设置后再读取，改动被保留且与默认值合并', function () {
  const s = loadSandbox();
  const Store = s.LocalCalc.Store;
  Store.saveSettings({ thousandSeparator: false });
  Store.saveSettings({ historyLimit: 200 });
  const st = Store.loadSettings();
  assert.strictEqual(st.thousandSeparator, false);
  assert.strictEqual(st.historyLimit, 200);
  assert.strictEqual(st.lastView, 'calc');
});

test('设置内容损坏时不抛错，整体回落到默认值', function () {
  const s = loadSandbox();
  s._raw.set(s.LocalCalc.STORE_KEYS.settings, '{这不是合法 JSON');
  const st = s.LocalCalc.Store.loadSettings();
  assert.strictEqual(st.historyLimit, 500);
  assert.strictEqual(st.lastView, 'calc');
});

test('非法的 lastView 回落到 calc', function () {
  const s = loadSandbox();
  s._raw.set(s.LocalCalc.STORE_KEYS.settings, JSON.stringify({ lastView: 'settings', historyLimit: 10 }));
  assert.strictEqual(s.LocalCalc.Store.loadSettings().lastView, 'calc');
});

test('非法的历史记录上限回落到 500，超大值被夹到 5000', function () {
  const s = loadSandbox();
  s._raw.set(s.LocalCalc.STORE_KEYS.settings, JSON.stringify({ historyLimit: 0 }));
  assert.strictEqual(s.LocalCalc.Store.loadSettings().historyLimit, 500);

  const s2 = loadSandbox();
  s2._raw.set(s2.LocalCalc.STORE_KEYS.settings, JSON.stringify({ historyLimit: 999999 }));
  assert.strictEqual(s2.LocalCalc.Store.loadSettings().historyLimit, 5000);
});

test('历史记录里的非法条目被过滤掉', function () {
  const s = loadSandbox();
  s._raw.set(s.LocalCalc.STORE_KEYS.history, JSON.stringify([
    { id: 'a', type: 'calc', title: '1+1', result: '2', createdAt: 1 },
    { id: 'b', type: '不存在的类型', title: 'x', result: 'y', createdAt: 2 },
    { type: 'calc', title: '缺 id', result: '3', createdAt: 3 },
    null,
    '字符串',
    { id: 'c', type: 'date', title: '相差', result: '19 天', createdAt: 5 }
  ]));
  const items = s.LocalCalc.Store.loadHistory();
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].id, 'a');
  assert.strictEqual(items[1].id, 'c');
});

test('addRecord 把新记录插到最前面并补齐字段', function () {
  const s = loadSandbox();
  const Store = s.LocalCalc.Store;
  Store.addRecord('calc', '1 + 1', '2', { expression: '1+1' });
  Store.addRecord('convert', '1 米 → 英尺', '3.28084', { category: 'length' });
  const items = Store.loadHistory();
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].type, 'convert');
  assert.strictEqual(items[1].type, 'calc');
  assert.ok(typeof items[0].id === 'string' && items[0].id.length > 0);
  assert.strictEqual(typeof items[0].createdAt, 'number');
  sameJson(items[1].detail, { expression: '1+1' });
});

test('超过历史上限时从最旧的一端裁剪', function () {
  const s = loadSandbox();
  const Store = s.LocalCalc.Store;
  Store.saveSettings({ historyLimit: 3 });
  for (let i = 1; i <= 6; i++) Store.addRecord('calc', '第 ' + i + ' 条', String(i), {});
  const items = Store.loadHistory();
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[0].title, '第 6 条');
  assert.strictEqual(items[2].title, '第 4 条');
});

test('相同的去重键不会重复写入', function () {
  const s = loadSandbox();
  const Store = s.LocalCalc.Store;
  assert.ok(Store.addRecord('convert', '1 米 → 英尺', '3.28084', {}, 'length|m|ft|1'));
  assert.strictEqual(Store.addRecord('convert', '1 米 → 英尺', '3.28084', {}, 'length|m|ft|1'), null);
  assert.strictEqual(Store.loadHistory().length, 1);
  assert.ok(Store.addRecord('convert', '2 米 → 英尺', '6.56168', {}, 'length|m|ft|2'));
  assert.strictEqual(Store.loadHistory().length, 2);
});

test('deleteRecord 只删除指定的一条', function () {
  const s = loadSandbox();
  const Store = s.LocalCalc.Store;
  Store.addRecord('calc', 'A', '1', {});
  Store.addRecord('calc', 'B', '2', {});
  const id = Store.loadHistory()[1].id;
  const left = Store.deleteRecord(id);
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].title, 'B');
});

test('clearHistory 清空全部记录', function () {
  const s = loadSandbox();
  const Store = s.LocalCalc.Store;
  Store.addRecord('calc', 'A', '1', {});
  Store.addRecord('calc', 'B', '2', {});
  sameJson(Store.clearHistory(), []);
  assert.strictEqual(Store.loadHistory().length, 0);
  assert.strictEqual(Store.count(), 0);
});

test('存储不可用时标记 available 为 false 且不抛错', function () {
  const s = loadSandbox({ noStorage: true });
  const Store = s.LocalCalc.Store;
  const st = Store.loadSettings();
  assert.strictEqual(st.historyLimit, 500);
  assert.strictEqual(Store.available, false);
});

/* ==================================================================
 * 步骤 1 · 备份数据校验（纯逻辑部分）
 * ================================================================== */
stage(1, '步骤 1 · 备份数据校验');

test('validateImport 拒绝非 JSON、缺版本、版本不符、history 非数组', function () {
  const s = loadSandbox();
  const Store = s.LocalCalc.Store;
  assert.strictEqual(Store.validateImport('不是 JSON').ok, false);
  assert.strictEqual(Store.validateImport('不是 JSON').reason, 'format');
  assert.strictEqual(Store.validateImport({ history: [] }).reason, 'version');
  assert.strictEqual(Store.validateImport({ version: 2, history: [] }).reason, 'version');
  assert.strictEqual(Store.validateImport({ version: 1, history: {} }).reason, 'format');
  assert.strictEqual(Store.validateImport(null).reason, 'format');
});

test('validateImport 跳过非法条目并给出跳过条数', function () {
  const s = loadSandbox();
  const res = s.LocalCalc.Store.validateImport({
    version: 1,
    history: [
      { id: 'a', type: 'calc', title: '1+1', result: '2', createdAt: 1 },
      { id: 'b', type: 'xx', title: '坏', result: '坏', createdAt: 2 },
      { id: 'c', type: 'date', title: '相差', result: '19 天', createdAt: 3 }
    ]
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.payload.history.length, 2);
  assert.strictEqual(res.skipped, 1);
});

test('importPayload 覆盖数据并按上限裁剪，同时只写入已知设置字段', function () {
  const s = loadSandbox();
  const Store = s.LocalCalc.Store;
  Store.addRecord('calc', '旧记录', '1', {});
  const res = Store.importPayload({
    settings: { historyLimit: 2, thousandSeparator: false, 未知字段: '忽略我' },
    history: [
      { id: '1', type: 'calc', title: 'A', result: '1', createdAt: 11 },
      { id: '2', type: 'calc', title: 'B', result: '2', createdAt: 12 },
      { id: '3', type: 'calc', title: 'C', result: '3', createdAt: 13 }
    ]
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 2);
  const st = Store.loadSettings();
  assert.strictEqual(st.historyLimit, 2);
  assert.strictEqual(st.thousandSeparator, false);
  assert.strictEqual(st.未知字段, undefined);
  assert.strictEqual(Store.loadHistory()[0].title, 'A');
});

/* ==================================================================
 * 步骤 1 · 视图路由与持久化（真实 DOM）
 * ================================================================== */
stage(1, '步骤 1 · 视图路由与持久化（真实 DOM）');

test('页面骨架包含四个视图容器与四个导航入口', function () {
  const dom = bootApp();
  ['calc', 'convert', 'date', 'history'].forEach(function (v) {
    assert.ok($(dom, '#view-' + v), '缺少视图容器 #view-' + v);
    assert.ok($(dom, '#nav [data-view="' + v + '"]'), '缺少导航入口 ' + v);
  });
  assert.ok($(dom, '#settingsToggle'), '缺少设置入口');
  assert.ok($(dom, '#settingsOverlay'), '缺少设置面板容器');
  assert.ok($(dom, '#confirmOverlay'), '缺少确认弹层容器');
});

test('首次打开默认停在计算视图（A1）', function () {
  const dom = bootApp();
  assert.strictEqual(dom.window.LocalCalc.state.view, 'calc');
  assert.strictEqual($(dom, '#view-calc').hidden, false);
  assert.strictEqual($(dom, '#view-convert').hidden, true);
  assert.strictEqual($(dom, '#view-date').hidden, true);
  assert.strictEqual($(dom, '#view-history').hidden, true);
});

test('点击导航切换视图，只有目标视图可见（A2）', function () {
  const dom = bootApp();
  click(dom, '#nav [data-view="date"]');
  assert.strictEqual(dom.window.LocalCalc.state.view, 'date');
  assert.strictEqual($(dom, '#view-date').hidden, false);
  assert.strictEqual($(dom, '#view-calc').hidden, true);
  assert.strictEqual($(dom, '#view-convert').hidden, true);
  assert.strictEqual($(dom, '#view-history').hidden, true);
});

test('切换后当前导航项高亮，其他项不高亮', function () {
  const dom = bootApp();
  click(dom, '#nav [data-view="history"]');
  assert.ok($(dom, '#nav [data-view="history"]').classList.contains('active'));
  assert.ok(!$(dom, '#nav [data-view="calc"]').classList.contains('active'));
  assert.strictEqual($(dom, '#nav [data-view="history"]').getAttribute('aria-current'), 'page');
  assert.strictEqual($(dom, '#nav [data-view="calc"]').getAttribute('aria-current'), 'false');
});

test('切换视图会把 lastView 写入本地存储（A2）', function () {
  const dom = bootApp();
  click(dom, '#nav [data-view="convert"]');
  const saved = storeJson(dom, 'calcapp.settings.v1');
  assert.ok(saved, '设置没有写入本地存储');
  assert.strictEqual(saved.lastView, 'convert');
});

test('重新打开应用后回到上次停留的视图（A2、A3）', function () {
  const first = bootApp();
  click(first, '#nav [data-view="date"]');
  const persisted = first.window.localStorage.getItem('calcapp.settings.v1');

  const second = bootApp({ preload: { 'calcapp.settings.v1': persisted } });
  assert.strictEqual(second.window.LocalCalc.state.view, 'date');
  assert.strictEqual($(second, '#view-date').hidden, false);
  assert.ok($(second, '#nav [data-view="date"]').classList.contains('active'));
});

test('存储里的 lastView 非法时回到计算视图', function () {
  const dom = bootApp({
    preload: { 'calcapp.settings.v1': JSON.stringify({ version: 1, lastView: 'unknown' }) }
  });
  assert.strictEqual(dom.window.LocalCalc.state.view, 'calc');
});

test('历史数据在重开后依然存在（A3）', function () {
  const first = bootApp();
  first.window.LocalCalc.Store.addRecord('convert', '1 米 → 英尺', '3.28084', { category: 'length' });
  const persisted = first.window.localStorage.getItem('calcapp.history.v1');

  const second = bootApp({ preload: { 'calcapp.history.v1': persisted } });
  const items = second.window.LocalCalc.Store.loadHistory();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].result, '3.28084');
});

test('应用不引用任何网络资源，全程可离线运行（A4）', function () {
  assert.ok(!/fetch\s*\(/.test(appCode), 'app.js 中出现了 fetch 调用');
  assert.ok(!/XMLHttpRequest/.test(appCode), 'app.js 中出现了 XMLHttpRequest');
  assert.ok(!/import\s*\(/.test(appCode), 'app.js 中出现了动态 import');
  assert.ok(!/https?:\/\//.test(appCode), 'app.js 中出现了外部 URL');
  assert.ok(!/type\s*=\s*["']module["']/.test(htmlCode), 'index.html 中使用了 ES 模块');
  assert.ok(!/https?:\/\//.test(htmlCode), 'index.html 中出现了外部 URL');

  const refs = htmlCode.match(/(?:src|href)\s*=\s*"([^"]+)"/g) || [];
  refs.forEach(function (r) {
    const v = r.replace(/^.*?=\s*"/, '').replace(/"$/, '');
    assert.ok(!/^(https?:)?\/\//.test(v), 'index.html 引用了外部资源：' + v);
  });
});
/* ==================================================================
 * 步骤 2 · 计算引擎（纯逻辑）
 * ================================================================== */

const D = function (v) { return { t: 'digit', v: v }; };
const OPx = function (v) { return { t: 'op', v: v }; };
const DOT = { t: 'dot' };
const EQ = { t: 'equals' };
const BACK = { t: 'back' };
const CLEAR = { t: 'clear' };
const SIGN = { t: 'sign' };
const PCT = { t: 'percent' };

function inputSeq(str) {
  const out = [];
  String(str).split('').forEach(function (ch) { out.push(ch === '.' ? DOT : D(ch)); });
  return out;
}

/* 用一串记号驱动计算引擎，例如 '12 * 8 + 5 =' */
function run(LC, program) {
  const cs = LC.createCalcState();
  String(program).trim().split(/\s+/).forEach(function (tok) {
    if (tok === '=') { LC.calcApply(cs, EQ); return; }
    if (tok === 'C') { LC.calcApply(cs, CLEAR); return; }
    if (tok === '<') { LC.calcApply(cs, BACK); return; }
    if (tok === '+/-') { LC.calcApply(cs, SIGN); return; }
    if (tok === '%') { LC.calcApply(cs, PCT); return; }
    if (tok === '.') { LC.calcApply(cs, DOT); return; }
    if (tok.length === 1 && '+-*/'.indexOf(tok) >= 0) { LC.calcApply(cs, OPx(tok)); return; }
    if (/^\d+(\.\d+)?$/.test(tok)) { inputSeq(tok).forEach(function (a) { LC.calcApply(cs, a); }); return; }
    throw new Error('测试用例里出现了无法识别的记号：' + tok);
  });
  return cs;
}

stage(2, '步骤 2 · 计算引擎');

test('乘除优先于加减：12 × 8 + 5 = 101（A5）', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.evaluateItems([12, '*', 8, '+', 5]), 101);
  assert.strictEqual(LC.evaluateItems([1, '+', 2, '*', 3]), 7);
  assert.strictEqual(LC.evaluateItems([100, '-', 20, '/', 4]), 95);
});

test('逐键输入 12 × 8 + 5 得到 101，表达式完整（A5）', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '12 * 8 + 5 =');
  assert.strictEqual(cs.current, '101');
  assert.strictEqual(cs.lastExpression, '12 × 8 + 5');
  assert.ok(cs.justEvaluated);
  assert.strictEqual(cs.justEvaluated.result, '101');
});

test('浮点误差被消除：0.1 + 0.2 显示 0.3（A6）', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '0.1 + 0.2 =');
  assert.strictEqual(cs.current, '0.3');
  assert.strictEqual(LC.formatNumber(0.1 + 0.2), '0.3');
  assert.strictEqual(LC.formatNumber(12 * 8 + 5), '101');
  assert.strictEqual(LC.formatNumber(1 / 3), '0.333333333333');
});

test('除以零给出明确错误（A7）', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '1 / 0 =');
  assert.strictEqual(cs.error, LC.MSG.divZero);
  assert.strictEqual(cs.justEvaluated, null);
  assert.strictEqual(LC.calcDisplayText(cs, true), LC.MSG.divZero);
});

test('出错后按数字键自动恢复正常（A7）', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '1 / 0 =');
  LC.calcApply(cs, D('7'));
  assert.strictEqual(cs.error, null);
  assert.strictEqual(cs.current, '7');
});

test('连按等号不重复计算、不产生第二条结果（A10）', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '2 + 3 =');
  assert.strictEqual(cs.current, '5');
  assert.ok(cs.justEvaluated);
  LC.calcApply(cs, EQ);
  assert.strictEqual(cs.current, '5');
  assert.strictEqual(cs.justEvaluated, null);
});

test('连续按运算符时替换上一个运算符', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '8 + * 2 =');
  assert.strictEqual(cs.current, '16');
});

test('退格删除一位，删空后回到 0（A9）', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '123 <');
  assert.strictEqual(cs.current, '12');
  const cs2 = run(LC, '1 <');
  assert.strictEqual(cs2.current, '0');
  assert.strictEqual(cs2.typing, false);
});

test('在运算符状态按退格，回到上一个数继续编辑', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '12 + <');
  assert.strictEqual(cs.current, '12');
  assert.strictEqual(cs.entries.length, 0);
  assert.strictEqual(cs.typing, true);
});

test('按 C 清空全部输入（A9）', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '12 + 8 C');
  assert.strictEqual(cs.current, '0');
  assert.strictEqual(cs.entries.length, 0);
  assert.strictEqual(cs.done, false);
  assert.strictEqual(cs.error, null);
});

test('重复小数点被忽略，首位多余的 0 被替换', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(run(LC, '1 . 2 . 3').current, '1.23');
  assert.strictEqual(run(LC, '0 5').current, '5');
  assert.strictEqual(run(LC, '0 0 0 7').current, '7');
  assert.strictEqual(run(LC, '0 . 5').current, '0.5');
});

test('正负号可切换，0 不做处理', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(run(LC, '5 +/-').current, '-5');
  assert.strictEqual(run(LC, '5 +/- +/-').current, '5');
  assert.strictEqual(run(LC, '0 +/-').current, '0');
});

test('百分号：200 × 10% = 20', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(run(LC, '200 * 10 % =').current, '20');
});

test('百分号：1000 − 20% = 800，1000 + 20% = 1200', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(run(LC, '1000 - 20 % =').current, '800');
  assert.strictEqual(run(LC, '1000 + 20 % =').current, '1200');
  assert.strictEqual(run(LC, '50 %').current, '0.5');
});

test('结果可以继续参与运算', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(run(LC, '2 + 3 = * 4 =').current, '20');
});

test('结果后输入数字则开始新计算', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(run(LC, '2 + 3 = 7').current, '7');
  assert.strictEqual(run(LC, '2 + 3 = 7 =').current, '7');
});

test('千分位显示可开关', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '1234');
  assert.strictEqual(LC.calcDisplayText(cs, true), '1,234');
  assert.strictEqual(LC.calcDisplayText(cs, false), '1234');
  const big = run(LC, '1234567');
  assert.strictEqual(LC.calcDisplayText(big, true), '1,234,567');
});

test('超长数字改用科学计数法', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.formatNumber(1e16), '1e+16');
  assert.strictEqual(LC.formatNumber(123456789012345678), '1.23456789e+17');
  assert.strictEqual(LC.addThousands('1.5e+16'), '1.5e+16');
});

test('输入长度有上限，不会无限增长', function () {
  const LC = loadSandbox().LocalCalc;
  const cs = run(LC, '11111111111111111111');
  assert.strictEqual(cs.current.length, 16);
});

/* ==================================================================
 * 步骤 2 · 计算视图（真实 DOM）
 * ================================================================== */

function tapKey(dom, key, attr, val) {
  let sel = '#keypad [data-key="' + key + '"]';
  if (attr) sel = '#keypad [data-key="' + key + '"][' + attr + '="' + val + '"]';
  click(dom, sel);
}

/* 用点击的方式驱动计算器，例如 '12 * 8 + 5 =' */
function tapProgram(dom, program) {
  String(program).trim().split(/\s+/).forEach(function (tok) {
    if (tok === '=') { tapKey(dom, 'equals'); return; }
    if (tok === 'C') { tapKey(dom, 'clear'); return; }
    if (tok === '<') { tapKey(dom, 'back'); return; }
    if (tok === '+/-') { tapKey(dom, 'sign'); return; }
    if (tok === '%') { tapKey(dom, 'percent'); return; }
    if (tok === '.') { tapKey(dom, 'dot'); return; }
    if (tok.length === 1 && '+-*/'.indexOf(tok) >= 0) { tapKey(dom, 'op', 'data-op', tok); return; }
    if (/^\d+(\.\d+)?$/.test(tok)) {
      tok.split('').forEach(function (ch) {
        if (ch === '.') tapKey(dom, 'dot'); else tapKey(dom, 'digit', 'data-digit', ch);
      });
      return;
    }
    throw new Error('测试用例里出现了无法识别的记号：' + tok);
  });
}

function typeKey(dom, k) {
  const ev = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(ev);
  return ev;
}

function typeString(dom, s) { String(s).split('').forEach(function (ch) { typeKey(dom, ch); }); }

function mainText(dom) { return $(dom, '#calcMain').textContent; }
function exprText(dom) { return $(dom, '#calcExpr').textContent; }

stage(2, '步骤 2 · 计算视图（真实 DOM）');

test('鼠标点击键盘算出 12 × 8 + 5 = 101，显示与表达式都正确（A5）', function () {
  const dom = bootApp();
  tapProgram(dom, '12 * 8 + 5 =');
  assert.strictEqual(mainText(dom), '101');
  assert.strictEqual(exprText(dom), '12 × 8 + 5');
  assert.strictEqual($(dom, '#calcMain').classList.contains('is-error'), false);
});

test('键盘区包含 16 个按键且布局为 4 列 5 行', function () {
  const dom = bootApp();
  const keys = dom.window.document.querySelectorAll('#keypad .key');
  assert.strictEqual(keys.length, 20);
  assert.ok(/repeat\(4,/.test(fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')));
});

test('物理键盘输入 12*8+5 回车得到 101（A8）', function () {
  const dom = bootApp();
  typeString(dom, '12*8+5');
  typeKey(dom, 'Enter');
  assert.strictEqual(mainText(dom), '101');
  assert.strictEqual(exprText(dom), '12 × 8 + 5');
});

test('物理键盘的 Esc 清空、Backspace 退格（A9）', function () {
  const dom = bootApp();
  typeString(dom, '123');
  typeKey(dom, 'Backspace');
  assert.strictEqual(mainText(dom), '12');
  typeKey(dom, 'Escape');
  assert.strictEqual(mainText(dom), '0');
  assert.strictEqual(exprText(dom), '');
});

test('除以零时主显示给出提示，再按数字可恢复（A7）', function () {
  const dom = bootApp();
  tapProgram(dom, '5 / 0 =');
  assert.strictEqual(mainText(dom), dom.window.LocalCalc.MSG.divZero);
  assert.strictEqual($(dom, '#calcMain').classList.contains('is-error'), true);
  tapKey(dom, 'digit', 'data-digit', '7');
  assert.strictEqual(mainText(dom), '7');
  assert.strictEqual($(dom, '#calcMain').classList.contains('is-error'), false);
});

test('按等号成功写入一条历史，连按等号仍只有一条（A10、A24）', function () {
  const dom = bootApp();
  tapProgram(dom, '12 * 8 + 5 =');
  let items = dom.window.LocalCalc.Store.loadHistory();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, '12 × 8 + 5');
  assert.strictEqual(items[0].result, '101');
  assert.strictEqual(items[0].type, 'calc');

  tapKey(dom, 'equals');
  tapKey(dom, 'equals');
  items = dom.window.LocalCalc.Store.loadHistory();
  assert.strictEqual(items.length, 1);
});

test('算出错时不写历史', function () {
  const dom = bootApp();
  tapProgram(dom, '5 / 0 =');
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 0);
});

test('切到其他视图后物理键盘不再影响计算器', function () {
  const dom = bootApp();
  tapProgram(dom, '7');
  click(dom, '#nav [data-view="date"]');
  typeString(dom, '5');
  assert.strictEqual(dom.window.LocalCalc.state.calc.current, '7');
  click(dom, '#nav [data-view="calc"]');
  assert.strictEqual(mainText(dom), '7');
});

test('切走再切回来，已输入的内容不丢（PRD 2.3）', function () {
  const dom = bootApp();
  tapProgram(dom, '42');
  click(dom, '#nav [data-view="history"]');
  click(dom, '#nav [data-view="calc"]');
  assert.strictEqual(mainText(dom), '42');
});

test('点击键盘上的小数点和百分号都能正常响应', function () {
  const dom = bootApp();
  tapProgram(dom, '0 . 5 * 200 % =');
  assert.strictEqual(mainText(dom), '1');
  assert.strictEqual(exprText(dom), '0.5 × 2');
  tapProgram(dom, 'C 1 0 0 0 - 2 0 % =');
  assert.strictEqual(mainText(dom), '800');
});
/* ==================================================================
 * 步骤 3 · 换算引擎（纯逻辑）
 * ================================================================== */
stage(3, '步骤 3 · 换算引擎');

test('长度换算：1 米 → 英尺 = 3.28084（A11）', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.formatConvert(LC.convertValue('length', 'm', 'ft', 1)), '3.28084');
});

test('长度换算：1 米 = 100 厘米，1 英里 = 1.609344 千米', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.formatConvert(LC.convertValue('length', 'm', 'cm', 1)), '100');
  assert.strictEqual(LC.formatConvert(LC.convertValue('length', 'mi', 'km', 1)), '1.609344');
  assert.strictEqual(LC.formatConvert(LC.convertValue('length', 'cm', 'in', 2.54)), '1');
});

test('重量换算：1 千克 → 磅 = 2.204623', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.formatConvert(LC.convertValue('weight', 'kg', 'lb', 1)), '2.204623');
  assert.strictEqual(LC.formatConvert(LC.convertValue('weight', 'kg', 'g', 1)), '1000');
  assert.strictEqual(LC.formatConvert(LC.convertValue('weight', 't', 'kg', 1)), '1000');
});

test('温度换算：100 摄氏度 = 212 华氏度，0 摄氏度 = 32 华氏度（A12）', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.formatConvert(LC.convertValue('temperature', 'C', 'F', 100)), '212');
  assert.strictEqual(LC.formatConvert(LC.convertValue('temperature', 'C', 'F', 0)), '32');
  assert.strictEqual(LC.formatConvert(LC.convertValue('temperature', 'F', 'C', 212)), '100');
});

test('温度换算：-40 摄氏度 = -40 华氏度（A13）', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.formatConvert(LC.convertValue('temperature', 'C', 'F', -40)), '-40');
});

test('温度换算：摄氏与开尔文互换正确', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.formatConvert(LC.convertValue('temperature', 'C', 'K', 0)), '273.15');
  assert.strictEqual(LC.formatConvert(LC.convertValue('temperature', 'K', 'C', 273.15)), '0');
  assert.strictEqual(LC.formatConvert(LC.convertValue('temperature', 'F', 'K', 32)), '273.15');
});

test('面积与体积换算正确', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.formatConvert(LC.convertValue('area', 'm2', 'ft2', 1)), '10.76391');
  assert.strictEqual(LC.formatConvert(LC.convertValue('area', 'ha', 'm2', 1)), '10000');
  assert.strictEqual(LC.formatConvert(LC.convertValue('volume', 'L', 'galUS', 1)), '0.264172');
  assert.strictEqual(LC.formatConvert(LC.convertValue('volume', 'm3', 'L', 1)), '1000');
});

test('换算结果保留 6 位小数并去掉尾零，极小值改科学计数法', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.formatConvert(3.280839895013123), '3.28084');
  assert.strictEqual(LC.formatConvert(212), '212');
  assert.strictEqual(LC.formatConvert(0), '0');
  assert.strictEqual(LC.formatConvert(0.0000001), '1e-7');
  assert.strictEqual(LC.formatConvert(NaN), '');
});

test('往返换算自洽：米 → 英尺 → 米 回到原值', function () {
  const LC = loadSandbox().LocalCalc;
  const ft = LC.convertValue('length', 'm', 'ft', 3);
  assert.strictEqual(LC.formatConvert(LC.convertValue('length', 'ft', 'm', ft)), '3');
});

test('同一个单位之间换算等于自身', function () {
  const LC = loadSandbox().LocalCalc;
  ['length', 'weight', 'area', 'volume', 'temperature'].forEach(function (cat) {
    const key = LC.DEFAULT_UNIT_PAIR[cat][0];
    assert.strictEqual(LC.convertValue(cat, key, key, 7), 7);
  });
});

test('单位和类别的数据完整，与 PRD 清单一致', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.UNITS.length.units.length, 8);
  assert.strictEqual(LC.UNITS.weight.units.length, 6);
  assert.strictEqual(LC.UNITS.temperature.units.length, 3);
  assert.strictEqual(LC.UNITS.area.units.length, 7);
  assert.strictEqual(LC.UNITS.volume.units.length, 7);
  assert.strictEqual(LC.unitLabel('length', 'ft'), '英尺');
  assert.strictEqual(LC.unitLabel('temperature', 'K'), '开尔文');
});

test('温度不进系数表，非法单位返回 NaN', function () {
  const LC = loadSandbox().LocalCalc;
  assert.ok(LC.UNITS.temperature.units.every(function (u) { return u.factor === null; }));
  assert.ok(isNaN(LC.convertValue('length', 'm', '不存在', 1)));
  assert.ok(isNaN(LC.convertValue('不存在', 'm', 'ft', 1)));
  assert.ok(isNaN(LC.convertValue('temperature', 'C', '不存在', 1)));
});

test('输入解析能识别合法数字、空值、非法字符', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.parseNumericInput('1.5').value, 1.5);
  assert.strictEqual(LC.parseNumericInput('-40').value, -40);
  assert.strictEqual(LC.parseNumericInput('').empty, true);
  assert.strictEqual(LC.parseNumericInput('-').empty, true);
  assert.strictEqual(LC.parseNumericInput('.').empty, true);
  assert.strictEqual(LC.parseNumericInput('abc').ok, false);
  assert.strictEqual(LC.parseNumericInput('1.2.3').ok, false);
});

/* ==================================================================
 * 步骤 3 · 换算视图（真实 DOM）
 * ================================================================== */

function setInputValue(dom, sel, value) {
  const el = $(dom, sel);
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  return el;
}

function setSelectValue(dom, sel, value) {
  const el = $(dom, sel);
  el.value = value;
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  return el;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

stage(3, '步骤 3 · 换算视图（真实 DOM）');

test('默认进入换算是「米 ↔ 英尺」，1 米显示 3.28084', function () {
  const dom = bootApp();
  assert.strictEqual(dom.window.LocalCalc.state.convert.category, 'length');
  assert.strictEqual($(dom, '#convertFromUnit').value, 'm');
  assert.strictEqual($(dom, '#convertToUnit').value, 'ft');
  assert.strictEqual($(dom, '#convertLeft').value, '1');
  assert.strictEqual($(dom, '#convertRight').value, '3.28084');
  assert.ok($(dom, '#convertTabs [data-category="length"]').classList.contains('active'));
});

test('在任意一侧输入，另一侧实时更新（A11）', function () {
  const dom = bootApp();
  setInputValue(dom, '#convertLeft', '3');
  assert.strictEqual($(dom, '#convertRight').value, '9.84252');
  setInputValue(dom, '#convertRight', '10');
  assert.strictEqual($(dom, '#convertLeft').value, '3.048');
});

test('切换到温度类别后 100 摄氏度 = 212 华氏度（A12）', function () {
  const dom = bootApp();
  click(dom, '#convertTabs [data-category="temperature"]');
  assert.strictEqual($(dom, '#convertFromUnit').value, 'C');
  assert.strictEqual($(dom, '#convertToUnit').value, 'F');
  setInputValue(dom, '#convertLeft', '100');
  assert.strictEqual($(dom, '#convertRight').value, '212');
});

test('温度支持零下：输入 -40 摄氏度得到 -40 华氏度（A13）', function () {
  const dom = bootApp();
  click(dom, '#convertTabs [data-category="temperature"]');
  setInputValue(dom, '#convertLeft', '-40');
  assert.strictEqual($(dom, '#convertRight').value, '-40');
});

test('点互换按钮：单位交换、左侧数字保留、右侧按新单位重算（A14）', function () {
  const dom = bootApp();
  click(dom, '#convertSwap');
  assert.strictEqual($(dom, '#convertFromUnit').value, 'ft');
  assert.strictEqual($(dom, '#convertToUnit').value, 'm');
  assert.strictEqual($(dom, '#convertLeft').value, '1');
  assert.strictEqual($(dom, '#convertRight').value, '0.3048');
});

test('全部单位对照列出该类别所有单位与换算值（A15）', function () {
  const dom = bootApp();
  const rows = dom.window.document.querySelectorAll('#convertAllList .unit-all-row');
  assert.strictEqual(rows.length, 8);
  const text = $(dom, '#convertAllList').textContent;
  assert.ok(text.indexOf('毫米') >= 0 && text.indexOf('英里') >= 0, '缺少单位名称');
  const ftRow = Array.prototype.slice.call(rows).filter(function (r) {
    return r.textContent.indexOf('英尺') === 0;
  })[0];
  assert.ok(ftRow, '对照表里没有英尺');
  assert.ok(ftRow.textContent.indexOf('3.28084') >= 0, '英尺换算值不对：' + ftRow.textContent);
});

test('对照表可以折叠与展开', function () {
  const dom = bootApp();
  assert.strictEqual($(dom, '#convertAllList').hidden, false);
  click(dom, '#convertAllToggle');
  assert.strictEqual($(dom, '#convertAllList').hidden, true);
  assert.strictEqual($(dom, '#convertAllToggle').getAttribute('aria-expanded'), 'false');
  click(dom, '#convertAllToggle');
  assert.strictEqual($(dom, '#convertAllList').hidden, false);
});

test('输入留空时另一侧显示空白，不报错（A16）', function () {
  const dom = bootApp();
  setInputValue(dom, '#convertLeft', '');
  assert.strictEqual($(dom, '#convertRight').value, '');
  assert.strictEqual($(dom, '#convertLeft').classList.contains('invalid'), false);
});

test('输入非法字符时输入框标红且不计算（A16）', function () {
  const dom = bootApp();
  setInputValue(dom, '#convertLeft', '1');
  const before = $(dom, '#convertRight').value;
  setInputValue(dom, '#convertLeft', 'abc');
  assert.strictEqual($(dom, '#convertLeft').classList.contains('invalid'), true);
  assert.strictEqual($(dom, '#convertRight').value, before);
  setInputValue(dom, '#convertLeft', '2');
  assert.strictEqual($(dom, '#convertLeft').classList.contains('invalid'), false);
});

test('切换类别会载入该类别的默认单位对', function () {
  const dom = bootApp();
  click(dom, '#convertTabs [data-category="weight"]');
  assert.strictEqual($(dom, '#convertFromUnit').value, 'kg');
  assert.strictEqual($(dom, '#convertToUnit').value, 'lb');
  click(dom, '#convertTabs [data-category="volume"]');
  assert.strictEqual($(dom, '#convertFromUnit').value, 'L');
  assert.strictEqual($(dom, '#convertToUnit').value, 'galUS');
});

test('记住上次的类别与单位对，重开后恢复（A3）', function () {
  const first = bootApp();
  click(first, '#convertTabs [data-category="temperature"]');
  setSelectValue(first, '#convertFromUnit', 'K');
  const persisted = first.window.localStorage.getItem('calcapp.settings.v1');

  const second = bootApp({ preload: { 'calcapp.settings.v1': persisted } });
  assert.strictEqual(second.window.LocalCalc.state.convert.category, 'temperature');
  assert.strictEqual($(second, '#convertFromUnit').value, 'K');
  assert.strictEqual($(second, '#convertToUnit').value, 'F');
});

test('换算结果在停顿 800ms 后写入一条历史（A25）', async function () {
  const dom = bootApp();
  setInputValue(dom, '#convertLeft', '12');
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 0, '不应立即写入');
  await sleep(950);
  const items = dom.window.LocalCalc.Store.loadHistory();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].type, 'convert');
  assert.strictEqual(items[0].title, '12 米 → 英尺');
  assert.strictEqual(items[0].result, '39.370079');
  assert.strictEqual(items[0].detail.category, 'length');
});

test('连续输入只写一条历史，重复的同一数值不重复写（A25）', async function () {
  const dom = bootApp();
  setInputValue(dom, '#convertLeft', '1');
  setInputValue(dom, '#convertLeft', '12');
  setInputValue(dom, '#convertLeft', '123');
  await sleep(950);
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 1);

  setInputValue(dom, '#convertLeft', '123');
  await sleep(950);
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 1, '同一单位对同一数值重复写了');

  setInputValue(dom, '#convertLeft', '456');
  await sleep(950);
  const items = dom.window.LocalCalc.Store.loadHistory();
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, '456 米 → 英尺');
});

test('打开换算视图本身不产生历史记录', async function () {
  const dom = bootApp();
  click(dom, '#nav [data-view="convert"]');
  click(dom, '#convertTabs [data-category="area"]');
  await sleep(950);
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 0);
});

test('换算的页面元素齐全：五个类别标签、两个单位选择、两个数值框、互换按钮', function () {
  const dom = bootApp();
  assert.strictEqual(dom.window.document.querySelectorAll('#convertTabs .tab').length, 5);
  ['#convertFromUnit', '#convertToUnit', '#convertLeft', '#convertRight', '#convertSwap', '#convertAllToggle', '#convertAllList']
    .forEach(function (sel) { assert.ok($(dom, sel), '缺少元素：' + sel); });
});
/* ==================================================================
 * 步骤 4 · 日期引擎（纯逻辑）
 * ================================================================== */
stage(4, '步骤 4 · 日期引擎');

test('日期解析拒绝不存在的日期，且不使用 UTC 解析', function () {
  const LC = loadSandbox().LocalCalc;
  /* 跨 vm 沙箱时 Date 构造函数不是同一个，这里用行为判断而不是 instanceof */
  assert.strictEqual(Object.prototype.toString.call(LC.parseDate('2026-10-13')), '[object Date]');
  assert.strictEqual(LC.formatDate(LC.parseDate('2026-10-13')), '2026-10-13');
  assert.strictEqual(LC.parseDate('2026-02-30'), null);
  assert.strictEqual(LC.parseDate('2026-13-01'), null);
  assert.strictEqual(LC.parseDate('2026-10'), null);
  assert.strictEqual(LC.parseDate(''), null);
  assert.strictEqual(LC.parseDate('不是日期'), null);
  /* 若误用 new Date('2026-10-13')，在东八区会得到 10 月 12 日 */
  assert.strictEqual(LC.parseDate('2026-10-13').getDate(), 13);
  assert.strictEqual(LC.parseDate('2026-01-01').getFullYear(), 2026);
});

test('相差天数与含首日天数（A17）', function () {
  const LC = loadSandbox().LocalCalc;
  const res = LC.computeDateDiff('2026-10-13', '2026-11-01');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.days, 19);
  assert.strictEqual(res.includeFirst, 20);
  assert.strictEqual(res.reversed, false);
});

test('相差结果折合周与天', function () {
  const LC = loadSandbox().LocalCalc;
  const res = LC.computeDateDiff('2026-10-13', '2026-11-01');
  assert.strictEqual(res.weeks, 2);
  assert.strictEqual(res.restDays, 5);
  assert.strictEqual(res.months, 0.6);
});

test('结束日期早于起始日期时结果为负数并标记（A18）', function () {
  const LC = loadSandbox().LocalCalc;
  const res = LC.computeDateDiff('2026-11-01', '2026-10-13');
  assert.strictEqual(res.days, -19);
  assert.strictEqual(res.reversed, true);
});

test('同一天的相差为 0 天，含首日 1 天', function () {
  const LC = loadSandbox().LocalCalc;
  const res = LC.computeDateDiff('2026-10-13', '2026-10-13');
  assert.strictEqual(res.days, 0);
  assert.strictEqual(res.includeFirst, 1);
});

test('日期未填全或非法时返回不可计算', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.computeDateDiff('', '2026-10-13').ok, false);
  assert.strictEqual(LC.computeDateDiff('2026-10-13', '2026-02-30').ok, false);
});

test('月末加月取目标月最后一天：2026-01-31 + 1 月 = 2026-02-28（A19）', function () {
  const LC = loadSandbox().LocalCalc;
  const res = LC.computeDateShift('2026-01-31', 1, '1', 'month');
  assert.strictEqual(res.date, '2026-02-28');
});

test('闰年月末：2024-01-31 + 1 月 = 2024-02-29（A20）', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.computeDateShift('2024-01-31', 1, '1', 'month').date, '2024-02-29');
  assert.strictEqual(LC.computeDateShift('2024-02-29', 1, '1', 'year').date, '2025-02-28');
});

test('日期加减天数：2026-10-13 之后 30 天 = 2026-11-12 周四（A21）', function () {
  const LC = loadSandbox().LocalCalc;
  const res = LC.computeDateShift('2026-10-13', 1, '30', 'day');
  assert.strictEqual(res.date, '2026-11-12');
  assert.strictEqual(res.weekday, '周四');
});

test('日期加减支持「之前」与周、月、年单位', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.computeDateShift('2026-10-13', -1, '30', 'day').date, '2026-09-13');
  assert.strictEqual(LC.computeDateShift('2026-10-13', 1, '2', 'week').date, '2026-10-27');
  assert.strictEqual(LC.computeDateShift('2026-10-13', 1, '1', 'year').date, '2027-10-13');
  assert.strictEqual(LC.computeDateShift('2026-10-13', -1, '1', 'month').date, '2026-09-13');
});

test('加减数值非法时返回失败并标记（A23 边界）', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.computeDateShift('2026-10-13', 1, 'abc', 'day').ok, false);
  assert.strictEqual(LC.computeDateShift('2026-10-13', 1, '-5', 'day').badAmount, true);
  assert.strictEqual(LC.computeDateShift('2026-10-13', 1, '3', '不明单位').ok, false);
  assert.strictEqual(LC.computeDateShift('', 1, '3', 'day').ok, false);
});

test('精确年龄按整月锚点推算，1 月 31 日到 3 月 1 日 = 1 个月 1 天', function () {
  const LC = loadSandbox().LocalCalc;
  const res = LC.ageFrom(LC.parseDate('2000-01-31'), LC.parseDate('2000-03-01'));
  sameJson(res, { y: 0, m: 1, d: 1 });

  const res2 = LC.ageFrom(LC.parseDate('1995-06-18'), LC.parseDate('2026-10-13'));
  sameJson(res2, { y: 31, m: 3, d: 25 });

  const res3 = LC.ageFrom(LC.parseDate('2000-01-01'), LC.parseDate('2000-01-31'));
  sameJson(res3, { y: 0, m: 0, d: 30 });
});

test('2 月 29 日出生的周年在非闰年按 3 月 1 日算（A22）', function () {
  const LC = loadSandbox().LocalCalc;
  const birth = LC.parseDate('2000-02-29');
  assert.strictEqual(LC.formatDate(LC.anniversaryDate(birth, 2026)), '2026-03-01');
  assert.strictEqual(LC.formatDate(LC.anniversaryDate(birth, 2024)), '2024-02-29');
  assert.strictEqual(LC.formatDate(LC.anniversaryDate(birth, 2027)), '2027-03-01');
});

test('下次周年：当年已过则取次年', function () {
  const LC = loadSandbox().LocalCalc;
  const birth = LC.parseDate('1995-06-18');
  assert.strictEqual(LC.formatDate(LC.nextAnniversary(birth, LC.parseDate('2026-03-01'))), '2026-06-18');
  assert.strictEqual(LC.formatDate(LC.nextAnniversary(birth, LC.parseDate('2026-10-13'))), '2027-06-18');
});

test('年龄计算给出精确年龄、已过天数与下次周年倒计时（A22）', function () {
  const LC = loadSandbox().LocalCalc;
  const res = LC.computeAge('2000-02-29', '2026-10-13');
  assert.strictEqual(res.ok, true);
  sameJson(res.age, { y: 26, m: 7, d: 14 });
  assert.strictEqual(res.passedDays, LC.daysBetween(LC.parseDate('2000-02-29'), LC.parseDate('2026-10-13')));
  assert.strictEqual(res.nextDate, '2027-03-01');
  assert.strictEqual(res.nextWeekday, '周一');
  assert.ok(res.nextDays > 0);
});

test('年龄未填出生日期时不可计算（A23）', function () {
  const LC = loadSandbox().LocalCalc;
  assert.strictEqual(LC.computeAge('', '2026-10-13').ok, false);
  assert.strictEqual(LC.computeAge('2026-02-30', '2026-10-13').ok, false);
});

/* ==================================================================
 * 步骤 4 · 日期视图（真实 DOM）
 * ================================================================== */

function resultRows(dom, sel) {
  const rows = dom.window.document.querySelectorAll(sel + ' .result-row');
  const out = {};
  Array.prototype.forEach.call(rows, function (r) {
    out[r.querySelector('.result-key').textContent] = r.querySelector('.result-val').textContent;
  });
  return out;
}

stage(4, '步骤 4 · 日期视图（真实 DOM）');

test('日期视图三张卡片与输入元素齐全', function () {
  const dom = bootApp();
  ['#diffStart', '#diffEnd', '#diffResult', '#shiftStart', '#shiftDir', '#shiftAmount', '#shiftUnit', '#shiftResult', '#ageBirth', '#ageResult']
    .forEach(function (sel) { assert.ok($(dom, sel), '缺少元素：' + sel); });
  assert.strictEqual(dom.window.document.querySelectorAll('#view-date .card').length, 3);
});

test('起始与结束日期默认为今天，加减默认之后 30 天', function () {
  const dom = bootApp();
  const today = dom.window.LocalCalc.todayStr();
  assert.strictEqual($(dom, '#diffStart').value, today);
  assert.strictEqual($(dom, '#diffEnd').value, today);
  assert.strictEqual($(dom, '#shiftStart').value, today);
  assert.strictEqual($(dom, '#shiftAmount').value, '30');
  assert.strictEqual($(dom, '#shiftDir').value, '1');
  assert.strictEqual($(dom, '#shiftUnit').value, 'day');
  assert.strictEqual($(dom, '#ageBirth').value, '');
});

test('相差：2026-10-13 到 2026-11-01 显示 19 天（A17）', function () {
  const dom = bootApp();
  setInputValue(dom, '#diffStart', '2026-10-13');
  setInputValue(dom, '#diffEnd', '2026-11-01');
  const rows = resultRows(dom, '#diffResult');
  assert.strictEqual(rows['相差'], '19 天');
  assert.strictEqual(rows['含首日'], '20 天');
  assert.strictEqual(rows['折合'], '2 周 5 天');
  assert.strictEqual(rows['约合'], '0.6 个月');
});

test('相差：结束早于起始时显示负数并给出提示（A18）', function () {
  const dom = bootApp();
  setInputValue(dom, '#diffStart', '2026-11-01');
  setInputValue(dom, '#diffEnd', '2026-10-13');
  const rows = resultRows(dom, '#diffResult');
  assert.strictEqual(rows['相差'], '-19 天');
  assert.strictEqual(rows['提示'], '结束日期早于起始日期');
});

test('加减：2026-01-31 之后 1 个月得到 2026-02-28（A19）', function () {
  const dom = bootApp();
  setInputValue(dom, '#shiftStart', '2026-01-31');
  setInputValue(dom, '#shiftUnit', 'month');
  setInputValue(dom, '#shiftAmount', '1');
  const rows = resultRows(dom, '#shiftResult');
  assert.strictEqual(rows['结果日期'], '2026-02-28');
});

test('加减：2024-01-31 之后 1 个月得到 2024-02-29（A20）', function () {
  const dom = bootApp();
  setInputValue(dom, '#shiftStart', '2024-01-31');
  setInputValue(dom, '#shiftUnit', 'month');
  setInputValue(dom, '#shiftAmount', '1');
  assert.strictEqual(resultRows(dom, '#shiftResult')['结果日期'], '2024-02-29');
});

test('加减：2026-10-13 之后 30 天得到 2026-11-12 周四（A21）', function () {
  const dom = bootApp();
  setInputValue(dom, '#shiftStart', '2026-10-13');
  setInputValue(dom, '#shiftAmount', '30');
  const rows = resultRows(dom, '#shiftResult');
  assert.strictEqual(rows['结果日期'], '2026-11-12');
  assert.strictEqual(rows['星期'], '周四');
  assert.strictEqual($(dom, '#shiftAmount').classList.contains('invalid'), false);
});

test('加减：切到「之前」方向后结果方向相反', function () {
  const dom = bootApp();
  setInputValue(dom, '#shiftStart', '2026-10-13');
  setInputValue(dom, '#shiftAmount', '30');
  setInputValue(dom, '#shiftDir', '-1');
  assert.strictEqual(resultRows(dom, '#shiftResult')['结果日期'], '2026-09-13');
});

test('加减：数值非法时输入框标红且结果显示 —（A23 边界）', function () {
  const dom = bootApp();
  setInputValue(dom, '#shiftAmount', 'abc');
  assert.strictEqual($(dom, '#shiftAmount').classList.contains('invalid'), true);
  assert.strictEqual(resultRows(dom, '#shiftResult')['结果日期'], '—');
  setInputValue(dom, '#shiftAmount', '10');
  assert.strictEqual($(dom, '#shiftAmount').classList.contains('invalid'), false);
});

test('日期未填全时结果显示 —，页面不报错（A23）', function () {
  const dom = bootApp();
  setInputValue(dom, '#diffStart', '');
  assert.strictEqual(resultRows(dom, '#diffResult')['结果'], '—');
  assert.strictEqual(resultRows(dom, '#ageResult')['结果'], '—');
});

test('年龄：2000-02-29 出生者的周年按 3 月 1 日计算（A22）', function () {
  const dom = bootApp();
  setInputValue(dom, '#ageBirth', '2000-02-29');
  const rows = resultRows(dom, '#ageResult');
  assert.ok(/^\d+ 年 \d+ 月 \d+ 天$/.test(rows['年龄']), '年龄格式不对：' + rows['年龄']);
  assert.ok(/^\d+ 天$/.test(rows['已经过去']), '已过天数格式不对');
  assert.ok(rows['下次周年'].indexOf('-03-01') > 0, '周年日期应落在 3 月 1 日：' + rows['下次周年']);
});

test('日期计算在停顿后写入历史，且同一组参数不重复写', async function () {
  const dom = bootApp();
  setInputValue(dom, '#diffStart', '2026-10-13');
  setInputValue(dom, '#diffEnd', '2026-11-01');
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 0, '不应立即写入');
  await sleep(950);
  let items = dom.window.LocalCalc.Store.loadHistory();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].type, 'date');
  assert.strictEqual(items[0].title, '2026-10-13 → 2026-11-01');
  assert.strictEqual(items[0].result, '19 天');
  assert.strictEqual(items[0].detail.mode, 'diff');

  setInputValue(dom, '#diffEnd', '2026-11-01');
  await sleep(950);
  items = dom.window.LocalCalc.Store.loadHistory();
  assert.strictEqual(items.length, 1, '同一组参数重复写了');
});

test('加减与年龄的输入同样会写入历史', async function () {
  const dom = bootApp();
  setInputValue(dom, '#shiftStart', '2026-10-13');
  setInputValue(dom, '#shiftAmount', '30');
  await sleep(950);
  let items = dom.window.LocalCalc.Store.loadHistory();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, '2026-10-13 之后 30 天');
  assert.strictEqual(items[0].result, '2026-11-12 周四');

  setInputValue(dom, '#ageBirth', '1995-06-18');
  await sleep(950);
  items = dom.window.LocalCalc.Store.loadHistory();
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].type, 'date');
  assert.strictEqual(items[0].detail.mode, 'age');
});

test('日期输入会被记住，重开后恢复', function () {
  const first = bootApp();
  setInputValue(first, '#diffStart', '2026-10-13');
  setInputValue(first, '#diffEnd', '2026-11-01');
  const persisted = first.window.localStorage.getItem('calcapp.settings.v1');

  const second = bootApp({ preload: { 'calcapp.settings.v1': persisted } });
  assert.strictEqual($(second, '#diffStart').value, '2026-10-13');
  assert.strictEqual($(second, '#diffEnd').value, '2026-11-01');
});
/* ==================================================================
 * 步骤 5 · 历史视图（真实 DOM）
 * ================================================================== */
stage(5, '步骤 5 · 历史视图');

function historyRows(dom) {
  return Array.prototype.slice.call(dom.window.document.querySelectorAll('#historyList .history-row')).map(function (r) {
    return {
      id: r.getAttribute('data-id'),
      title: r.querySelector('.history-title').textContent,
      meta: r.querySelector('.history-meta').textContent,
      result: r.querySelector('.history-result').textContent
    };
  });
}

function emptyText(dom) {
  const el = $(dom, '#historyList .history-empty');
  return el ? el.textContent : null;
}

function addRecords(dom, list) {
  const S = dom.window.LocalCalc.Store;
  list.forEach(function (r) { S.addRecord(r[0], r[1], r[2], r[3] || {}); });
}

test('没有记录时显示空状态文案（A24 前置）', function () {
  const dom = bootApp();
  click(dom, '#nav [data-view="history"]');
  assert.strictEqual(historyRows(dom).length, 0);
  assert.strictEqual(emptyText(dom), dom.window.LocalCalc.MSG.emptyHistory);
  assert.strictEqual($(dom, '#historyClear').disabled, true);
});

test('算完之后历史视图显示表达式、结果、类型与时间（A24）', function () {
  const dom = bootApp();
  tapProgram(dom, '12 * 8 + 5 =');
  click(dom, '#nav [data-view="history"]');
  const rows = historyRows(dom);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].title, '12 × 8 + 5');
  assert.strictEqual(rows[0].result, '101');
  assert.ok(rows[0].meta.indexOf('计算') === 0, '类型标注不对：' + rows[0].meta);
  assert.ok(/今天 \d{2}:\d{2}/.test(rows[0].meta), '时间格式不对：' + rows[0].meta);
});

test('三类记录都会出现在历史里，且最新的排在最上面', function () {
  const dom = bootApp();
  addRecords(dom, [
    ['calc', '第一条 · 计算', '1', {}],
    ['convert', '第二条 · 换算', '2', { category: 'length', from: 'm', to: 'ft', value: 1 }],
    ['date', '第三条 · 日期', '3 天', { mode: 'diff', start: '2026-10-13', end: '2026-10-16' }]
  ]);
  click(dom, '#nav [data-view="history"]');
  const rows = historyRows(dom);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].title, '第三条 · 日期');
  assert.strictEqual(rows[1].title, '第二条 · 换算');
  assert.strictEqual(rows[2].title, '第一条 · 计算');
  assert.ok(rows[0].meta.indexOf('日期') === 0);
  assert.ok(rows[1].meta.indexOf('换算') === 0);
});

test('搜索按表达式匹配（A26）', function () {
  const dom = bootApp();
  addRecords(dom, [
    ['calc', '12 × 8 + 5', '101', {}],
    ['calc', '7 + 3', '10', {}]
  ]);
  click(dom, '#nav [data-view="history"]');
  setInputValue(dom, '#historySearch', '12 ×');
  const rows = historyRows(dom);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].result, '101');
});

test('搜索按结果匹配且不区分大小写（A26）', function () {
  const dom = bootApp();
  addRecords(dom, [
    ['calc', '12 × 8 + 5', '101', {}],
    ['convert', '1 米 → 英尺', '3.28084', { category: 'length', from: 'm', to: 'ft', value: 1 }]
  ]);
  click(dom, '#nav [data-view="history"]');
  setInputValue(dom, '#historySearch', '3.28084');
  assert.strictEqual(historyRows(dom).length, 1);
  setInputValue(dom, '#historySearch', '101');
  assert.strictEqual(historyRows(dom).length, 1);
});

test('搜索无结果时显示另一条提示', function () {
  const dom = bootApp();
  addRecords(dom, [['calc', '1 + 1', '2', {}]]);
  click(dom, '#nav [data-view="history"]');
  setInputValue(dom, '#historySearch', '找不到的关键词');
  assert.strictEqual(historyRows(dom).length, 0);
  assert.strictEqual(emptyText(dom), dom.window.LocalCalc.MSG.noMatch);
});

test('类型筛选只显示对应类型（A27）', function () {
  const dom = bootApp();
  addRecords(dom, [
    ['calc', '计算记录', '1', {}],
    ['convert', '换算记录', '2', { category: 'length', from: 'm', to: 'ft', value: 1 }],
    ['date', '日期记录', '3', { mode: 'diff', start: '2026-10-13', end: '2026-10-16' }]
  ]);
  click(dom, '#nav [data-view="history"]');
  click(dom, '#historyFilter [data-filter="convert"]');
  let rows = historyRows(dom);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].title, '换算记录');

  click(dom, '#historyFilter [data-filter="date"]');
  rows = historyRows(dom);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].title, '日期记录');

  click(dom, '#historyFilter [data-filter="all"]');
  assert.strictEqual(historyRows(dom).length, 3);
  assert.ok($(dom, '#historyFilter [data-filter="all"]').classList.contains('active'));
});

test('单条删除后该记录消失，重开应用也不会回来（A28）', function () {
  const dom = bootApp();
  addRecords(dom, [
    ['calc', '保留的记录', '1', {}],
    ['calc', '要删的记录', '2', {}]
  ]);
  click(dom, '#nav [data-view="history"]');
  const rows = historyRows(dom);
  assert.strictEqual(rows[0].title, '要删的记录');

  click(dom, '#historyList [data-del="' + rows[0].id + '"]');
  const left = historyRows(dom);
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].title, '保留的记录');

  const persisted = dom.window.localStorage.getItem('calcapp.history.v1');
  const second = bootApp({ preload: { 'calcapp.history.v1': persisted } });
  click(second, '#nav [data-view="history"]');
  const rows2 = historyRows(second);
  assert.strictEqual(rows2.length, 1);
  assert.strictEqual(rows2[0].title, '保留的记录');
});

test('点「清空全部」会弹出二次确认，取消则不清空（A29）', async function () {
  const dom = bootApp();
  addRecords(dom, [['calc', '唯一一条', '1', {}]]);
  click(dom, '#nav [data-view="history"]');
  click(dom, '#historyClear');

  assert.strictEqual($(dom, '#confirmOverlay').hidden, false);
  assert.strictEqual($(dom, '#confirmText').textContent, '确定清空全部 1 条记录？此操作无法撤销。');

  click(dom, '#confirmCancel');
  await sleep(0);
  assert.strictEqual($(dom, '#confirmOverlay').hidden, true);
  assert.strictEqual(historyRows(dom).length, 1);
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 1);
});

test('确认清空后列表与存储都清空，按钮变为不可用（A29）', async function () {
  const dom = bootApp();
  addRecords(dom, [['calc', 'A', '1', {}], ['calc', 'B', '2', {}]]);
  click(dom, '#nav [data-view="history"]');
  click(dom, '#historyClear');
  assert.strictEqual($(dom, '#confirmText').textContent, '确定清空全部 2 条记录？此操作无法撤销。');
  click(dom, '#confirmOk');
  await sleep(0);

  assert.strictEqual(historyRows(dom).length, 0);
  assert.strictEqual(emptyText(dom), dom.window.LocalCalc.MSG.emptyHistory);
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 0);
  assert.strictEqual($(dom, '#historyClear').disabled, true);
});

test('点计算记录：回到计算视图并还原表达式，按等号可重算（A30）', function () {
  const dom = bootApp();
  addRecords(dom, [['calc', '12 × 8 + 5', '101', { expression: '12 × 8 + 5' }]]);
  click(dom, '#nav [data-view="history"]');
  click(dom, '#historyList [data-open="' + historyRows(dom)[0].id + '"]');

  assert.strictEqual(dom.window.LocalCalc.state.view, 'calc');
  assert.strictEqual($(dom, '#view-calc').hidden, false);
  assert.strictEqual(exprText(dom), '12 × 8 + 5');
  assert.strictEqual(mainText(dom), '5');
  tapKey(dom, 'equals');
  assert.strictEqual(mainText(dom), '101');
});

test('点换算记录：回到换算视图并还原类别、单位与数值（A30）', function () {
  const dom = bootApp();
  addRecords(dom, [['convert', '100 摄氏度 → 华氏度', '212',
    { category: 'temperature', from: 'C', to: 'F', value: 100 }]]);
  click(dom, '#nav [data-view="history"]');
  click(dom, '#historyList [data-open="' + historyRows(dom)[0].id + '"]');

  assert.strictEqual(dom.window.LocalCalc.state.view, 'convert');
  assert.strictEqual($(dom, '#convertFromUnit').value, 'C');
  assert.strictEqual($(dom, '#convertToUnit').value, 'F');
  assert.strictEqual($(dom, '#convertLeft').value, '100');
  assert.strictEqual($(dom, '#convertRight').value, '212');
  assert.ok($(dom, '#convertTabs [data-category="temperature"]').classList.contains('active'));
});

test('点日期记录：回到日期视图并还原参数（A30）', function () {
  const dom = bootApp();
  addRecords(dom, [['date', '2026-10-13 → 2026-11-01', '19 天',
    { mode: 'diff', start: '2026-10-13', end: '2026-11-01' }]]);
  click(dom, '#nav [data-view="history"]');
  click(dom, '#historyList [data-open="' + historyRows(dom)[0].id + '"]');

  assert.strictEqual(dom.window.LocalCalc.state.view, 'date');
  assert.strictEqual($(dom, '#diffStart').value, '2026-10-13');
  assert.strictEqual($(dom, '#diffEnd').value, '2026-11-01');
  assert.strictEqual(resultRows(dom, '#diffResult')['相差'], '19 天');
});

test('回填日期加减记录时方向、数值与单位都被还原', function () {
  const dom = bootApp();
  addRecords(dom, [['date', '2026-10-13 之前 7 天', '2026-10-06 周二',
    { mode: 'shift', start: '2026-10-13', dir: -1, amount: 7, unit: 'day' }]]);
  click(dom, '#nav [data-view="history"]');
  click(dom, '#historyList [data-open="' + historyRows(dom)[0].id + '"]');

  assert.strictEqual($(dom, '#shiftStart').value, '2026-10-13');
  assert.strictEqual($(dom, '#shiftDir').value, '-1');
  assert.strictEqual($(dom, '#shiftAmount').value, '7');
  assert.strictEqual($(dom, '#shiftUnit').value, 'day');
  assert.strictEqual(resultRows(dom, '#shiftResult')['结果日期'], '2026-10-06');
});

test('历史视图在每次进入时都会从存储重新读取', function () {
  const dom = bootApp();
  click(dom, '#nav [data-view="history"]');
  assert.strictEqual(historyRows(dom).length, 0);
  dom.window.LocalCalc.Store.addRecord('calc', '外部新增', '1', {});
  click(dom, '#nav [data-view="calc"]');
  click(dom, '#nav [data-view="history"]');
  assert.strictEqual(historyRows(dom).length, 1);
  assert.strictEqual(historyRows(dom)[0].title, '外部新增');
});

test('历史上限生效：超过上限只保留最新若干条（A34）', function () {
  const dom = bootApp();
  dom.window.LocalCalc.Store.saveSettings({ historyLimit: 10 });
  for (let i = 1; i <= 12; i++) {
    dom.window.LocalCalc.Store.addRecord('calc', '第 ' + i + ' 条', String(i), {});
  }
  click(dom, '#nav [data-view="history"]');
  const rows = historyRows(dom);
  assert.strictEqual(rows.length, 10);
  assert.strictEqual(rows[0].title, '第 12 条');
  assert.strictEqual(rows[9].title, '第 3 条');
});
/* ==================================================================
 * 步骤 6 · 设置、备份恢复与收尾
 * ================================================================== */
stage(6, '步骤 6 · 设置面板');

async function waitFor(fn, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 1500)) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

test('设置面板默认隐藏，可打开、可关闭，Esc 也能关', function () {
  const dom = bootApp();
  assert.strictEqual($(dom, '#settingsOverlay').hidden, true);
  click(dom, '#settingsToggle');
  assert.strictEqual($(dom, '#settingsOverlay').hidden, false);
  click(dom, '#settingsClose');
  assert.strictEqual($(dom, '#settingsOverlay').hidden, true);

  click(dom, '#settingsToggle');
  typeKey(dom, '5');
  assert.strictEqual(mainText(dom), '0', '面板打开时物理键盘不应作用于计算器');
  typeKey(dom, 'Escape');
  assert.strictEqual($(dom, '#settingsOverlay').hidden, true, 'Esc 应关闭设置面板');
  typeString(dom, '7');
  assert.strictEqual(mainText(dom), '7', '关闭面板后计算器应恢复可用');
});

test('设置面板元素齐全', function () {
  const dom = bootApp();
  ['#setThousand', '#setLimit', '#setCount', '#backupExport', '#backupImport', '#backupFile', '#settingsClearAll', '#settingsClose']
    .forEach(function (sel) { assert.ok($(dom, sel), '缺少元素：' + sel); });
});

test('关闭千分位后显示不再分隔，重开后设置仍然生效（A36）', function () {
  const dom = bootApp();
  tapProgram(dom, '1234');
  assert.strictEqual(mainText(dom), '1,234');

  click(dom, '#settingsToggle');
  const cb = $(dom, '#setThousand');
  cb.checked = false;
  cb.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.strictEqual(mainText(dom), '1234');

  const persisted = dom.window.localStorage.getItem('calcapp.settings.v1');
  const second = bootApp({ preload: { 'calcapp.settings.v1': persisted } });
  tapProgram(second, '1234');
  assert.strictEqual(mainText(second), '1234');
  click(second, '#settingsToggle');
  assert.strictEqual($(second, '#setThousand').checked, false);
});

test('历史上限填非法值时提示并回退到原值', function () {
  const dom = bootApp();
  click(dom, '#settingsToggle');
  const el = $(dom, '#setLimit');
  el.value = '0';
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.strictEqual($(dom, '#notice').hidden, false);
  assert.strictEqual($(dom, '#notice').textContent, dom.window.LocalCalc.MSG.limitInvalid);
  assert.strictEqual(el.value, '500');
  assert.strictEqual(dom.window.LocalCalc.state.settings.historyLimit, 500);
});

test('调低历史上限后立即裁剪已有记录（A34）', function () {
  const dom = bootApp();
  for (let i = 1; i <= 6; i++) dom.window.LocalCalc.Store.addRecord('calc', '第 ' + i + ' 条', String(i), {});
  click(dom, '#settingsToggle');
  const el = $(dom, '#setLimit');
  el.value = '3';
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 3);
  click(dom, '#settingsClose');
  click(dom, '#nav [data-view="history"]');
  assert.strictEqual(historyRows(dom).length, 3);
  assert.strictEqual(historyRows(dom)[0].title, '第 6 条');
});

test('设置面板显示当前数据量', function () {
  const dom = bootApp();
  assert.strictEqual($(dom, '#setCount').textContent, '已存 0 条记录');
  addRecords(dom, [['calc', 'A', '1', {}], ['calc', 'B', '2', {}]]);
  click(dom, '#settingsToggle');
  assert.strictEqual($(dom, '#setCount').textContent, '已存 2 条记录');
});

stage(6, '步骤 6 · 备份与恢复');

test('备份内容包含版本、导出时间、设置与历史，文件名带日期（A31）', function () {
  const dom = bootApp();
  addRecords(dom, [['calc', '12 × 8 + 5', '101', { expression: '12 × 8 + 5' }]]);
  const b = dom.window.LocalCalc.buildBackup();
  assert.strictEqual(b.payload.app, 'local-calculator');
  assert.strictEqual(b.payload.version, 1);
  assert.ok(typeof b.payload.exportedAt === 'string' && b.payload.exportedAt.length > 0);
  assert.strictEqual(b.payload.history.length, 1);
  assert.strictEqual(b.payload.history[0].result, '101');
  assert.strictEqual(b.payload.settings.historyLimit, 500);
  assert.strictEqual(b.fileName, 'calculator-backup-' + dom.window.LocalCalc.todayStr() + '.json');
  assert.strictEqual(JSON.parse(b.text).history[0].title, '12 × 8 + 5');
});

test('点「导出备份」不会报错，并给出完成提示（A31）', function () {
  const dom = bootApp();
  click(dom, '#settingsToggle');
  let error = null;
  try { click(dom, '#backupExport'); } catch (e) { error = e; }
  assert.strictEqual(error, null);
  assert.strictEqual($(dom, '#notice').hidden, false);
  assert.strictEqual($(dom, '#notice').textContent, dom.window.LocalCalc.MSG.exportDone);
});

test('清空后导入备份，记录与设置都恢复（A32）', async function () {
  const dom = bootApp();
  addRecords(dom, [['calc', '要备份的记录', '101', { expression: '12 × 8 + 5' }]]);
  const text = dom.window.LocalCalc.buildBackup().text;

  dom.window.LocalCalc.Store.clearHistory();
  click(dom, '#nav [data-view="history"]');
  assert.strictEqual(historyRows(dom).length, 0);

  const p = dom.window.LocalCalc.importBackupText(text);
  await waitFor(function () { return !$(dom, '#confirmOverlay').hidden; });
  assert.strictEqual($(dom, '#confirmText').textContent, dom.window.LocalCalc.MSG.importConfirm);
  click(dom, '#confirmOk');
  const res = await p;

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 1);
  assert.strictEqual(historyRows(dom).length, 1);
  assert.strictEqual(historyRows(dom)[0].result, '101');
  assert.strictEqual($(dom, '#notice').textContent, '已恢复 1 条记录');
});

test('导入时取消二次确认则不改动任何数据（A32）', async function () {
  const dom = bootApp();
  addRecords(dom, [['calc', '原有记录', '1', {}]]);
  const text = dom.window.LocalCalc.buildBackup().text;
  dom.window.LocalCalc.Store.addRecord('calc', '导入后不该出现', '9', {});
  const before = dom.window.LocalCalc.Store.loadHistory();

  const p = dom.window.LocalCalc.importBackupText(text);
  await waitFor(function () { return !$(dom, '#confirmOverlay').hidden; });
  click(dom, '#confirmCancel');
  const res = await p;

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'cancel');
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, before.length);
});

test('导入内容不是合法 JSON 时提示格式错误且不破坏现有数据（A33）', async function () {
  const dom = bootApp();
  addRecords(dom, [['calc', '原有记录', '1', {}]]);
  const res = await dom.window.LocalCalc.importBackupText('{这不是合法 JSON');

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'format');
  assert.strictEqual($(dom, '#notice').textContent, dom.window.LocalCalc.MSG.importBad);
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 1);
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory()[0].title, '原有记录');
  assert.strictEqual($(dom, '#confirmOverlay').hidden, true, '格式错误时不应弹出覆盖确认');
});

test('导入缺少版本或版本不符时拒绝导入（A33）', async function () {
  const dom = bootApp();
  addRecords(dom, [['calc', '原有记录', '1', {}]]);
  const res = await dom.window.LocalCalc.importBackupText(JSON.stringify({ history: [] }));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'version');
  assert.strictEqual($(dom, '#notice').textContent, dom.window.LocalCalc.MSG.importVersion);
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 1);

  const res2 = await dom.window.LocalCalc.importBackupText(JSON.stringify({ version: 2, history: [] }));
  assert.strictEqual(res2.reason, 'version');
  const res3 = await dom.window.LocalCalc.importBackupText(JSON.stringify({ version: 1, history: '不是数组' }));
  assert.strictEqual(res3.reason, 'format');
});

test('导入时非法条目被跳过并提示，合法条目正常恢复', async function () {
  const dom = bootApp();
  const text = JSON.stringify({
    app: 'local-calculator',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { historyLimit: 500 },
    history: [
      { id: 'ok-1', type: 'calc', title: '合法记录', result: '1', detail: {}, createdAt: 1 },
      { id: 'bad-1', type: '错误类型', title: '非法记录', result: '2', createdAt: 2 }
    ]
  });

  const p = dom.window.LocalCalc.importBackupText(text);
  await waitFor(function () { return !$(dom, '#confirmOverlay').hidden; });
  click(dom, '#confirmOk');
  const res = await p;

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 1);
  assert.strictEqual(res.skipped, 1);
  assert.ok($(dom, '#notice').textContent.indexOf('已跳过 1 条无效记录') >= 0, '提示未说明跳过条数：' + $(dom, '#notice').textContent);
  click(dom, '#settingsClose');
  click(dom, '#nav [data-view="history"]');
  assert.strictEqual(historyRows(dom).length, 1);
  assert.strictEqual(historyRows(dom)[0].title, '合法记录');
});

test('通过文件选择导入，走 FileReader 路径也能恢复（A32）', async function () {
  const src = bootApp();
  addRecords(src, [['calc', '文件导入的记录', '42', { expression: '42' }]]);
  const text = src.window.LocalCalc.buildBackup().text;

  const dom = bootApp();
  const file = new dom.window.File([text], 'calculator-backup-2026-10-13.json', { type: 'application/json' });
  const p = dom.window.LocalCalc.importBackupFile(file);
  await waitFor(function () { return !$(dom, '#confirmOverlay').hidden; });
  click(dom, '#confirmOk');
  const res = await p;

  assert.strictEqual(res.ok, true);
  click(dom, '#settingsClose');
  click(dom, '#nav [data-view="history"]');
  assert.strictEqual(historyRows(dom)[0].title, '文件导入的记录');
});

test('设置里的「清空全部数据」需确认，确认后记录与设置一起重置', async function () {
  const dom = bootApp();
  addRecords(dom, [['calc', 'A', '1', {}], ['calc', 'B', '2', {}]]);
  click(dom, '#settingsToggle');
  click(dom, '#settingsClearAll');
  await waitFor(function () { return !$(dom, '#confirmOverlay').hidden; });
  assert.strictEqual($(dom, '#confirmText').textContent.indexOf('确定清空全部数据') === 0, true);
  click(dom, '#confirmOk');
  await sleep(10);

  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 0);
  assert.strictEqual(dom.window.LocalCalc.state.settings.thousandSeparator, true);
  assert.strictEqual($(dom, '#setCount').textContent, '已存 0 条记录');
  click(dom, '#settingsClose');
  click(dom, '#nav [data-view="history"]');
  assert.strictEqual(emptyText(dom), dom.window.LocalCalc.MSG.emptyHistory);
});

test('取消清空全部数据时数据保持不变', async function () {
  const dom = bootApp();
  addRecords(dom, [['calc', 'A', '1', {}]]);
  click(dom, '#settingsToggle');
  click(dom, '#settingsClearAll');
  await waitFor(function () { return !$(dom, '#confirmOverlay').hidden; });
  click(dom, '#confirmCancel');
  await sleep(10);
  assert.strictEqual(dom.window.LocalCalc.Store.loadHistory().length, 1);
});

stage(6, '步骤 6 · 收尾检查');

test('布局静态检查：容器最小宽度小于 1024，工作区最大宽度 880px（A35）', function () {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const appRule = css.match(/\.app\s*\{[^}]*\}/);
  assert.ok(appRule, '找不到 .app 规则');
  const m = appRule[0].match(/min-width:\s*(\d+)px/);
  assert.ok(m, '.app 未设置最小宽度');
  assert.ok(Number(m[1]) < 1024, '容器最小宽度必须小于 1024 才不会出现横向滚动：' + m[1]);

  const ws = css.match(/\.workspace\s*\{[^}]*\}/);
  assert.ok(ws && /max-width:\s*880px/.test(ws[0]), '工作区最大宽度应为 880px');

  const grid = css.match(/\.convert-grid\s*\{[^}]*\}/);
  assert.ok(grid && /minmax\(0,\s*1fr\)/.test(grid[0]), '换算栅格需用 minmax(0,1fr) 防止内容溢出');
});

test('代码收尾检查：没有遗留的占位标记与调试输出', function () {
  /* 区块标题形如「§1 常量配置」属于文档性注释，这里只揪出形如「§VIEW_CALC_JS」的占位标记 */
  assert.ok(!/§[A-Z][A-Z_]*/.test(appCode), 'app.js 中仍残留占位标记');
  assert.ok(!/§[A-Z][A-Z_]*/.test(htmlCode), 'index.html 中仍残留占位标记');
  assert.ok(appCode.indexOf('console.log') < 0, 'app.js 中仍有调试输出');
  assert.ok(appCode.indexOf('debugger') < 0, 'app.js 中仍有 debugger');
  assert.ok(appCode.indexOf('TODO') < 0 && appCode.indexOf('FIXME') < 0, 'app.js 中仍有未完成的标记');
});

test('四个视图都能正常打开且不报错（A1、A2 收尾复检）', function () {
  const dom = bootApp();
  ['calc', 'convert', 'date', 'history'].forEach(function (v) {
    click(dom, '#nav [data-view="' + v + '"]');
    assert.strictEqual(dom.window.LocalCalc.state.view, v);
    assert.strictEqual($(dom, '#view-' + v).hidden, false);
  });
  assert.strictEqual(dom.window.LocalCalc.Store.available, true);
});

test('设置面板与三个模块联动：改设置后各视图用新设置重画', function () {
  const dom = bootApp();
  tapProgram(dom, '12 * 8 + 5 =');
  click(dom, '#nav [data-view="convert"]');
  setInputValue(dom, '#convertLeft', '2');
  click(dom, '#settingsToggle');
  const cb = $(dom, '#setThousand');
  cb.checked = false;
  cb.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.strictEqual(dom.window.LocalCalc.state.settings.thousandSeparator, false);
  click(dom, '#settingsClose');
  click(dom, '#nav [data-view="calc"]');
  assert.strictEqual(mainText(dom), '101');
  assert.strictEqual($(dom, '#convertRight').value, '6.56168');
});

runAll();

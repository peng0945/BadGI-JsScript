/**
 * 自动剧情加载器 · HTML 遮罩运行面板（JS 侧）
 *
 * 依赖 BetterGI 的 htmlMask API（>= 0.60.2-alpha.3）：
 *   在游戏窗口上叠加透明、置顶、默认点击穿透的 HTML 页面，
 *   通过 send / onMessage 做双向通信。
 *
 * 职责：
 *   1. 显示运行面板，并持续推送「已运行时间 / 状态 / 当前 DSL 行 / 剧情名」
 *   2. 按 N 键最小化 / 展开
 *   3. 按 K 键切换「交互模式」（关闭点击穿透），以便点击设置按钮
 *   4. 接收 HTML 侧请求：切换剧情（立即生效）、交互模式开关
 *
 * 面板只反映脚本自身的状态（运行中 / 脚本暂停 / 已完成），
 * 不显示 BetterGI 应用级暂停（框架未提供查询 API）。
 */

// 遮罩功能所需的最低 BetterGI 版本
const MIN_MASK_VERSION = '0.60.2-alpha.3';

// 详细日志开关（默认关闭），排查 N/K 热键问题时改为 true
const OVERLAY_DEBUG = false;

/** 调试日志：仅在 OVERLAY_DEBUG 为 true 时输出 */
function dbg(msg) {
  if (OVERLAY_DEBUG) { try { log.info(msg); } catch (e) { /* 静默 */ } }
}

let winId = null;
let enabled = false;
let interactive = false;
let switchRequest = null;      // 待处理的切换请求（剧情名）
let startedAt = 0;
let lastSentLine = null;
let curStatus = 'idle';        // 最近一次状态
let curProcess = '';
/* HTML 侧输入框是否聚焦（由 /inputFocus 消息同步）。
   聚焦时屏蔽 N/K 热键，避免在搜索框里打字触发面板动作。 */
let textInputFocused = false;

/** 比较版本号：a >= b 返回 true */
function versionAtLeast(a, b) {
  const pa = String(a || '0').split(/[.\-+]/);
  const pb = String(b || '0').split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] || '0', 10) || 0;
    const y = parseInt(pb[i] || '0', 10) || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

/** 初始化遮罩面板，返回是否启用成功 */
function initOverlay(bgiVersion) {
  try {
    if (typeof htmlMask === 'undefined' || !htmlMask) {
      log.info('当前 BetterGI 不支持 htmlMask，运行面板已跳过');
      return false;
    }
    if (!versionAtLeast(bgiVersion, MIN_MASK_VERSION)) {
      log.info(`运行面板需要 BetterGI >= ${MIN_MASK_VERSION}，当前 ${bgiVersion}，已跳过`);
      return false;
    }
    enabled = true;
    startedAt = Date.now();
    return true;
  } catch (e) {
    log.warn('初始化运行面板失败: ' + (e && e.message));
    enabled = false;
    return false;
  }
}

/** 显示运行面板 */
async function showOverlay(opts) {
  if (!enabled) return false;
  try {
    winId = htmlMask.show('assets/overlay.html', 'auto-story-overlay');
    if (!winId) { enabled = false; return false; }

    // 等 HTML 侧脚本就绪（onMessage 挂载后回一条 /ready）
    try { await htmlMask.receive(winId, 5000); } catch (e) { /* 超时不阻塞 */ }

    startedAt = Date.now();
    curStatus = (opts && opts.status) || 'running';
    curProcess = (opts && opts.current) || '';

    send('/init', {
      current: (opts && opts.current) || '',
      processes: (opts && opts.processes) || [],
      status: curStatus,                 // 持续运行模式首帧即显示「等待选择剧情」
      // HTML 侧据此建立计时基准，之后靠本地定时器走秒
      elapsedMs: 0
    });
    return true;
  } catch (e) {
    log.warn('显示运行面板失败: ' + (e && e.message));
    winId = null;
    enabled = false;
    return false;
  }
}

/** 关闭面板并释放按键钩子（脚本结束时调用） */
function disposeOverlay() {
  disposeKeyHook();
  disposeSharedKeyHook();       // 脚本真正结束才销毁底层全局钩子
  try {
    if (winId && typeof htmlMask !== 'undefined' && htmlMask) htmlMask.close(winId);
  } catch (e) { /* 静默 */ }
  winId = null;
  enabled = false;
}

/** 收信 + 投递：收取面板消息，并投递热键产生的面板指令 */
function pumpAndBeat() {
  if (!alive()) return;
  try { pumpMessages(); } catch (e) { /* 静默 */ }
  try { flushPending(); } catch (e) { /* 静默 */ }
}

/** 面板是否仍然存在 */
function alive() {
  if (!enabled || !winId) return false;
  try {
    if (!htmlMask.exists(winId)) { winId = null; return false; }
    return true;
  } catch (e) { return false; }
}

/** 发送消息到 HTML 面板，返回是否确实送达 */
let lastSendError = '';

function send(url, data) {
  if (!enabled || !winId) { lastSendError = '面板未启用或 winId 为空'; return false; }
  try {
    if (!htmlMask.exists(winId)) {
      lastSendError = 'htmlMask.exists(winId) 返回 false，窗口已关闭';
      winId = null;
      return false;
    }
  } catch (e) {
    lastSendError = 'htmlMask.exists 抛异常: ' + (e && e.message);
    return false;
  }
  try {
    htmlMask.send(winId, url, JSON.stringify(data || {}));
    return true;
  } catch (e) {
    lastSendError = 'htmlMask.send 抛异常: ' + (e && e.message);
    return false;
  }
}

/** 推送运行进度 */
function sendProgress(o) {
  if (!alive()) return;
  const d = o || {};
  if (d.status) curStatus = d.status;
  if (d.process !== undefined) curProcess = d.process;
  const payload = {
    elapsedMs: Date.now() - startedAt,
    status: curStatus
  };
  if (d.process !== undefined) payload.process = d.process;
  if (d.line !== undefined) payload.line = d.line;
  if (d.lineNo !== undefined) payload.lineNo = d.lineNo;
  send('/progress', payload);
}

/** 更新可选剧情列表 */
function sendProcessList(processes, current) {
  send('/processes', { processes: processes || [], current: current || '' });
}

/** 重置运行时间基准（切换剧情时调用） */
function resetElapsed() {
  startedAt = Date.now();
}

/** 在执行每条指令前调用：把「当前执行行」推送到面板 */
function sendCurrentLine(instr) {
  if (!alive() || !instr) return;
  const raw = instr.raw || formatInstr(instr);
  if (raw === lastSentLine) return;      // 去重，减少通信量
  lastSentLine = raw;
  send('/line', {
    line: raw,
    lineNo: instr.line || 0
  });
  /* 换到新的一行 → 清掉上一行可能残留的「第 N/M 次」循环进度 */
  clearLoopProgress();
}

/** 推送「循环进度」到面板 */
function sendLoopProgress(instr, done, total) {
  if (!alive() || !instr) return;
  send('/loop', {
    line: instr.raw || formatInstr(instr),
    lineNo: instr.line || 0,
    done: Number(done) || 0,
    total: Number(total) || 0
  });
}

/** 清除面板上的循环进度（离开该指令时调用） */
function clearLoopProgress() {
  if (!alive()) return;
  send('/loop', { done: 0, total: 0 });
}

/** 把指令对象还原为可读的 DSL 原文 */
function formatInstr(instr) {
  const t = instr.type;
  const d = instr.data;  if (d === null || d === undefined || d === '') return t;
  return t + ' ' + d;
}

/** 脚本即将进入「暂停」等待（main.js 的暂停 / 注入失败暂停） */
function notifyPause(reason) {
  curStatus = 'paused';
  send('/status', { status: 'paused', elapsedMs: Date.now() - startedAt });
  if (reason) log.info('运行面板：已标记暂停（' + reason + '）');
}

/** 脚本从暂停恢复 */
function notifyResume() {
  curStatus = 'running';
  send('/status', { status: 'running', elapsedMs: Date.now() - startedAt });
}

/** 全部流程结束 */
function notifyDone() {
  curStatus = 'done';
  send('/status', { status: 'done', elapsedMs: Date.now() - startedAt });
}

/** 持续运行模式下「已挂载但未选择剧情」的空闲态 */
function notifyWaiting() {
  curStatus = 'waiting';
  send('/status', { status: 'waiting' });
}

// 持续运行模式（settings.json 里选「持续运行」时开启）
let persistentMode = false;

/** 「放弃剧情」请求（由 HTML 按钮产生） */
let abandonRequest = false;

/** 设置持续运行模式，并同步给 HTML 面板 */
function setPersistentMode(on) {
  persistentMode = !!on;
  send('/mode', { persistent: persistentMode });
}

function isPersistentMode() {
  return persistentMode;
}

/** 取出并清空「放弃」请求 */
function consumeAbandonRequest() {
  const r = abandonRequest;
  abandonRequest = false;
  return r;
}

/** 是否存在待处理的「放弃」请求（不消费） */
function hasAbandonRequest() {
  return !!abandonRequest;
}

/* 选择页「取消」标志：勾选强制选择剧情时，用户在页面里点取消
   → 视为不执行任何剧情，脚本结束。 */
let pickerCancelled = false;

/** 消费「选择页被取消」标志 */
function consumePickerCancelled() {
  const r = pickerCancelled;
  pickerCancelled = false;
  return r;
}

/** 是否收到「选择页被取消」 */
function hasPickerCancelled() {
  return !!pickerCancelled;
}

/** 待应用的起始行（process.json 的真实文件行号，1 起算；0 = 从头） */
let startLineRequest = 0;

/** 取出并清空起始行请求 */
function consumeStartLine() {
  const r = startLineRequest;
  startLineRequest = 0;
  return r;
}

/** 是否存在有效的起始行请求（> 1 才算） */
function hasStartLine() {
  return startLineRequest > 1;
}

/** 是否存在需要中断当前剧情流程的请求（切换 或 放弃） */
function hasInterruptRequest() {
  return !!switchRequest || !!abandonRequest;
}

/** 「放弃剧情」请求：语义由 main.js 按模式决定 */
function requestAbandon() {
  abandonRequest = true;
  if (persistentMode) {
    log.info('运行面板：收到「放弃剧情」请求（将持续运行，回到等待选择状态）');
  } else {
    log.info('运行面板：收到「放弃剧情」请求（将结束脚本）');
  }
  send('/status', { status: 'abandoning' });
}

/** 取出待处理的切换请求（取一次即清空） */
function consumeSwitchRequest() {
  const r = switchRequest;
  switchRequest = null;
  return r;
}

/** 是否存在待处理的切换请求（不消费） */
function hasSwitchRequest() {
  return !!switchRequest;
}

// 共享按键钩子：全脚本只允许一个实例
let sharedHook = null;
const keySubscribers = [];

/** 取（必要时创建）全局唯一按键钩子；不可用返回 null */
function getSharedKeyHook() {
  if (sharedHook) return sharedHook;
  try {
    if (typeof KeyMouseHook !== 'function') return null;
    sharedHook = new KeyMouseHook();
    sharedHook.OnKeyDown(function (key) {
      // 先复制再遍历：订阅者在回调里注销自己是常见操作
      for (const fn of keySubscribers.slice()) {
        try { fn(key); } catch (e) { /* 单个订阅者出错不影响其他 */ }
      }
    });
    return sharedHook;
  } catch (e) {
    log.warn('创建按键钩子失败: ' + (e && e.message));
    sharedHook = null;
    return null;
  }
}

/** 注册按键回调（main.js 的暂停键、overlay 的 N/K 都走这里） */
function subscribeKey(fn) {
  if (typeof fn !== 'function') return false;
  if (!getSharedKeyHook()) return false;
  keySubscribers.push(fn);
  return true;
}

/** 注销按键回调（不销毁底层钩子，避免影响其他订阅者） */
function unsubscribeKey(fn) {
  const i = keySubscribers.indexOf(fn);
  if (i >= 0) keySubscribers.splice(i, 1);
}

/** 脚本结束时才真正释放底层钩子 */
function disposeSharedKeyHook() {
  keySubscribers.length = 0;
  try { if (sharedHook) sharedHook.dispose(); } catch (e) { /* 静默 */ }
  sharedHook = null;
}

/** 归一化按键名：去空白、转大写（BetterGI 回调返回 KeyCode 形式的字符串） */
function normKeyName(k) {
  return String(k == null ? '' : k).trim().toUpperCase();
}

/* 面板指令在按键回调里直接投递（与官方示例 LinneaMining 一致），
   推迟到定时器里投递会导致 N 键失效。 */

// 带序号 + 回执的最小化投递：回调里直发一次，未收到回执则重发
let toggleSeq = 0;              // 递增序号
let pendingToggleSeq = 0;       // 待确认的序号（0 = 无）
let pendingToggleTry = 0;       // 已尝试次数
const TOGGLE_MAX_TRY = 4;       // 最多重发次数

// 兜底收信定时器句柄（startFlushTimer 创建、disposeKeyHook 清理）
let flushTimer = null;

/** 立刻发一次「最小化切换」；返回是否成功调用到 htmlMask.send */
function sendToggle(seq) {
  return send('/toggle', { seq: seq });
}

/** N 键处理：立刻直发 + 登记待确认（定时器会兜底重发） */
function toggleMinimize() {
  toggleSeq += 1;
  const seq = toggleSeq;
  pendingToggleSeq = seq;        // 等 HTML 回执
  pendingToggleTry = 1;

  const ok = sendToggle(seq);
  dbg('运行面板：已发送最小化切换（seq=' + seq + '，直发' + (ok ? '成功' : '失败') + '）');
  if (!ok) {
    log.warn('运行面板：直发失败原因 —— ' + lastSendError);
  }
  return ok;
}

/** 兜底投递：用同一 seq 重发未收到回执的最小化请求 */
function flushPending() {
  if (pendingToggleSeq === 0) return;

  if (!alive()) {
    log.warn('运行面板：窗口已不存在，放弃最小化请求（seq=' + pendingToggleSeq +
      '，原因：' + lastSendError + '）');
    pendingToggleSeq = 0; pendingToggleTry = 0;
    return;
  }

  if (pendingToggleTry >= TOGGLE_MAX_TRY) {
    log.warn('运行面板：最小化切换重发 ' + TOGGLE_MAX_TRY +
      ' 次仍未收到面板回执（seq=' + pendingToggleSeq + '）。' +
      '若界面已切换，说明是回执通道问题；若界面没变，说明消息未送达 Webview。');
    pendingToggleSeq = 0; pendingToggleTry = 0;
    return;
  }

  pendingToggleTry += 1;
  const seq = pendingToggleSeq;
  const ok = sendToggle(seq);
  log.warn('运行面板：未收到面板回执，重发最小化切换（seq=' + seq +
    '，第 ' + pendingToggleTry + ' 次，' + (ok ? '已发出' : '发送失败：' + lastSendError) + '）');
}

/** HTML 回执：确认某次最小化已生效 */
function ackToggle(seq, minimized) {
  if (seq === pendingToggleSeq) {
    pendingToggleSeq = 0;
    pendingToggleTry = 0;
    dbg('运行面板：面板已确认最小化切换（seq=' + seq +
      '，当前 minimized=' + minimized + '）');
  } else {
    // 迟到的回执（用户连按多次时可能出现），仅记录
    dbg('运行面板：收到过期的最小化回执（seq=' + seq + '，期望 ' + pendingToggleSeq + '）');
  }
}

/** 兜底定时器：持续收信（长耗时指令期间主循环不会调用 pumpAndBeat） */
function startFlushTimer() {
  try {
    if (typeof setInterval !== 'function') return;
    flushTimer = setInterval(function () {
      try { pumpMessages(); } catch (e) { /* 静默 */ }
      try { flushPending(); } catch (e) { /* 静默 */ }
    }, 150);
  } catch (e) { flushTimer = null; }
}

// 交互模式分两个阶段：interactPause = 用户已按 K 请求暂停，
// interactActive = 脚本已真正暂停（此时才让面板可点击）
let interactPause = false;    // 用户请求进入交互模式
let interactActive = false;   // 脚本已真正暂停（面板此刻可点击）

/** 交互模式是否已真正暂停（供 main.js 判断） */
function isInteractPaused() {
  return interactActive;
}

/** 是否已请求进入交互模式（含尚未暂停的过渡期） */
function isInteractRequested() {
  return interactPause;
}

/** 交互模式下阻塞主循环，直到退出交互模式或收到切换请求 */
async function waitWhileInteracting() {
  if (!interactPause) return;

  // 阶段一：脚本已到达安全点，真正暂停，现在才让面板可点击
  interactActive = true;
  try { htmlMask.setClickThrough(winId, false); } catch (e) { /* 旧版本无此 API */ }
  send('/interactive', { enabled: true });
  send('/status', { status: 'paused', elapsedMs: Date.now() - startedAt });
  log.info('运行面板：脚本已暂停，面板可点击（再按 K 继续）');

  // 阶段二：等待用户退出；期间保持收信，切换请求也能立即打断
  while (interactPause && !switchRequest) {
    pumpAndBeat();
    await sleep(100);
  }

  // 阶段三：恢复运行，恢复点击穿透
  interactActive = false;
  interactPause = false;
  interactive = false;
  try { htmlMask.setClickThrough(winId, true); } catch (e) { /* 静默 */ }
  send('/interactive', { enabled: false });

  if (switchRequest) {
    log.info('运行面板：收到切换请求，已退出交互模式');
  } else {
    log.info('运行面板：已退出交互模式，脚本继续');
    /* 恢复到「进入交互模式之前」的状态，而不是写死 running */
    send('/status', { status: curStatus, elapsedMs: Date.now() - startedAt });
  }
}

/* 防抖：按住键会产生自动重复，该环境下 OnKeyUp 不会触发，
   因此改用时间窗防抖：同一键在 KEY_DEBOUNCE_MS 内只响应一次。 */
const KEY_DEBOUNCE_MS = 400;
const lastKeyAt = {};

/** 判断本次按键是否应被忽略（在防抖窗口内） */
function isDebounced(k) {
  const now = Date.now();
  const prev = lastKeyAt[k] || 0;
  if (now - prev < KEY_DEBOUNCE_MS) return true;
  lastKeyAt[k] = now;
  return false;
}

/** overlay 自己的按键回调（用变量持有，便于注销） */
let overlayKeyHandler = null;

function initKeyHook() {
  if (!enabled) return;
  if (overlayKeyHandler) return;            // 已注册，避免重复

  overlayKeyHandler = function (key) {
    const k = normKeyName(key);

    /* 输入框聚焦时（如剧情搜索框）不响应 N/K 热键，
       否则打字会误触发最小化 / 退出交互模式。 */
    if (textInputFocused) {
      dbg('输入框聚焦中，忽略热键: ' + k);
      return;
    }

    // 时间窗防抖：忽略长按产生的自动重复（不依赖 OnKeyUp）
    if (isDebounced(k)) return;
    dbg('运行面板收到按键: ' + k);          // 高频日志：仅调试模式

    if (k === 'N') {
      toggleMinimize();
    } else if (k === 'K') {
      /* 只切换「暂停请求」，不在这里改点击穿透 */
      interactPause = !interactPause;
      interactive = interactPause;
      log.info(interactPause
        ? '运行面板：已请求进入交互模式，将在当前指令结束后暂停'
        : '运行面板：已请求退出交互模式');
    }
  };

  // 走共享钩子，绝不自己 new KeyMouseHook()
  if (!subscribeKey(overlayKeyHandler)) {
    overlayKeyHandler = null;
    log.warn('按键钩子不可用，N/K 热键已跳过');
    return;
  }

  // 启动兜底「收信」定时器
  startFlushTimer();
}

/** 注销 overlay 的按键回调（不销毁共享钩子，main.js 的暂停键还要用） */
function disposeKeyHook() {
  if (overlayKeyHandler) {
    unsubscribeKey(overlayKeyHandler);
    overlayKeyHandler = null;
  }
  try { if (flushTimer) clearInterval(flushTimer); } catch (e) { /* 静默 */ }
  flushTimer = null;
  pendingToggleSeq = 0;
  pendingToggleTry = 0;
  interactPause = false;
  interactActive = false;
}

/** 供 HTML 请求某个 process.json 的「带行号指令列表」的回调 */
let lineListProvider = null;

/** 注册「指令列表」提供者（由 main.js 调用） */
function setLineListProvider(fn) {
  lineListProvider = (typeof fn === 'function') ? fn : null;
}

// 剧情选择器（picker 协议）：收发走非阻塞通道，避免阻塞 N/K 热键
const PICKER_ROOT = 'process';
/** 选择器当前浏览的目录 */
let pickerCwd = PICKER_ROOT;
/** 全量剧情清单缓存（只在打开/显式刷新时重扫） */
let pickerProcesses = null;

/** 路径统一为正斜杠 */
function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

/** 取目录部分 */
function dirOf(p) {
  const parts = toSlash(p).split('/');
  parts.pop();
  return parts.join('/');
}

/** 取文件名 */
function baseName(p) {
  const parts = toSlash(p).split('/');
  return parts[parts.length - 1];
}

/** 剧情名：process 之后的路径段用 - 连接 */
function processLabel(fullPath) {
  const segments = toSlash(fullPath).split('/').filter(Boolean);
  const index = segments.indexOf(PICKER_ROOT);
  if (index === -1) return baseName(fullPath);
  const rest = segments.slice(index + 1);
  rest.pop();
  return rest.length > 0 ? rest.join('-') : baseName(fullPath);
}

/** 是否为可执行的剧情文件（文件名恰为 process.json，大小写不敏感） */
function isProcessFile(name) {
  return String(name).toLowerCase() === 'process.json';
}

/** 列出某目录的文件夹与文件（各自排序） */
function listDir(dir) {
  const folders = [], files = [];
  try {
    for (const itemPath of file.ReadPathSync(dir)) {
      if (file.IsFolder(itemPath)) folders.push(toSlash(itemPath));
      else files.push(toSlash(itemPath));
    }
  } catch (e) {
    throw new Error('无法读取目录 ' + dir + '：' + (e && e.message));
  }
  folders.sort();
  files.sort();
  return { folders, files };
}

/** 构造给 HTML 的目录视图 */
function buildPickerView(cwd) {
  const { folders, files } = listDir(cwd);
  const up = cwd.includes('/') ? dirOf(cwd) : null;
  return {
    cwd: cwd,
    canUp: cwd !== PICKER_ROOT,
    upTo: up,
    folders: folders.map((p) => ({ name: baseName(p), path: p })),
    files: files.map((p) => {
      const name = baseName(p);
      const selectable = isProcessFile(name);
      return {
        name: name,
        path: p,
        selectable: selectable,
        label: selectable ? processLabel(p) : '',
      };
    }),
  };
}

/** 遍历整棵 process 树，列出所有可执行剧情（按剧情名排序） */
function countPickerProcesses() {
  const found = [];
  const stack = [PICKER_ROOT];
  while (stack.length) {
    const cur = stack.pop();
    let items;
    try { items = file.ReadPathSync(cur); }
    catch (e) { continue; }                  // 个别目录读不到就跳过
    for (const itemPath of items) {
      if (file.IsFolder(itemPath)) { stack.push(toSlash(itemPath)); continue; }
      const name = baseName(itemPath);
      const full = toSlash(itemPath);
      /* 排除根目录下的 process/process.json（那是调度入口，不是剧情） */
      if (isProcessFile(name) && full !== PICKER_ROOT + '/process.json') {
        found.push({ name: processLabel(full), path: full });
      }
    }
  }
  found.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  return found;
}

/** 推送选择器状态给 HTML（非阻塞的 send，不 await） */
function pushPickerState(cwd, rescan) {
  let payload;
  try {
    if (rescan || !pickerProcesses) pickerProcesses = countPickerProcesses();
    pickerCwd = cwd || PICKER_ROOT;
    payload = { ok: true, view: buildPickerView(pickerCwd), processes: pickerProcesses };
  } catch (error) {
    payload = { ok: false, error: String(error && error.message ? error.message : error) };
  }
  send('/picker/state', payload);
}

/** 清空选择器缓存（脚本重跑时调用） */
function resetPickerCache() {
  pickerProcesses = null;
  pickerCwd = PICKER_ROOT;
}

/** 主动打开剧情选择页，并高亮当前（BetterGI 里选中的）剧情 */
function openPicker(current) {
  if (!alive()) return false;
  /* 记录当前剧情名，HTML 侧渲染时据此打上「当前」标记 */
  if (typeof current === 'string') curProcess = current;
  const ok = send('/openPicker', { current: current || '' });
  if (ok) log.info('已请求打开剧情选择页' + (current ? ('（当前：' + current + '）') : ''));
  return ok;
}

/** 处理 HTML 侧发来的消息 */
function handleHtmlMessage(raw) {
  let msg;
  try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (e) { return; }
  if (!msg || !msg.url) return;

  const data = msg.data || {};

  if (msg.url === '/switch') {
    // 记录切换请求；主循环会在下一条指令前中断当前剧情
    if (data.name) {
      switchRequest = data.name;
      // 可选：从第几行开始（真实文件行号）。0 / 缺省 = 从头执行
      startLineRequest = Number(data.startLine) > 1 ? Number(data.startLine) : 0;
      log.info('收到切换请求: ' + data.name +
        (startLineRequest > 1 ? ('（从第 ' + startLineRequest + ' 行开始）') : '') +
        '（将在当前指令结束后生效）');
      send('/status', { status: 'running' });
      // 若正处于交互模式（脚本已暂停），立即退出暂停以便切换生效
      if (interactPause) {
        interactPause = false;
        interactActive = false;
        interactive = false;
      }
    }
  } else if (msg.url === '/abandon') {
    // 「放弃剧情」按钮：语义由 main.js 按模式决定
    requestAbandon();
  } else if (msg.url === '/lines') {
    // HTML 请求某个剧情的「带行号指令列表」（用于可视化选起始行）
    const want = data.name;
    if (!want) return;
    let lines = [];
    try {
      if (lineListProvider) lines = lineListProvider(want) || [];
      else log.warn('运行面板：指令列表提供者未注册，无法返回行列表');
    } catch (e) {
      log.warn('运行面板：读取指令列表失败 —— ' + (e && e.message));
    }
    send('/lines', { name: want, lines: lines });
  } else if (msg.url === '/interactive') {
    // HTML 侧主动设置交互模式（如关闭设置窗口后恢复点击穿透）
    const want = !!data.enabled;
    interactive = want;
    // 这里只更新「请求」状态，真正关闭点击穿透由 waitWhileInteracting 执行
    interactPause = want;
    if (!want) {
      // 退出交互：立即恢复穿透是安全的
      interactActive = false;
      try { htmlMask.setClickThrough(winId, true); } catch (e) { /* 静默 */ }
    }
  } else if (msg.url === '/toggle-ack') {
    // 面板确认已执行最小化切换 → 停止兜底重发
    ackToggle(typeof data.seq === 'number' ? data.seq : 0, !!data.minimized);
  } else if (msg.url === '/picker/refresh') {
    /* 剧情选择器：重新读取（打开窗口、点「重新读取」、切到「全部」段时触发）
       全量剧情清单只在 rescan=true 时重扫（遍历整棵树较慢） */
    pushPickerState(data.path ? toSlash(data.path) : PICKER_ROOT, true);
  } else if (msg.url === '/picker/enter') {
    // 进入子目录
    const target = data.path ? toSlash(data.path) : PICKER_ROOT;
    let ok = false;
    try { ok = file.IsFolder(target); } catch (e) { ok = false; }
    pushPickerState(ok ? target : PICKER_ROOT, false);
  } else if (msg.url === '/picker/up') {
    // 返回上级
    const target = data.path ? toSlash(data.path) : PICKER_ROOT;
    let ok = false;
    try { ok = file.IsFolder(target); } catch (e) { ok = false; }
    pushPickerState(ok ? target : PICKER_ROOT, false);
  } else if (msg.url === '/picker/cancelled') {
    // 选择页被用户取消 → 由 main.js 决定「结束脚本」
    pickerCancelled = true;
    log.info('运行面板：选择页已取消');
  } else if (msg.url === '/inputFocus') {
    /* 输入框获得/失去焦点：聚焦时屏蔽 N/K 热键 */
    textInputFocused = !!data.focused;
  }
}

/** 轮询 HTML 消息（由主循环定期调用，使用非阻塞 pollAll） */
function pumpMessages() {
  if (!alive()) return;
  try {
    const raw = htmlMask.pollAll(winId);
    if (!raw) return;
    let list;
    try { list = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(list)) return;
    for (const m of list) handleHtmlMessage(m);
  } catch (e) { /* 静默 */ }
}

export {
  initOverlay,
  showOverlay,
  disposeOverlay,
  sendProgress,
  sendProcessList,
  sendCurrentLine,
  sendLoopProgress,
  clearLoopProgress,
  resetElapsed,
  notifyPause,
  notifyResume,
  notifyDone,
  notifyWaiting,
  consumeSwitchRequest,
  hasSwitchRequest,
  setPersistentMode,
  isPersistentMode,
  consumeAbandonRequest,
  hasAbandonRequest,
  consumePickerCancelled,
  hasPickerCancelled,
  hasInterruptRequest,
  consumeStartLine,
  hasStartLine,
  setLineListProvider,
  resetPickerCache,
  openPicker,
  initKeyHook,
  disposeKeyHook,
  pumpMessages,
  pumpAndBeat,
  flushPending,
  toggleMinimize,
  formatInstr,
  subscribeKey,
  unsubscribeKey,
  normKeyName,
  isInteractPaused,
  isInteractRequested,
  waitWhileInteracting
};

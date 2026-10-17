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
 * 【已放弃适配：BetterGI 应用级暂停】
 *   BetterGI 框架自带的「暂停脚本」快捷键会挂起整个脚本，且未提供任何
 *   查询暂停状态的 API。曾尝试用「心跳超时」间接推断，但实测无法可靠区分
 *   「框架暂停」与「正常的长耗时指令」，故放弃该状态显示。
 *   面板只反映脚本自身的状态（运行中 / 脚本暂停 / 已完成）。
 */

// 遮罩功能所需的最低 BetterGI 版本
const MIN_MASK_VERSION = '0.60.2-alpha.3';

/* ------------------------------------------------------------------ */
/* 调试开关                                                            */
/* ------------------------------------------------------------------ */

/**
 * ★ 详细日志开关（默认 **关闭**）。
 *
 * 为什么需要它：N/K 热键排查期间，每次按键都会打印
 * 「收到按键 / 已发送 / 已确认」三行，长时间运行会刷屏。
 * 功能稳定后把这些高频日志降级为「仅调试模式可见」。
 *
 * 需要排查热键问题时，把这里改成 `true` 即可恢复详细日志；
 * 警告与错误（log.warn / log.error）**始终输出**，不受此开关影响。
 */
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

/* ------------------------------------------------------------------ */
/* 版本判断                                                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

/**
 * 初始化遮罩面板
 * @param {string} bgiVersion - 当前 BetterGI 版本号（getVersion()）
 * @returns {boolean} 是否启用成功
 */
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

/**
 * 显示运行面板
 * @param {Object} opts
 * @param {string} opts.current   - 当前剧情名
 * @param {Array}  opts.processes - 可选剧情列表 [{name, path}]
 * @param {string} [opts.status]  - 初始状态（持续运行模式传 'waiting'）
 */
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
      // ★ 必须带上起始时间：HTML 侧据此建立计时基准，
      //   之后靠本地定时器走秒（JS 不会持续推送）。
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

/* ------------------------------------------------------------------ */
/* 长耗时指令的静默说明                                                 */
/* ------------------------------------------------------------------ */

/**
 * ★ 由执行循环调用的「收信 + 投递」组合
 *
 * 在每条指令执行前后、以及长等待的分片循环里调用它，可以：
 *   1. 收取面板消息 —— 让「切换剧情」能及时生效
 *   2. 投递热键产生的面板指令（最小化 / 交互模式）
 *
 * 说明：这里不再发送「心跳」。原先用心跳推断 BetterGI 框架暂停，
 * 实测无法可靠区分框架暂停与长耗时指令，已放弃该状态显示。
 */
function pumpAndBeat() {
  if (!alive()) return;
  try { pumpMessages(); } catch (e) { /* 静默 */ }
  try { flushPending(); } catch (e) { /* 静默 */ }
}

/* ------------------------------------------------------------------ */
/* 状态推送                                                            */
/* ------------------------------------------------------------------ */

/** 面板是否仍然存在 */
function alive() {
  if (!enabled || !winId) return false;
  try {
    if (!htmlMask.exists(winId)) { winId = null; return false; }
    return true;
  } catch (e) { return false; }
}

/**
 * 发送消息到 HTML 面板。
 * ★ 返回**真实**是否送达，调用方据此打日志 ——
 *   此前的版本无论成功与否都打印「已投递」，严重误导排查。
 * ★ 同时记录最后一次失败原因（lastSendError），便于定位
 *   「调用了但没送达」这类问题。
 * @returns {boolean} true = 确实调用了 htmlMask.send 且未抛异常
 */
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

/**
 * 推送运行进度
 * @param {Object} o
 * @param {string} [o.status]   - running | paused | done | idle
 * @param {string} [o.process]  - 当前剧情名
 * @param {string} [o.line]     - 当前执行的 DSL 原文
 * @param {number} [o.lineNo]   - 该行在 process.json 中的行号
 */
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

/**
 * ★ 重置运行时间基准（切换剧情时调用）。
 *
 * 为什么需要：`elapsedMs` 是用 `Date.now() - startedAt` 算出来的，
 * 而 `startedAt` 只在脚本启动时设过一次。切换剧情后若不复位，
 * 面板会继续累加**整个脚本**的运行时长，而不是**当前剧情**的时长。
 *
 * 用户明确要求：「切换 process.json 流程脚本后时间应该归零重新计算」。
 */
function resetElapsed() {
  startedAt = Date.now();
}

/**
 * 在执行每条指令前调用：把「当前执行行」推送到面板
 * @param {Object} instr - 解析后的指令对象（含 type / data / line / raw）
 */
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

/**
 * 推送「循环进度」到面板（用于「地图追踪 / 键鼠脚本」的参数重载）。
 *
 * 例：`地图追踪 路径1.json 3 主界面 true` 执行完第 1 轮时，
 *     面板显示「当前执行」下方附带 `第 1/3 次`。
 *
 * @param {Object} instr 原始指令
 * @param {number} done  已完成次数
 * @param {number} total 最大次数
 */
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

/* ------------------------------------------------------------------ */
/* 暂停状态                                                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* 持续运行模式 + 「放弃剧情」请求                                       */
/* ------------------------------------------------------------------ */

/**
 * 持续运行模式（settings.json 里选「持续运行」时开启）：
 *   脚本常驻挂载，但不自动运行任何 process.json；
 *   等用户在面板里选一个剧情才开始跑，跑完或放弃后回到空闲态。
 *
 * 该标志会同步给 HTML，用于：
 *   ① 空闲时显示「等待选择剧情」
 *   ② 「放弃」按钮的语义不同（见下）
 */
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

/* ------------------------------------------------------------------ */
/* 「从指定行开始运行」                                                 */
/* ------------------------------------------------------------------ */

/**
 * 待应用的起始行（process.json 的真实文件行号，1 起算；0 = 从头）。
 *
 * 与 switchRequest 一样由 HTML 侧通过 /switch 携带 startLine 传入，
 * 主循环在启动该剧情时读取并消费。
 */
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

/**
 * 是否存在**任何**需要中断当前剧情流程的请求（切换 或 放弃）。
 *
 * 主循环在长等待/暂停期间用它判断是否该提前退出，
 * 避免用户点了「放弃」还要等当前长指令跑完。
 */
function hasInterruptRequest() {
  return !!switchRequest || !!abandonRequest;
}

/**
 * 「放弃」按钮的语义（按模式区分，由 main.js 决定后续动作）：
 *   · 持续运行模式 → 放弃当前剧情，回到「挂载但空闲」状态
 *   · 其他模式     → 结束（停止）整个脚本
 */
function requestAbandon() {
  abandonRequest = true;
  if (persistentMode) {
    log.info('运行面板：收到「放弃剧情」请求（将持续运行，回到等待选择状态）');
  } else {
    log.info('运行面板：收到「放弃剧情」请求（将结束脚本）');
  }
  send('/status', { status: 'abandoning' });
}

/* ------------------------------------------------------------------ */
/* 切换剧情（立即生效）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 取出待处理的切换请求（取一次即清空）
 * @returns {string|null} 目标剧情名
 */
function consumeSwitchRequest() {
  const r = switchRequest;
  switchRequest = null;
  return r;
}

/** 是否存在待处理的切换请求（不消费） */
function hasSwitchRequest() {
  return !!switchRequest;
}

/* ------------------------------------------------------------------ */
/* 共享按键钩子（★ 全脚本只允许一个实例）                                 */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 为什么必须共享（这是 F10 / K / N 失效的根因）：
 *
 *   BetterGI 的 KeyMouseHook 底层是**同一个全局键盘钩子**。
 *   main.js 的「暂停」指令原本会 `new KeyMouseHook()`，恢复时 `hook.dispose()`；
 *   而 overlay 也常驻一个实例。任何一方 dispose() 都会连带销毁另一方：
 *     · main.js 创建新钩子 → 覆盖 overlay 的注册 → 暂停期间 N/K 失效
 *     · main.js dispose() → 全局钩子被销毁 → 之后 N/K/F10 全部失效
 *
 *   改为「全局单例 + 多订阅者」：
 *     · 全脚本只有一个 KeyMouseHook 实例
 *     · 各方用 subscribeKey / unsubscribeKey 注册与注销自己的回调
 *     · 只有脚本真正结束时（disposeOverlay）才销毁它
 *
 *   依据：官方文档「多个回调」明确说明
 *     「支持为同一个事件注册多个回调函数，所有注册的回调都会被依次执行」。
 */
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

/** 注销按键回调（★ 不销毁底层钩子，避免影响其他订阅者） */
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

/**
 * 归一化按键名：去空白、转大写。
 * 实测 BetterGI 回调返回的是 KeyCode 形式的字符串：
 *   字母 → "N" / "K" / "M" / "F" / "W"
 *   数字 → "D1"（主键盘 1）
 *   符号 → "OEM6"（~ 键）
 */
function normKeyName(k) {
  return String(k == null ? '' : k).trim().toUpperCase();
}

/* ---- 面板指令：在按键回调里**直接投递** ----

   ★ 依据官方示例（LinneaMining/utils/overlay.js）：

       keyHook.OnKeyDown((key) => {
         if (key === 'N' && progressWinId && htmlMask.exists(progressWinId)) {
           htmlMask.send(progressWinId, '/toggle', '{}')     // ← 回调里直接 send
         }
       })

   官方示例就是这样写的，且实测可用。

   ⚠️ 本脚本曾经走弯路：把 send 推迟到定时器/异步循环里执行，
      以为「回调不在主线程」。实测结果是 N 键**永远无效** ——
      日志能看到「已投递最小化切换」，但界面纹丝不动。
      原因：延迟投递所在的执行上下文无法与 Webview 通信，send 静默失败。

   ★ 结论：按键回调里直接 send，不要再推迟。
     仅当直接投递**抛异常**时，才置标志交给兜底通道重试。 */
/* ★★ 带序号 + 回执的最小化投递（本轮修复核心）★★

   为什么需要这么复杂 —— 两次失败留下的教训：

   · 第 5 轮：回调只置标志，靠定时器投递。日志无条件打印「已投递」，
     **日志本身是假的**（send() 静默 return 也会打日志），无法定位。
   · 第 6 轮：回调里直接 send。日志变成真的了（「已发送」= 确实调用了
     htmlMask.send 且未抛异常），但用户实测**界面依然不动**。

   而同一时刻按 K 是好的 —— K 的消息是在**主循环**里发的，
   N 的消息是在**按键回调线程**里发的。这条对比强烈暗示：
   回调线程里的 htmlMask.send 未必能送达 Webview。

   但官方示例（LinneaMining）确实是在回调里直接 send 的，
   所以不能断定回调线程一定不行 —— 可能是环境/版本相关。

   ⇒ 因此不再二选一，改成「**两条路都走 + 幂等 + 回执**」：

     1. 回调里立刻直发一次（延迟最低，对齐官方示例）
     2. 同时记下待确认序号；150ms 定时器发现没收到回执就**重发**
        （定时器所在的上下文是确定可用的 —— pumpMessages 就在那里跑，
          而「切换剧情」正是靠它才工作的）
     3. HTML 侧用**序号去重**：只有 seq 更大才切换并回执 /toggle-ack
        → 即使两条路都送达，也**只会切换一次**，不会来回跳
     4. 收到回执即停止重发

   这样无论哪条路可用，N 键都能生效；且日志会明确告诉我们
   到底是「没送到」还是「送到了但界面没变」。 */
let toggleSeq = 0;              // 递增序号
let pendingToggleSeq = 0;       // 待确认的序号（0 = 无）
let pendingToggleTry = 0;       // 已尝试次数
const TOGGLE_MAX_TRY = 4;       // 最多重发次数，避免无限刷日志

/* ★ 兜底收信定时器句柄（startFlushTimer 创建、disposeKeyHook 清理）。
   ⚠️ 必须声明！本文件是 ES Module = **严格模式**，
      给未声明变量赋值会抛 ReferenceError（不是隐式建全局变量）。
      曾漏掉这一行：656/660/806/807 四处使用全部保留、唯独声明丢失，
      导致脚本结束时 disposeKeyHook() 在 `flushTimer = null` 抛
      「ReferenceError: flushTimer is not defined」，
      后续的 disposeSharedKeyHook()（释放全局键盘钩子）与
      htmlMask.close()（关面板）被跳过。
      回归起点：26100907（删除相邻的 pendingToggle* 时被连带删掉）。 */
let flushTimer = null;

/** 立刻发一次「最小化切换」；返回是否成功调用到 htmlMask.send */
function sendToggle(seq) {
  return send('/toggle', { seq: seq });
}

/**
 * N 键处理：立刻直发 + 登记待确认（定时器会兜底重发）。
 * @returns {boolean} 是否已成功发出第一次
 */
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

/**
 * 兜底投递：由定时器调用。
 * 只处理「已发出但迟迟没有回执」的最小化请求 —— 用同一 seq 重发，
 * HTML 侧靠序号去重，所以不会造成重复切换。
 */
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

/* ------------------------------------------------------------------ */
/* 兜底「收信 + 投递」定时器                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 本脚本曾经用一个 `await sleep()` 异步循环来「投递」热键指令，
 *    以为按键回调不在主线程。实测证明那条路走不通（N 键永久失效），
 *    已删除。热键指令现在在回调里**直接 send**。
 *
 * 这里保留的定时器**只做一件事**：持续收信（pumpMessages）。
 *
 * 为什么必须收信：长耗时指令（地图追踪/战斗/对话）会阻塞几十秒到几分钟，
 * 期间主循环不空转、不会调用 pumpAndBeat()。若没有这个定时器，
 * HTML 发来的 /switch（切换剧情）就会一直堆在队列里 →
 * 表现为「点了切换没反应」。
 * 901 版本之所以切换可用，正是因为当时的心跳 setInterval 顺带调用了 pumpMessages()。
 *
 * flushPending() 仅用于「直接投递抛异常」后的兜底重试，正常情况下无内容。
 */
function startFlushTimer() {
  try {
    if (typeof setInterval !== 'function') return;
    flushTimer = setInterval(function () {
      try { pumpMessages(); } catch (e) { /* 静默 */ }
      try { flushPending(); } catch (e) { /* 静默 */ }
    }, 150);
  } catch (e) { flushTimer = null; }
}

/* ------------------------------------------------------------------ */
/* 交互模式（bug 3）：按 K 暂停脚本，让用户能操作面板                     */
/* ------------------------------------------------------------------ */

/**
 * 交互模式分两个阶段，**顺序不能颠倒**（bug 3 的根因）：
 *
 *   interactPause  = 用户已按 K，请求进入交互模式（脚本应尽快暂停）
 *   interactActive = 脚本**已经真正暂停**，此时才让面板可点击
 *
 * ⚠️ 为什么必须先暂停、后关闭点击穿透：
 *   BetterGI 在脚本运行时**实时截获游戏窗口**。如果一按 K 就立刻把面板
 *   变成可点击（关闭穿透），面板会抢走焦点，而游戏任务仍在跑 →
 *   日志出现「当前获取焦点的窗口为 "BetterGI"，不是原神，尝试恢复窗口」
 *   甚至「疑似卡死，尝试脱离…」。
 *
 *   实测日志（用户反馈）：
 *     运行面板收到按键: K
 *     面板已进入交互模式（可点击），再按 K 退出     ← 太早
 *     当前获取焦点的窗口为: "BetterGI"，不是原神，尝试恢复窗口
 *     疑似卡死，尝试脱离...
 *
 *   正确顺序：按 K → 只置「请求暂停」→ 主循环走到安全点真正暂停
 *            → 这时才关闭点击穿透，面板才可点击。
 */
let interactPause = false;    // 用户请求进入交互模式
let interactActive = false;   // 脚本已真正暂停（面板此刻可点击）

/** 交互模式是否**已真正暂停**（供 main.js 判断） */
function isInteractPaused() {
  return interactActive;
}

/** 是否已请求进入交互模式（含尚未暂停的过渡期） */
function isInteractRequested() {
  return interactPause;
}

/**
 * 交互模式下阻塞主循环，直到退出交互模式或收到切换请求。
 * 由 main.js 在每条指令执行前、以及分片等待的每一片调用。
 *
 * ★ 关闭点击穿透**只在这里**发生 —— 即脚本确实停下来之后。
 */
async function waitWhileInteracting() {
  if (!interactPause) return;

  // ── 阶段一：脚本已到达安全点，真正暂停，现在才让面板可点击 ──
  interactActive = true;
  try { htmlMask.setClickThrough(winId, false); } catch (e) { /* 旧版本无此 API */ }
  send('/interactive', { enabled: true });
  send('/status', { status: 'paused', elapsedMs: Date.now() - startedAt });
  log.info('运行面板：脚本已暂停，面板可点击（再按 K 继续）');

  // ── 阶段二：等待用户退出；期间保持收信，切换请求也能立即打断 ──
  while (interactPause && !switchRequest) {
    pumpAndBeat();
    await sleep(100);
  }

  // ── 阶段三：恢复运行，恢复点击穿透 ──
  interactActive = false;
  interactPause = false;
  interactive = false;
  try { htmlMask.setClickThrough(winId, true); } catch (e) { /* 静默 */ }
  send('/interactive', { enabled: false });

  if (switchRequest) {
    log.info('运行面板：收到切换请求，已退出交互模式');
  } else {
    log.info('运行面板：已退出交互模式，脚本继续');
    /* ★ 恢复到「进入交互模式之前」的状态，而不是写死 running。
       持续运行的空闲态是 waiting，若写死 running，
       退出交互后面板会错误地显示「运行中」。 */
    send('/status', { status: curStatus, elapsedMs: Date.now() - startedAt });
  }
}

/* 防抖：按住键会产生自动重复。
   实测该环境下 OnKeyUp 不会触发（日志显示按住 N 时回调以 ~200ms
   间隔连续触发约 10 次），因此不能依赖「松开复位」，
   改用**时间窗防抖**：同一键在 DEBOUNCE_MS 内只响应一次。
   取值略大于系统的首次重复延迟（约 500ms），既不会漏按也不会连发。 */
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

    // 时间窗防抖：忽略长按产生的自动重复（不依赖 OnKeyUp）
    if (isDebounced(k)) return;
    dbg('运行面板收到按键: ' + k);          // 高频日志：仅调试模式

    if (k === 'N') {
      /* ★ 在回调里直接投递（与官方示例 LinneaMining 一致）。
         此前改成「置标志 + 定时器投递」导致 N 键永久失效，
         因为延迟投递的执行上下文无法与 Webview 通信。 */
      toggleMinimize();
    } else if (k === 'K') {
      /* ★ 只切换「暂停请求」，**不在这里改点击穿透**。
         必须等主循环真正暂停后（waitWhileInteracting 阶段一）
         才关闭穿透，否则面板抢焦点而游戏任务仍在跑 → 卡死。 */
      interactPause = !interactPause;
      interactive = interactPause;
      log.info(interactPause
        ? '运行面板：已请求进入交互模式，将在当前指令结束后暂停'
        : '运行面板：已请求退出交互模式');
    }
  };

  // ★ 走共享钩子，绝不自己 new KeyMouseHook()
  if (!subscribeKey(overlayKeyHandler)) {
    overlayKeyHandler = null;
    log.warn('按键钩子不可用，N/K 热键已跳过');
    return;
  }

  // ★ 启动兜底「收信」定时器（同时兼顾直接投递失败后的重试）。
  startFlushTimer();
}

/** 注销 overlay 的按键回调（★ 不销毁共享钩子，main.js 的暂停键还要用） */
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

/**
 * 供 HTML 请求某个 process.json 的「带行号指令列表」的回调。
 *
 * 为什么用回调注入：overlay.js 不该依赖 main.js 的解析函数，
 * 由 main.js 在启动时注册一个「读取并解析」的实现即可。
 * @type {null | ((name: string) => Array<{line:number, text:string, isHeader:boolean}>)}
 */
let lineListProvider = null;

/** 注册「指令列表」提供者（由 main.js 调用） */
function setLineListProvider(fn) {
  lineListProvider = (typeof fn === 'function') ? fn : null;
}

/* ------------------------------------------------------------------ */
/* 处理来自 HTML 的消息                                                 */
/* ------------------------------------------------------------------ */

/**
 * 处理 HTML 侧发来的消息
 * @param {string} raw - JSON 字符串 {url, data}
 */
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
      // ★ 可选：从第几行开始（真实文件行号）。0 / 缺省 = 从头执行。
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
    // ★ 「放弃剧情」按钮：语义由 main.js 按模式决定
    requestAbandon();
  } else if (msg.url === '/lines') {
    // ★ HTML 请求某个剧情的「带行号指令列表」（用于可视化选起始行）
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
    // 注意：这里只更新「请求」状态。真正关闭点击穿透由
    // waitWhileInteracting 在脚本确实暂停后执行（避免抢焦点导致卡死）。
    interactPause = want;
    if (!want) {
      // 退出交互：立即恢复穿透是安全的
      interactActive = false;
      try { htmlMask.setClickThrough(winId, true); } catch (e) { /* 静默 */ }
    }
  } else if (msg.url === '/toggle-ack') {
    // ★ 面板确认已执行最小化切换 → 停止兜底重发
    ackToggle(typeof data.seq === 'number' ? data.seq : 0, !!data.minimized);
  }
}

/**
 * 轮询 HTML 消息（由主循环定期调用）
 * 使用非阻塞 pollAll，避免 await receive 卡住主流程
 */
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
  hasInterruptRequest,
  consumeStartLine,
  hasStartLine,
  setLineListProvider,
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

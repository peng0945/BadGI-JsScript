/**
 * DSL 参数解析与循环决策（纯函数，无副作用）
 *
 * 供「地图追踪」「键鼠脚本」两个 type 共用的**方法重载**。
 *
 * ------------------------------------------------------------------
 * 三种格式（向后兼容，格式 1 完全不变）
 * ------------------------------------------------------------------
 *
 *   格式 1：  路径名
 *             最原始、最正常的调用。等价于「执行 1 次、不循环」。
 *
 *   格式 2：  路径名  number  主界面  boolean
 *             · number   最大循环次数，0-99 有效
 *                          0 = 跳过此条（执行 0 次）
 *                          1 = 最多执行 1 次（等同格式 1 的行为）
 *                          2 = 最多执行 2 次
 *             · 主界面   字面量，**必须原样写「主界面」**，代表循环条件：
 *                          每执行完一遍都判断是否在主界面，
 *                          在 → 继续下一轮；不在 → 跳出，正常执行下一行
 *             · boolean  超出最大次数时：true = 暂停（等用户手动处理）；
 *                          false = 忽视，正常执行下一行
 *
 *   格式 3：  路径名  number  图片路径  boolean1  boolean2
 *             · number   同格式 2
 *             · 图片路径 执行完一遍后做模板匹配（参考 rec.md）
 *             · boolean1 true  = 「匹配到结果」时跳出循环
 *                          false = 「没匹配到结果」时跳出循环
 *             · boolean2 同格式 2 的 boolean
 *
 * 两种循环条件的区别：
 *   格式 2 是「**不在**主界面就跳出」（在 → 继续）
 *   格式 3 是「**匹配命中/未命中**就跳出」（按 boolean1 决定哪个算跳出）
 *
 * ------------------------------------------------------------------
 * 判定方式
 * ------------------------------------------------------------------
 *   第 3 个 token 恰好是「主界面」→ 格式 2，否则 → 格式 3。
 *   这样两种格式的 token 个数不同（5 vs 6，不含指令名），不会歧义。
 */

/** 最大循环次数上限（含） */
export const MAX_COUNT_LIMIT = 99;

/** 格式 2 的循环条件字面量 —— process.json 里必须原样写这三个字 */
export const MAIN_UI_KEYWORD = '主界面';

/**
 * 解析布尔值。只接受 true/false（大小写不敏感）。
 * 不把 1/0/yes 之类当布尔，避免用户笔误被静默接受。
 */
function parseBool(token) {
  if (typeof token !== 'string') return null;
  const t = token.trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return null;
}

/**
 * 把一行 DSL 的参数部分解析成结构化对象。
 *
 * @param {string} raw 指令名之后的原始参数字符串（已去掉行内注释）
 * @returns {{
 *   ok: boolean,            // 是否解析成功（失败时应回退到格式 1 语义）
 *   error: string,          // 失败原因（ok=false 时有值）
 *   path: string,           // 路径名（格式 1/2/3 都有）
 *   format: 1|2|3,          // 识别到的格式
 *   maxCount: number,       // 最大循环次数（格式 1 恒为 1）
 *   condition: 'none'|'mainui'|'image',
 *   image: string,          // 图片路径（仅 condition='image'）
 *   matchTrue: boolean|null,// 仅 condition='image'：true=匹配到就跳出
 *   pauseOnExceed: boolean  // 超出最大次数时是否暂停
 * }}
 */
export function parseRepeatableArgs(raw) {
  const result = {
    ok: true,
    error: '',
    path: '',
    format: 1,
    maxCount: 1,
    condition: 'none',
    image: '',
    matchTrue: null,
    pauseOnExceed: false,
  };

  const text = String(raw == null ? '' : raw).trim();
  if (!text) {
    result.ok = false;
    result.error = '参数为空';
    return result;
  }

  // 按空白切分。路径名本身不允许含空格（项目内实测无此情况）。
  const tokens = text.split(/\s+/).filter(Boolean);
  result.path = tokens[0];

  // ---- 格式 1：只有路径名 ----
  if (tokens.length === 1) {
    return result;                       // format=1, maxCount=1
  }

  const count = tokens[1];
  const third = tokens[2];

  // 次数必须是 0-99 的整数
  const n = /^\d+$/.test(count) ? parseInt(count, 10) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT_LIMIT) {
    result.ok = false;
    result.error = `循环次数「${count}」无效（应为 0-${MAX_COUNT_LIMIT} 的整数）`;
    return result;
  }

  // ---- 格式 2：路径 次数 主界面 boolean ----
  if (third === MAIN_UI_KEYWORD) {
    result.format = 2;
    result.maxCount = n;
    result.condition = 'mainui';

    if (tokens.length >= 4) {
      const b = parseBool(tokens[3]);
      if (b === null) {
        result.ok = false;
        result.error = `第 4 个参数「${tokens[3]}」应为 true 或 false`;
        return result;
      }
      result.pauseOnExceed = b;
    }
    return result;
  }

  // ---- 格式 3：路径 次数 图片路径 boolean1 boolean2 ----
  result.format = 3;
  result.maxCount = n;
  result.condition = 'image';
  result.image = third || '';

  if (!result.image) {
    result.ok = false;
    result.error = '缺少图片路径';
    return result;
  }

  // tokens 索引：0=路径 1=次数 2=图片 3=布尔1 4=布尔2
  if (tokens.length >= 4) {
    const b1 = parseBool(tokens[3]);
    if (b1 === null) {
      result.ok = false;
      result.error = `第 4 个参数「${tokens[3]}」应为 true 或 false`;
      return result;
    }
    result.matchTrue = b1;
  }
  if (tokens.length >= 5) {
    const b2 = parseBool(tokens[4]);
    if (b2 === null) {
      result.ok = false;
      result.error = `第 5 个参数「${tokens[4]}」应为 true 或 false`;
      return result;
    }
    result.pauseOnExceed = b2;
  }
  return result;
}

/**
 * 循环决策（纯函数）。
 *
 * 每次「执行完一遍」之后调用，判断下一步该做什么。
 *
 * ★ 判定顺序很关键：**先看跳出条件，再看次数上限**。
 *   因为「跑满次数」和「满足跳出条件」可能在同一轮同时成立，
 *   此时应当**正常跳出**而不是暂停 —— 例如格式 2 跑第 3 次时
 *   已经离开主界面（正是期望结果），若先判次数就会误暂停。
 *
 * @param {object} p          parseRepeatableArgs 的结果
 * @param {number} executed   已执行次数（调用前已 +1）
 * @param {boolean|null} matched 本轮的判定结果：
 *                        condition='mainui' → 是否在主界面
 *                        condition='image'  → 模板匹配是否命中
 * @returns {{action:'run'|'stop'|'pause', reason:string}}
 *   · run   继续下一轮
 *   · stop  正常跳出，执行 process.json 下一行
 *   · pause 跑满次数仍未满足跳出条件，且 pauseOnExceed=true → 暂停
 */
export function decideRepeat(p, executed, matched) {
  // ① 先判断「跳出条件」是否已满足
  let exitMet = false;
  let what = '';

  if (p.condition === 'mainui') {
    // 在主界面 → 继续；不在主界面 → 跳出
    exitMet = !matched;
    what = matched ? '仍在主界面' : '已离开主界面';
  } else if (p.condition === 'image') {
    const hit = !!matched;
    // matchTrue=true  → 匹配到就跳出
    // matchTrue=false → 没匹配到就跳出
    exitMet = (p.matchTrue === true) ? hit : !hit;
    what = hit ? '模板匹配命中' : '模板匹配未命中';
  }

  if (exitMet) {
    return { action: 'stop', reason: `${what}，跳出循环` };
  }

  // ② 跳出条件未满足，且已跑满最大次数 → 暂停 or 忽视
  if (executed >= p.maxCount) {
    if (p.pauseOnExceed) {
      return { action: 'pause', reason: `已达最大循环次数 ${p.maxCount}，${what}` };
    }
    return { action: 'stop', reason: `已达最大循环次数 ${p.maxCount}（忽视），${what}` };
  }

  // ③ 继续下一轮
  return { action: 'run', reason: `${what}，继续循环（第 ${executed + 1} 次）` };
}

/**
 * 判断一条指令是否需要进入「重复执行」流程。
 * 格式 1 与 maxCount=0 都按普通单次语义处理（0 次 = 直接跳过）。
 */
export function needsRepeat(p) {
  return p.condition !== 'none' && p.maxCount > 0;
}

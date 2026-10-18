/**
 * DSL 参数解析与循环决策（纯函数，无副作用）
 *
 * 供「地图追踪」「键鼠脚本」两个 type 共用，三种格式：
 *   格式 1：路径名
 *   格式 2：路径名 次数 主界面 boolean
 *   格式 3：路径名 次数 图片路径 boolean1 boolean2
 *
 * 次数：0-99，0 = 跳过此条（执行 0 次）。
 * 主界面：循环条件，每轮结束后判断是否在主界面，在 → 继续下一轮。
 * boolean：超出最大次数时 true = 暂停，false = 正常执行下一行。
 * 图片路径：每轮结束后做模板匹配，boolean1 决定命中还是未命中时跳出。
 */

/** 最大循环次数上限（含） */
export const MAX_COUNT_LIMIT = 99;

/** 格式 2 的循环条件字面量 */
export const MAIN_UI_KEYWORD = '主界面';

/** 解析布尔值：只接受 true/false（大小写不敏感） */
function parseBool(token) {
  if (typeof token !== 'string') return null;
  const t = token.trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return null;
}

/** 解析一行 DSL 的参数部分 */
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

  const tokens = text.split(/\s+/).filter(Boolean);
  result.path = tokens[0];

  // 格式 1：只有路径名
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

  // 格式 2：路径 次数 主界面 boolean
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

  // 格式 3：路径 次数 图片路径 boolean1 boolean2
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

/** 循环决策（纯函数）：每次执行完一遍后调用，返回 run / stop / pause */
export function decideRepeat(p, executed, matched) {
  // 先判断「跳出条件」是否已满足
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

  // 跳出条件未满足，且已跑满最大次数 → 暂停 or 忽视
  if (executed >= p.maxCount) {
    if (p.pauseOnExceed) {
      return { action: 'pause', reason: `已达最大循环次数 ${p.maxCount}，${what}` };
    }
    return { action: 'stop', reason: `已达最大循环次数 ${p.maxCount}（忽视），${what}` };
  }

  // 继续下一轮
  return { action: 'run', reason: `${what}，继续循环（第 ${executed + 1} 次）` };
}

/** 判断一条指令是否需要进入「重复执行」流程 */
export function needsRepeat(p) {
  return p.condition !== 'none' && p.maxCount > 0;
}

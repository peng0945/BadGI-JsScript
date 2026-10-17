

import {
  initOverlay,
  showOverlay,
  disposeOverlay,
  sendProgress,
  sendProcessList,
  resetElapsed,
  sendCurrentLine,
  sendLoopProgress,
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
  pumpAndBeat,
  initKeyHook,
  subscribeKey,
  unsubscribeKey,
  waitWhileInteracting,
} from "./utils/overlay.js";

/* ★ 「地图追踪 / 键鼠脚本」的参数重载与循环决策（纯函数，便于单测） */
import {
  parseRepeatableArgs,
  decideRepeat,
  needsRepeat,
  MAIN_UI_KEYWORD,
} from "./utils/dsl.js";

(async function () {
  // 版本和编译信息
  const VERSION = "1.46";
  const BUILD_TIME = "2026.07.12";

  // 读取设置
  const team = settings.team || "";
  const elementTeam = settings.elementTeam || "";
  const selectedProcessInit = settings.process_selector || "刷新剧情列表";
  let selectedProcess = selectedProcessInit;   // let：运行面板「切换剧情」需要改写
  let relativePath;

  /* ★ 暂停通知的上下文：当前剧情名 + 当前执行的 DSL 行。
     由 runInstr（每执行一条指令前）与 Main（切换剧情时）维护，
     供 pauseNotice() 组装「当前运行：xxx，第 N 行 xxx」这类提示。

     为什么要单独存一份：三处暂停逻辑（参数重载超限 / 注入失败 / 暂停指令）
     分散在 Execute 与 Main 里，而「当前剧情名」是 Main 的局部变量，
     所以必须提到模块级共享。 */
  let notifyCtx = { process: '', line: 0, raw: '' };

  async function errorlog() {
    // 输出版本和编译时间信息
    log.info("=".repeat(20));
    log.info("版本: {version}", VERSION);
    log.info("编译时间: {buildTime}", BUILD_TIME);
    log.info("=".repeat(20));
  }

  /* ------------------------------------------------------------------ */
  /* 暂停增强：暂停前按键 + 带上下文的暂停通知                            */
  /* ------------------------------------------------------------------ */

  /**
   * 记录「当前正在执行哪一行」，供暂停通知使用。
   * 由 runInstr 每条指令前调用。
   *
   * ★ 只更新「行」信息。剧情名由 Main 通过 setNotifyProcess() 单独维护 ——
   *   因为 currentName 是 Main 的局部变量，runInstr（在 executeSimpleScriptFlow
   *   里）访问不到，所以两者必须分开设置。
   */
  function setNotifyContext(instr) {
    notifyCtx.line = (instr && instr.line) || 0;
    notifyCtx.raw = (instr && (instr.raw || instr.type)) || '';
  }

  /** 记录「当前运行哪个剧情」（由 Main 在开始/切换剧情时调用） */
  function setNotifyProcess(name) {
    notifyCtx.process = name || '';
  }

  /**
   * 「暂停前按键操作」—— 实验性功能。
   *
   * 目的：在脚本即将暂停（等用户手动处理游戏）之前，先按一下用户配置的键，
   *       把游戏内时间/剧情暂停住，避免脚本停住时游戏还在推进。
   *
   * 配置：settings.pauseBeforeKey（settings.json 里的 input-text）
   *   · 未填写 / 空白 → **不执行任何操作**（保持原有行为）
   *   · 填写了键名    → 按下并释放该键
   *
   * 用 try/catch 包住：实验性功能失败**不能**影响正常的暂停流程。
   * 键名走 BetterGI 虚拟键代码表（VK_ 可省略，大小写不敏感）。
   */
  function pressPauseBeforeKey() {
    const key = String(settings.pauseBeforeKey || '').trim();
    if (!key) return;                       // 没填 → 不操作
    try {
      keyPress(key);
      log.info(`暂停前按键操作：已按下 ${key}`);
    } catch (e) {
      log.warn(`暂停前按键操作失败（键名 ${key}）：${e && e.message}`);
    }
  }

  /**
   * 组装并发送「暂停通知」。
   *
   * 格式（用户指定）：
   *   当前运行：<剧情名>，第<行号>行 <DSL 原文>，<暂停原因>，脚本已暂停，请手动操作游戏
   * 例：
   *   当前运行：捕风的异乡人9503，第78行 键鼠脚本 风起地神像精准2.0.json 3 主界面 true，
   *   超出最大循环次数，脚本已暂停，请手动操作游戏
   *
   * @param {string} reason 实际暂停原因
   * @returns {string} 组装好的完整文案（同时用于日志，便于对照）
   *
   * 注意 notification 的限制（见 bettergi-docs/src/dev/js/notification.md）：
   *   单条 ≤500 字符；1 分钟最多 5 条；不允许 HTML 标签与 URL。
   *   所以这里对 DSL 原文做长度截断，避免个别超长行把消息顶爆。
   */
  function buildPauseNotice(reason) {
    const name = notifyCtx.process || '（未选择剧情）';
    const parts = [`当前运行：${name}`];
    if (notifyCtx.line) {
      // DSL 原文可能很长（如带注释的行），截断以免超过 500 字符上限
      const raw = String(notifyCtx.raw || '').trim();
      const shown = raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
      parts.push(`第${notifyCtx.line}行 ${shown}`);
    }
    parts.push(reason || '未知原因');
    parts.push('脚本已暂停，请手动操作游戏');
    return parts.join('，');
  }

  /**
   * 暂停时的统一入口：先按「暂停前按键」，再发通知。
   * 三处暂停逻辑都走它，保证行为一致。
   *
   * @param {string} reason 实际暂停原因
   */
  function pauseNotice(reason) {
    pressPauseBeforeKey();
    const msg = buildPauseNotice(reason);
    log.warn(msg);
    if (settings.xiaoxitongzhi) notification.error(msg);
    return msg;
  }

  // 统一常量定义
  const Datas = {
    // 文件路径常量
    SUPPORT_LIST_PATH: "name.json",
    OUTPUT_DIR: "Data",
    TALK_PROCESS_BASE_PATH: "assets/process"
  };

  // 获取设置
  /*const getSetting = async () => {
    try {
      const skipRecognition = settings.skipRecognition || false;
      const prepare = settings.prepare || false;
      const team = settings.team || "";
      const skipCommissions = "";

      const result = {
        skipRecognition,
        prepare,
        team,
        skipCommissions,
      };

      log.debug("setting:{index}", result);

      return result;
    } catch {
      log.error("getSetting函数出现错误,将使用默认配置");
      return {
        skipRecognition: false,
        prepare: true,
        team: "",
        skipCommissions: "",
      };
    }
  };

  const { skipRecognition, prepare, team, skipCommissions } =
    await getSetting();*/
// 定义识别对象

const paimonMenuRo = RecognitionObject.TemplateMatch(
  file.ReadImageMatSync("Data/RecognitionObject/paimon_menu.png"),
  0,
  0,
  genshin.width / 3.0,
  genshin.width / 5.0
);
//新增识别退出按钮
const exitBtnRo = RecognitionObject.TemplateMatch(
  file.ReadImageMatSync("Data/RecognitionObject/exitbtn.png"),
  0,
  0,
  genshin.width / 3.0,
  genshin.width / 5.0
);

// 判断是否在主界面的函数
const isInMainUI = () => {
  let captureRegion = captureGameRegion();
  let res = captureRegion.Find(paimonMenuRo)
  let res2 = captureRegion.Find(exitBtnRo);
  return !res.isEmpty() || !res2.isEmpty();
};

  const Utils = {
    iframe: async ({ X, Y, WIDTH, HEIGHT }) => {
      try {
        log.info("i{index}", { X, Y, WIDTH, HEIGHT });

        // 最简单的方式创建OCR识别对象
        const ro = RecognitionObject.Ocr(X, Y, WIDTH, HEIGHT);
        ro.Name = "debug";
        ro.DrawOnWindow = true;

        // 捕获并识别
        const region = captureGameRegion();
        region.Find(ro);

        // 2000毫秒后移除绘制的边框
        setTimeout(() => {
          // 使用相同的名称移除边框
          const drawContent = VisionContext.Instance().DrawContent;
          drawContent.RemoveRect("debug");
          // 或者也可以使用 drawContent.Clear() 清除所有绘制的内容

          log.info("已移除边框");
        }, 2000);
      } catch (error) {
        // 记录完整错误信息
        log.error("详细错误: " + JSON.stringify(error));
      }
    },
    easyOCR: async ({ X, Y, WIDTH, HEIGHT }) => {
      try {
        // log.info("进行文字识别")
        // 创建OCR识别对象
        const locationOcrRo = RecognitionObject.Ocr(X, Y, WIDTH, HEIGHT);

        // 截图识别
        let captureRegion = captureGameRegion();
        let OCRresults = await captureRegion.findMulti(locationOcrRo);

        return OCRresults;
      } catch (error) {
        log.error("easyOCR识别出错: {error}", error.message);
        return { count: 0 };
      }
    },
    easyOCROne: async (ocrdata) => {
      results = await Utils.easyOCR(ocrdata);
      if (results.count > 0) {
        // 取第一个结果作为地点
        return results[0].text.trim();
      }
      return "";
    },
    // 清理文本（去除标点符号等）
    cleanText: (text) => {
      if (!text) return "";
      // 去除标点符号和特殊字符
      return text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "").trim();
    },
    // 规范化文本（清理并转小写）
    normalizeText: (text) => {
      return Utils.cleanText(String(text || "")).toLowerCase();
    },
    // Levenshtein 距离
    levenshteinDistance: (a, b) => {
      const s = String(a || "");
      const t = String(b || "");
      const n = s.length;
      const m = t.length;
      if (n === 0) return m;
      if (m === 0) return n;
      const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
      for (let i = 0; i <= n; i++) d[i][0] = i;
      for (let j = 0; j <= m; j++) d[0][j] = j;
      for (let i = 1; i <= n; i++) {
        const si = s.charCodeAt(i - 1);
        for (let j = 1; j <= m; j++) {
          const tj = t.charCodeAt(j - 1);
          const cost = si === tj ? 0 : 1;
          d[i][j] = Math.min(
            d[i - 1][j] + 1,
            d[i][j - 1] + 1,
            d[i - 1][j - 1] + cost
          );
        }
      }
      return d[n][m];
    },
    // 文本相似度 [0,1]
    similarity: (a, b) => {
      const s1 = Utils.normalizeText(a);
      const s2 = Utils.normalizeText(b);
      if (!s1 && !s2) return 1;
      if (!s1 || !s2) return 0;
      const dist = Utils.levenshteinDistance(s1, s2);
      const maxLen = Math.max(s1.length, s2.length);
      return 1 - dist / maxLen;
    },

    // 读取角色别名文件
    readAliases: () => {
      try {
        const combatText = file.ReadTextSync("Data/avatar/combat_avatar.json");
        const combatData = JSON.parse(combatText);
        const aliases = {};
        for (const character of combatData) {
          if (character.alias && character.name) {
            for (const alias of character.alias) {
              aliases[alias] = character.name;
            }
          }
        }
        return aliases;
      } catch (error) {
        log.error("读取角色别名文件失败: {error}", error.message);
        return {};
      }
    },
  };

  const UI = {
    // 角色选择界面滚动页面函数
    scrollPage: async (totalDistance, stepDistance = 10, delayMs = 5) => {
      try {
        moveMouseTo(400, 750);
        await sleep(50);
        leftButtonDown();
        const steps = Math.ceil(totalDistance / stepDistance);
        for (let j = 0; j < steps; j++) {
          const remainingDistance = totalDistance - j * stepDistance;
          const moveDistance =
            remainingDistance < stepDistance ? remainingDistance : stepDistance;
          moveMouseBy(0, -moveDistance);
          await sleep(delayMs);
        }
        await sleep(700);
        leftButtonUp();
        await sleep(100);
        return true;
      } catch (error) {
        log.error(`角色选择界面滚动操作时发生错误：${error.message}`);
        return false;
      }
    },
  };

  // 步骤处理器类 - 处理不同类型的委托执行步骤
  // TAG:添加脚本功能点1
  const StepProcessor = {
    // 处理地图追踪步骤
    processMapTracking: async (step, processFilePath) => {
      //log.info("1");
      const normalizedPath = processFilePath.replace(/\\/g, '/');
      const processDir = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
      const fullPath = `${processDir}/${step.data}`;
      log.info("执行地图追踪: {path}", fullPath);
      try {
        await pathingScript.runFile(fullPath);
        log.info("地图追踪执行完成");
      } catch (error) {
        log.error("执行地图追踪时出错: {error}", error.message);
        throw error;
      }
    },

    // 处理追踪委托步骤
    processCommissionTracking: async (step) => {
      try {
        // 获取目标NPC名称和图标类型
        let targetNpc = "";
        let iconType = "bigmap";

        if (typeof step.data === "string") {
          targetNpc = step.data;
        } else if (typeof step.data === "object") {
          if (step.data.npc) targetNpc = step.data.npc;
          if (step.data.iconType) iconType = step.data.iconType;
        }

        log.info(
          "执行追踪委托，目标NPC: {target}，图标类型: {type}",
          targetNpc,
          iconType
        );
        await Execute.autoNavigateToTalk(targetNpc, iconType);
        log.info("追踪委托执行完成");
      } catch (error) {
        log.error("执行追踪委托时出错: {error}", error.message);
        throw error;
      }
    },

    // 处理键鼠脚本步骤
    processKeyMouseScript: async (step, processFilePath) => {
      const normalizedPath = processFilePath.replace(/\\/g, '/');
      const processDir = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
      const fullPath = `${processDir}/${step.data}`;
      log.info("执行键鼠脚本: {path}", fullPath);
      try {
        await keyMouseScript.runFile(fullPath);
        log.info("键鼠脚本执行完成");
      } catch (error) {
        log.error("执行键鼠脚本时出错: {error}", error.message);
        throw error;
      }
    },

 // 处理按键步骤
// 处理按键步骤（新增长按/多键同步功能）
  // 执行按键操作
processKeyPress: async (step) => {
  // 解析按键数据
  const parseKeyData = (data) => {
  log.info("data: {data}", data);
    let action = "press"; // 默认点按
    let keys = [];
    let duration = 5000; // 长按默认时长（毫秒）
    data = String(data);//转为字符串
    if (typeof data === "string") {
      // 简化格式："F" → 点按F；"长按 W" → 长按W5秒；"长按 Shift,W 4000" → 同步长按Shift+W 4秒
      const parts = data.split(' ');
      if (parts[0] === "长按") {
        action = "longpress";
        // 提取按键（支持多键用逗号分隔）
        const keyPart = parts[1];
        keys = keyPart.split(",").map(k => k.trim());
        // 提取自定义时长（可选）
        if (parts[2] && !isNaN(parseInt(parts[2]))) {
          duration = parseInt(parts[2]);
        }
      } else if (parts[0] === "松开") {
        action = "release";
        keys = parts[1].split(",").map(k => k.trim());
      } else if (parts[0] === "点按") {
        // 完整格式："点按 F"
        action = "press";
        keys = [parts[1]];
      }
        else if (parts[0] === "按下"){
        action = "down";
        // 提取按键（支持多键用逗号分隔）
        const keyPart = parts[1];
        keys = keyPart.split(",").map(k => k.trim());
      } else {
        // 简化点按："F"
        keys = [data];
      }
    } else if (typeof data === "object") {
      // 对象格式兼容（保留原有逻辑）
      action = data.action || "press";
      if (action === "longpress") {
        keys = Array.isArray(data.key) ? data.key : [data.key];
        duration = data.duration || 5000;
      } else {
        keys = Array.isArray(data.key) ? data.key : [data.key];
      }
    }
    return { action, keys, duration };
  };

  const { action, keys, duration } = parseKeyData(step.data);

  // 执行按键操作
	switch (action) {
    case "press":
      // 单键/多键点按（依次点击）
      for (const key of keys) {
        log.info(`点击按键: ${key}`);
        keyPress(key);
        await sleep(100); // 多键点按间隔
      }
      break;
    case "down":
      // 单键/多键按下（不松开）
      for (const key of keys) {
        log.info(`按下按键: ${key}`);
        keyDown(key);
      }
      break;
    case "up":
      // 单键/多键松开
      for (const key of keys) {
        log.info(`释放按键: ${key}`);
        keyUp(key);
      }
      break;
    case "longpress":
      // 单键/多键同步长按
      log.info(`同步长按按键: ${keys.join(", ")}，时长: ${duration}毫秒`);
      // 按下所有键
      for (const key of keys) {
        keyDown(key);
      }
      // 保持长按
      await sleep(duration);
      // 松开所有键
      for (const key of keys) {
        keyUp(key);
      }
      log.info(`长按结束，已释放按键: ${keys.join(", ")}`);
      break;
    case "release":
      // 手动松开多键
      log.info(`同步释放按键: ${keys.join(", ")}`);
      for (const key of keys) {
        keyUp(key);
      }
      break;
	  }
	},



    // 处理等待主界面步骤
    processWaitMainUI: async (time) => {
      for (let i = 0; i < time; i++) {
        if (isInMainUI()) {
          log.info("检测到已返回主界面，结束等待");
          break;
        }
        await sleep(1000);
      }
      if (!isInMainUI()) {
        log.info("等待返回主界面超时，尝试继续执行后续步骤");
      }
    },

    // 处理角色切换步骤
    processSwitchRole: async (step) => {
      try {
        const { position, character } = step.data;

        if (!position || !character) {
          log.error("角色切换参数不完整，需要 position 和 character");
          return false;
        }

        log.info(`开始切换角色：第${position}号位 -> ${character}`);

        const positionCoordinates = [
          [460, 538],
          [792, 538],
          [1130, 538],
          [1462, 538],
        ];

        // 读取别名
        const aliases = Utils.readAliases();
        const actualName = aliases[character] || character;
        log.info(`设置对应号位为【${character}】，切换角色为【${actualName}】`);

        // 识别对象定义
        const roTeamConfig = RecognitionObject.TemplateMatch(
          file.ReadImageMatSync(`Data/RecognitionObject/队伍配置.png`),
          0,
          0,
          1920,
          1080
        );
        const roReplace = RecognitionObject.TemplateMatch(
          file.ReadImageMatSync(`Data/RecognitionObject/更换.png`),
          0,
          0,
          1920,
          1080
        );
        const roJoin = RecognitionObject.TemplateMatch(
          file.ReadImageMatSync(`Data/RecognitionObject/加入.png`),
          0,
          0,
          1920,
          1080
        );

        let openPairingTries = 0;
        let totalOpenPairingTries = 0;

        // 打开配对界面的内部函数
        const openPairingInterface = async () => {
          while (openPairingTries < 3) {
            keyPress("l");
            await sleep(3500);
            const teamConfigResult = captureGameRegion().find(roTeamConfig);
            if (teamConfigResult.isExist()) {
              openPairingTries = 0;
              return true;
            }
            openPairingTries++;
            totalOpenPairingTries++;
          }
          if (totalOpenPairingTries < 6) {
            await genshin.tp("2297.630859375", "-824.5517578125");
            openPairingTries = 0;
            return openPairingInterface();
          } else {
            log.error("无法打开配对界面，任务结束");
            return false;
          }
        };

        if (!(await openPairingInterface())) {
          return false;
        }

        const rolenum = position;
        const selectedCharacter = actualName;
        const [x, y] = positionCoordinates[position - 1];
        click(x, y);
        log.info(`开始设置${rolenum}号位角色`);
        await sleep(1000);
        let characterFound = false;
        let pageTries = 0;

        // 最多尝试滚动页面20次
        while (pageTries < 20) {
          // 尝试识别所有可能的角色文件名
          for (let num = 1; ; num++) {
            const paddedNum = num.toString().padStart(2, "0");
            const characterFileName = `${selectedCharacter}${paddedNum}`;
            try {
              const characterRo = RecognitionObject.TemplateMatch(
                file.ReadImageMatSync(
                  `Data/characterimage/${characterFileName}.png`
                ),
                0,
                0,
                1920,
                1080
              );
              const characterResult = captureGameRegion().find(characterRo);
              if (characterResult.isExist()) {
                log.info(`已找到角色${selectedCharacter}`);
                // 计算向右偏移35像素、向下偏移35像素的位置
                const targetX = characterResult.x + 35;
                const targetY = characterResult.y + 35;

                // 边界检查，确保坐标在屏幕范围内
                const safeX = Math.min(Math.max(targetX, 0), 1920);
                const safeY = Math.min(Math.max(targetY, 0), 1080);

                click(safeX, safeY);
                await sleep(500); // 点击角色后等待0.5秒
                characterFound = true;
                break;
              }
            } catch (error) {
              // 如果文件不存在，跳出循环
              break;
            }
          }

          if (characterFound) {
            break;
          }

          // 如果不是最后一次尝试，尝试滚动页面
          if (pageTries < 15) {
            log.info("当前页面没有目标角色，滚动页面");
            await UI.scrollPage(200); // 使用UI模块的scrollPage函数
          }
          pageTries++;
        }

        if (!characterFound) {
          log.error(`未找到【${selectedCharacter}】`);
          return false;
        }

        // 识别"更换"或"加入"按钮
        const replaceResult = captureGameRegion().find(roReplace);
        const joinResult = captureGameRegion().find(roJoin);

        if (replaceResult.isExist() || joinResult.isExist()) {
          await sleep(300);
          click(68, 1020);
          keyPress("VK_LBUTTON");
          await sleep(500);
          log.info(`角色切换完成：${character} -> ${actualName}`);
          return true;
        } else {
          log.error(`该角色已在队伍中，无需切换`);
          await sleep(300);
          keyPress("VK_ESCAPE");
          await sleep(500);
          return false;
        }
      } catch (error) {
        log.error("角色切换过程中出错: {error}", error.message);
        return false;
      }
    },

    // 处理自动任务步骤
    processAutoTask: async (step) => {
      try {
        const { action, taskType, config } = step.data;

        if (!action) {
          log.error("自动任务参数不完整，需要 action 参数");
          return false;
        }

        log.info("执行自动任务操作: {action}", action);

        switch (action) {
          case "enable":
            // 启用自动任务
            if (!taskType) {
              log.error("启用自动任务需要指定 taskType");
              return false;
            }
            
            if (config && typeof config === "object") {
              log.info("启用自动任务: {type}，配置: {config}", taskType, JSON.stringify(config));
              dispatcher.addTimer(new RealtimeTimer(taskType, config));
            } else {
              log.info("启用自动任务: {type}", taskType);
              dispatcher.addTimer(new RealtimeTimer(taskType));
            }
            break;

          case "disable":
            // 取消所有自动任务
            log.info("取消所有自动任务");
            dispatcher.ClearAllTriggers();
            break;

          default:
            log.error("未知的自动任务操作: {action}", action);
            return false;
        }

        return true;
      } catch (error) {
        log.error("处理自动任务步骤时出错: {error}", error.message);
        return false;
      }
    },
  };

  // 步骤处理器工厂 - 更好的扩展性设计
  // TAG:添加脚本功能点2
  const StepProcessorFactory = {
    // 步骤处理器映射表
    processors: {
      地图追踪: async (step, context) => {
        await StepProcessor.processMapTracking(
          step,
          context
        );
      },

      等待: async (step, context) => {
        const waitTime = step.data || 5000;
        log.info("等待 {time} 毫秒", waitTime);
        await sleep(waitTime);
      },

      追踪委托: async (step, context) => {
        await StepProcessor.processCommissionTracking(step);
      },

      键鼠脚本: async (step, context) => {
        await StepProcessor.processKeyMouseScript(
          step,
          context
        );
      },

      对话: async (step, context) => {
        await Execute.processDialogStep(
          step,
          context.priorityOptions,
          context.npcWhiteList,
          context.isInMainUI
        );
      },

	  按键: async (step, context) => {
      await StepProcessor.processKeyPress(step);
      },

      tp: async (step, context) => {
        await StepProcessor.processTeleport(step);
      },

      等待返回主界面: async (step, context) => {
        await StepProcessor.processWaitMainUI();
      },

      切换角色: async (step, context) => {
        await StepProcessor.processSwitchRole(step);
      },

      自动任务: async (step, context) => {
        await StepProcessor.processAutoTask(step);
      },
	  长按: async (step, context) => {
		const keydownTime = context.data || 3000;
        log.info("等待 {keydownTime} 毫秒", keydownTime);
		keyDown(data.step)
        await sleep(keydownTime);
		keyup(data.step)
        await StepProcessor.longpressthebutton(step);
      },
    },

    // 注册新的步骤处理器
    register: (stepType, processor) => {
      StepProcessorFactory.processors[stepType] = processor;
      log.info("注册新的步骤处理器: {type}", stepType);
    },

    // 处理步骤
    process: async (step, context) => {
      const processor = StepProcessorFactory.processors[step.type];
      if (processor) {
        await processor(step, context);
      } else {
        log.warn("未知的流程类型: {type}", step.type);
      }
    },
  };

  // UI工具模块 - 处理UI检测和文本提取等工具函数
  const UIUtils = {
    // 创建主界面检测函数
    createMainUIChecker: () => {
      const paimonMenuRo = RecognitionObject.TemplateMatch(
        file.ReadImageMatSync("Data/RecognitionObject/paimon_menu.png"),
        0,
        0,
        genshin.width / 3.0,
        genshin.width / 5.0
      );
      const exitBtnRo = RecognitionObject.TemplateMatch(
        file.ReadImageMatSync("Data/RecognitionObject/exitbtn.png"),
        0,
        0,
        genshin.width / 3.0,
        genshin.width / 5.0
      );

      return () => {
        let captureRegion = captureGameRegion();
        let res = captureRegion.Find(paimonMenuRo);
        let res2 = captureRegion.Find(exitBtnRo);
        return !res.isEmpty() || !res2.isEmpty();
      };
    },

    // 人名提取函数
    extractName: (text) => {
      const patterns = [
        /与(.+?)对话/,
        /与(.+?)一起/,
        /同(.+?)交谈/,
        /向(.+?)打听/,
        /向(.+?)回报/,
        /向(.+?)报告/,
        /给(.+?)听/,
        /陪同(.+?)\S+/,
        /找到(.+?)\S+/,
        /询问(.+?)\S+/,
        /拜访(.+?)\S+/,
        /寻找(.+?)\S+/,
        /告诉(.+?)\S+/,
        /带(.+?)去\S+/,
        /跟随(.+?)\S+/,
        /协助(.+?)\S+/,
        /请教(.+?)\S+/,
        /拜托(.+?)\S+/,
        /委托(.+?)\S+/,
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          return match[1].trim();
        }
      }
      return null;
    },

    // OCR点击指定文本（包含关系），支持 Alt+Click
    clickTargetByText: async (text, region = { X: 0, Y: 0, WIDTH: 1920, HEIGHT: 1080 }) => {
      try {
        const results = await Utils.easyOCR(region);
        for (let i = 0; i < results.count; i++) {
          const item = results[i];
          if (item && item.text && item.text.includes(text)) {
            keyDown("VK_MENU");
            await sleep(200);
            click(item.x, item.y);
            leftButtonClick();
            await sleep(200);
            keyUp("VK_MENU");
            return true;
          }
        }
        return false;
      } catch (e) {
        log.error("clickTargetByText 出错: {error}", e.message);
        return false;
      }
    },
  };

  // 对话处理模块 - 处理自动对话相关功能
  const DialogProcessor = {
    // 执行优化的自动对话
    executeOptimizedAutoTalk: async (
      extractedName = null,
      skipCount = 5,
      customPriorityOptions = null,
      customNpcWhiteList = null,
      isInMainUI
    ) => {
      // 使用传入的参数，不再加载默认配置
      const effectivePriorityOptions = customPriorityOptions || [];
      const effectiveNpcWhiteList = customNpcWhiteList || [];

      // 初始化
      keyPress("V");

      // 初始触发剧情 - 识别人名并点击
      extractedName = [];
      // 人名区域OCR识别
      const nameRegion = { X: 75, Y: 240, WIDTH: 225, HEIGHT: 60 };
      let nameResults = await Utils.easyOCR(nameRegion);
      // 尝试提取任务人名
      for (let i = 0; i < nameResults.count; i++) {
        let text = nameResults[i].text;
        log.info(`任务区域识别文本: ${text}`);

        // 尝试提取任务人名
        let name = UIUtils.extractName(text);
        if (name) {
          extractedName = name;
          log.info(`提取到人名: ${extractedName}`);
          break;
        }
      }

      // 对话选项区域OCR识别
      const dialogRegion = { X: 1150, Y: 300, WIDTH: 350, HEIGHT: 400 };
      nameResults = await Utils.easyOCR(dialogRegion);
      let clickedWhitelistNPC = false;
      let clickedExtractedName = false;

      // 处理人名区域的OCR结果
      if (nameResults.count > 0) {
        log.info(`人名区域识别到 ${nameResults.count} 个文本`);

        // 首先尝试点击白名单中的NPC
        for (let i = 0; i < nameResults.count; i++) {
          let text = nameResults[i].text;
          let res = nameResults[i];
          log.info(
            "人名区域识别到{text}:位置({x},{y},{h},{w})",
            res.text,
            res.x,
            res.y,
            res.width,
            res.Height
          );
          // 检查是否包含白名单中的NPC名称
          for (let j = 0; j < effectiveNpcWhiteList.length; j++) {
            if (text.includes(effectiveNpcWhiteList[j])) {
              log.info(`找到白名单NPC: ${effectiveNpcWhiteList[j]}，点击该NPC`);
              keyDown("VK_MENU");
              await sleep(500);
              res.x = res.x + Math.round(res.width / 2);
              res.y = res.y + Math.round(res.height / 2);
              log.info(`点击位置: ${res.x}, ${res.y}`);
              click(res.x, res.y);
              leftButtonClick();
              keyUp("VK_MENU");
              clickedWhitelistNPC = true;
              break;
            }
          }
          if (clickedWhitelistNPC) break;
        }

        // 如果没有点击白名单NPC，尝试点击包含提取到的人名的选项
        if (!clickedWhitelistNPC && extractedName) {
          for (let i = 0; i < nameResults.count; i++) {
            let text = nameResults[i].text;
            let res = nameResults[i];
            if (text.includes(extractedName)) {
              log.info(`点击包含提取到任务人名的选项: ${text}`);
              keyDown("VK_MENU");
              await sleep(500);
              res.x = res.x + Math.round(res.width / 2);
              res.y = res.y + Math.round(res.height / 2);
              log.info(`点击位置: ${res.x}, ${res.y}`);
              click(res.x, res.y);
              leftButtonClick();
              keyUp("VK_MENU");
              clickedExtractedName = true;
              break;
            }
          }
        }
      }

      // 如果没有找到NPC，使用默认触发
      if (!clickedWhitelistNPC && !clickedExtractedName) {
        log.info("未找到匹配的NPC，使用默认触发方式");
        keyPress("F"); // 默认触发剧情
        await sleep(500);
      }

      // 重复执行自动剧情，直到返回主界面
      let maxAttempts = 100; // 设置最大尝试次数，防止无限循环
      let attempts = 0;
      await sleep(1000);
      log.info("开始执行自动剧情");

      while (!isInMainUI() && attempts < maxAttempts) {
        attempts++;

        // 正常跳过对话
        await genshin.chooseTalkOption("纳西妲美貌举世无双", skipCount, false);

        if (isInMainUI()) {
          log.info("检测到已返回主界面，结束循环");
          break;
        }

        // 每skipCount次跳过后，进行OCR识别
        if (true) {
          // 检查是否有匹配的优先选项
          let foundPriorityOption = false;

          // 获取对话区域截图并进行OCR识别
          const dialogOptionsRegion = {
            X: 1250,
            Y: 450,
            WIDTH: 550,
            HEIGHT: 400,
          };
          let ocrResults = await Utils.easyOCR(dialogOptionsRegion);
          if (ocrResults.count > 0) {
            log.info(`识别到 ${ocrResults.count} 个选项`);

            for (let i = 0; i < ocrResults.count; i++) {
              let ocrText = ocrResults[i].text;

              // 检查是否在优先选项列表中
              for (let j = 0; j < effectivePriorityOptions.length; j++) {
                if (ocrText.includes(effectivePriorityOptions[j])) {
                  log.info(
                    `找到优先选项: ${effectivePriorityOptions[j]}，点击该选项`
                  );
                  // 点击该选项
                  ocrResults[i].click();
                  await sleep(500);
                  foundPriorityOption = true;
                  break;
                }
              }

              if (foundPriorityOption) break;
            }

            // 如果没有找到优先选项，则使用默认跳过
            if (!foundPriorityOption) {
              await genshin.chooseTalkOption("", 1, false);
            }
          }
        }

        // 检查是否已返回主界面
        if (isInMainUI()) {
          log.info("检测到已返回主界面，结束循环");
          break;
        }
      }

      if (isInMainUI()) {
        log.info("已返回主界面，自动剧情执行完成");
        keyPress("V");
      } else {
        log.warn(`已达到最大尝试次数 ${maxAttempts}，但未检测到返回主界面`);
      }
    },

    /**
     * 执行自动对话处理
     * @param {string|string[]} data - NPC名称
     * @returns {Promise<void>}
     */
    executeAutoTalk: async (data) => {
      // 使用传入的参数，不再加载默认配置
      // 确保 effectiveNpcWhiteList 始终是一个数组，并过滤掉空字符串
      let effectiveNpcWhiteList = [];
      if (Array.isArray(data)) {
        effectiveNpcWhiteList = data.filter(name => name && name.trim() !== "");
      } else if (data && data.trim() !== "") {
        effectiveNpcWhiteList = [data];
      }

      log.info(`白名单NPC: ${JSON.stringify(effectiveNpcWhiteList)}`);
      await genshin.returnMainUi();
      // 初始化
      keyPress("V");
      await sleep(1000);

      let extractedName = null;
      let retryCount = 0;
      const maxRetries = 3;

      // 处理任务提示重试逻辑
      while (retryCount < maxRetries) {
        // 人名区域OCR识别
        const nameRegion = { X: 75, Y: 240, WIDTH: 225, HEIGHT: 60 };
        let nameResults = await Utils.easyOCR(nameRegion);

        // 检查是否有"任务提示"
        let hasTaskHint = false;
        for (let i = 0; i < nameResults.count; i++) {
          let text = nameResults[i].text;
          log.info(`任务区域识别文本: ${text}`);

          if (text.includes("任务提示")) {
            log.info("检测到任务提示，等待4秒后重试");
            hasTaskHint = true;
            break;
          }

          // 尝试提取任务人名（排除空字符串）
          let name = UIUtils.extractName(text);
          if (name && name.trim() !== "") {
            extractedName = name;
            log.info(`提取到人名: ${extractedName}`);
            break;
          }
        }

        // 如果有任务提示，等待后重试
        if (hasTaskHint) {
          retryCount++;
          if (retryCount >= maxRetries) {
            log.warn("已达到最大重试次数，跳过任务提示");
            break;
          }
          await sleep(4000);
          continue;
        }

        // 如果没有任务提示，跳出循环
        break;
      }

      // 对话选项区域OCR识别
      const dialogRegion = { X: 1150, Y: 300, WIDTH: 350, HEIGHT: 400 };
      let dialogResults = await Utils.easyOCR(dialogRegion);
      let clickedWhitelistNPC = false;
      let clickedExtractedName = false;

      // 如果对话区域没有人名，尝试按键操作
      if (dialogResults.count === 0) {
        log.info("对话区域未识别到文本，尝试按键操作");

        // 尝试按下W键并重新OCR
        keyPress("W");
        await sleep(500);
        dialogResults = await Utils.easyOCR(dialogRegion);

        // 如果仍然没有人名，尝试按下A键
        if (dialogResults.count === 0) {
          keyPress("A");
          await sleep(500);
          dialogResults = await Utils.easyOCR(dialogRegion);
        }

        // 如果仍然没有人名，尝试按下S键
        if (dialogResults.count === 0) {
          keyPress("S");
          await sleep(500);
          dialogResults = await Utils.easyOCR(dialogRegion);
        }

        // 如果仍然没有人名，尝试按下D键
        if (dialogResults.count === 0) {
          keyPress("D");
          await sleep(500);
          dialogResults = await Utils.easyOCR(dialogRegion);
        }
      }

      // 处理人名区域的OCR结果
      if (dialogResults.count > 0) {
        log.info(`对话区域识别到 ${dialogResults.count} 个文本`);

        // 首先尝试点击白名单中的NPC
        for (let i = 0; i < dialogResults.count; i++) {
          let text = dialogResults[i].text;
          let res = dialogResults[i];
          log.info(
            "对话区域识别到{text}:位置({x},{y},{h},{w})",
            res.text,
            res.x,
            res.y,
            res.width,
            res.height
          );

          // 检查是否包含白名单中的NPC名称
          for (let j = 0; j < effectiveNpcWhiteList.length; j++) {
            if (text.includes(effectiveNpcWhiteList[j])) {
              log.info(`找到白名单NPC: ${effectiveNpcWhiteList[j]}，点击该NPC`);
              keyDown("VK_MENU");
              await sleep(500);
              res.x = res.x + Math.round(res.width / 2);
              res.y = res.y + Math.round(res.height / 2);
              log.info(`点击位置: ${res.x}, ${res.y}`);
              click(res.x, res.y);
              leftButtonClick();
              keyUp("VK_MENU");
              clickedWhitelistNPC = true;
              break;
            }
          }
          if (clickedWhitelistNPC) break;
        }

        // 如果没有点击白名单NPC，尝试点击包含提取到的人名的选项
        if (!clickedWhitelistNPC && extractedName) {
          for (let i = 0; i < dialogResults.count; i++) {
            let text = dialogResults[i].text;
            let res = dialogResults[i];
            if (text.includes(extractedName)) {
              log.info(`点击包含提取到任务人名的选项: ${text}`);
              keyDown("VK_MENU");
              await sleep(500);
              res.x = res.x + Math.round(res.width / 2);
              res.y = res.y + Math.round(res.height / 2);
              log.info(`点击位置: ${res.x}, ${res.y}`);
              click(res.x, res.y);
              leftButtonClick();
              keyUp("VK_MENU");
              clickedExtractedName = true;
              break;
            }
          }
        }
      }

      // 如果没有找到NPC，使用默认触发
      if (!clickedWhitelistNPC && !clickedExtractedName) {
        log.info("未找到匹配的NPC，使用默认触发方式");
        keyPress("F"); // 默认触发剧情
        await sleep(500);
      }

      await sleep(1000);
      log.info("开始自动剧情");

      await StepProcessor.processWaitMainUI(600);
    }
  };

  const Execute = {
    // 寻找委托目的地址带追踪任务
    // 读取并解析流程文件为步骤数组
    loadAndParseProcessFile: async (
      process_path
    ) => {
      const processFilePath = process_path;
      let processContent;
      let processSteps;
      try {
        processContent = await file.readText(processFilePath);
        log.info("找到流程文件: {path}", processFilePath);
        const pauseCount = (processContent.match(/^暂停/gm) || []).length;
        log.info(`共有 ${pauseCount} 个暂停`);
      } catch (error) {
        log.warn(
          "未找到流程文件: {path}",
          processFilePath
        );
        return false;
      }
      // 解析流程内容

      try {
        // 尝试解析为JSON格式
        const jsonData = JSON.parse(processContent);
        if (Array.isArray(jsonData)) {
          processSteps = jsonData;
          log.debug("JSON流程解析成功");
          return processSteps;
        } else {
          log.error("JSON流程格式错误，应为数组");
          return false;
        }
      } catch (jsonError) {
        // 若非JSON，尝试解析为扩展的简单格式脚本
        try {
          const simpleScript = Execute.parseExtendedSimpleScript(processContent);
          if (simpleScript && simpleScript.blocks && simpleScript.blocks.length > 0) {
            log.info("检测到简单格式脚本，共{count}个步骤块", simpleScript.blocks.length);
            return { __simpleScript: true, script: simpleScript };
          }
        } catch (e) {
          log.error("简单格式脚本解析出错: {error}", e.message);
        }
        // 回退到旧的按行简单格式
        const lines = processContent
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        processSteps = lines;
        return processSteps;
      }
    },

    // 解析扩展的简单格式脚本
    parseExtendedSimpleScript: (content) => {
      const lines = content.split("\n");
      const blocks = [];
      const meta = { author: "", description: "" };
      let currentBlock = null;
      let lineNo = 0;                   // 当前行号（1 起算，供运行面板显示）

      const isComment = (line) => {
        const t = line.trim();
        return t === "" || t.startsWith("#") || t.startsWith("//");
      };

      const isHeaderLine = (line) => {
        const trimmed = line.trim();
        return /[:：]$/.test(trimmed) && !/^https?:\/\//i.test(trimmed);
      };

      const extractHeaderKeyValue = (line) => {
        const idx = Math.max(line.indexOf("："), line.indexOf(":"));
        if (idx === -1) return { key: "", value: "" };
        return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
      };

      for (let raw of lines) {
        lineNo++;                       // 1 起算，用于运行面板显示行号
        // 去注释尾部
        let line = raw;
        const cmtIdx1 = line.indexOf("#");
        const cmtIdx2 = line.indexOf("//");
        let cut = line.length;
        if (cmtIdx1 !== -1) cut = Math.min(cut, cmtIdx1);
        if (cmtIdx2 !== -1) cut = Math.min(cut, cmtIdx2);
        line = line.slice(0, cut).trim();
        if (isComment(line)) continue;

        // 元数据：作者/描述
        const { key, value } = extractHeaderKeyValue(line);
        if (/^作者$/i.test(key)) {
          meta.author = value;
          continue;
        }
        if (/^描述$/i.test(key)) {
          meta.description = value;
          continue;
        }

        // 块头：任务描述行
        if (isHeaderLine(line)) {
          const header = line.slice(0, line.length - 1).trim();
          const descNorm = Utils.normalizeText(header);
          const isDefault = /^(默认|無任務描述字符串|无任务描述字符串|nomatch|default|超时)$/i.test(header);
          currentBlock = { description: header, descriptionNorm: descNorm, isDefault, instructions: [] };
          blocks.push(currentBlock);
          continue;
        }

        // 指令行
        if (!currentBlock) {
          // 若还未开始任何块，则自动创建一个"默认"块
          currentBlock = { description: "默认", descriptionNorm: Utils.normalizeText("默认"), isDefault: true, instructions: [] };
          blocks.push(currentBlock);
        }

        const parts = line.trim().split(/\s+/);
        const cmd = parts.shift();
        const arg = parts.join(" ").trim();

        const pushInstr = (type, data = null) => {
          // line / raw 供 HTML 运行面板显示「当前执行行」
          currentBlock.instructions.push({ type, data, line: lineNo, raw: line });
        };

        switch (cmd) {
          case "注入":
            pushInstr("注入", arg)
            break;
          case "尝试":
            pushInstr("尝试", arg)
            break;
          case "地图追踪":
            pushInstr("地图追踪", arg);
            break;
          case "调时间":
            pushInstr("调时间", arg);
            break;
          case "提示":
            pushInstr("提示", arg);
            break;
          case "键鼠脚本":
            pushInstr("键鼠脚本", arg);
            break;
          case "对话":
            pushInstr("对话", arg);
            break;
          case "交互":
            pushInstr("交互", arg);
            break;
          case "等待返回主界面":
            pushInstr("等待返回主界面", parseInt(arg || "600", 10) || 120);
            break;
          case "追踪图标":
            pushInstr("追踪图标", arg);
            break;
          case "追踪委托":
            pushInstr("追踪委托", arg);
            break;
          case "按键":
            pushInstr("按键", arg || "F");
            break;
          case "等待":
            pushInstr("等待", parseInt(arg || "5000", 10) || 5000);
            break;
          case "任务完成":
            pushInstr("任务完成", null);
            break;
          case "暂停":
            pushInstr("暂停", arg);
            break;
          case "战斗":
            pushInstr("战斗", null);
            break;
          case "自动拾取": {
            pushInstr("自动拾取", arg);
            break;
          }
          case "切换":
            pushInstr("切换", arg);
            break;
          case "点击":
            pushInstr("点击", arg);
            break;
          case "切换队伍":
            pushInstr("切换队伍", arg);
            break;
          case "图像匹配":
            pushInstr("图像匹配", arg);
            break;
          case "切换角色体型":
            pushInstr("切换角色体型", arg);
            break;
          case "点击文字":
            pushInstr("点击文字", arg);
            break;
          case "返回主界面":
            pushInstr("返回主界面", null);
            break;
          default: {
            // 兼容旧格式：F xxx => 对话 xxx
            if (/^F$/i.test(cmd) && arg) {
              pushInstr("对话", arg);
              break;
            }
            // 兼容旧格式：xxx.json => 地图追踪 xxx.json
            if (/\.json$/i.test(cmd)) {
              pushInstr("地图追踪", line);
              break;
            }
            // 兼容旧格式：F 纳西达（不规范多空格）
            if (/^F$/i.test(cmd)) {
              //log.info("对话");
              pushInstr("对话", "");
              break;
            }
            // 未识别，作为日志忽略
            log.warn("未识别的指令行: {line}", line);
            break;
          }
        }
      }

      return { meta, blocks };
    },

    // 执行扩展的简单格式脚本
    //
    // ★ startLine（可选）：从 process.json 的**第几行**开始执行（真实文件行号，1 起算）。
    //   传 0 / 不传 = 从头执行。
    //   实现方式：过滤掉 `instr.line < startLine` 的指令。
    //   说明：本项目的脚本都是「顺序脚本」，指令按顺序执行，
    //        因此过滤后剩下的指令就是「从该行开始」要跑的内容。
    executeSimpleScriptFlow: async (simpleScript, process_path, startLine) => {
      const isInMainUI = UIUtils.createMainUIChecker();
      const META = simpleScript.meta || {};
      const BLOCKS = Array.isArray(simpleScript.blocks) ? simpleScript.blocks : [];
      const defaultBlock = BLOCKS.find(b => b.isDefault) || null;
      let originalTeam = null;  // 存储原始队伍，用于"切换 原来队伍"恢复

      if (META.author) log.info("作者: {author}", META.author);
      if (META.description) log.info("描述: {desc}", META.description);

      // ★ 从指定行开始：丢弃该行之前的指令
      const startAt = Number(startLine) || 0;
      if (startAt > 1) {
        let dropped = 0;
        for (const block of BLOCKS) {
          const before = block.instructions.length;
          block.instructions = block.instructions.filter(i => (i.line || 0) >= startAt);
          dropped += before - block.instructions.length;
        }
        log.info(`从第 ${startAt} 行开始执行（已跳过前 ${dropped} 条指令）`);
      }

      // 建立描述 -> 块 列表映射，保持顺序
      const groupMap = new Map();
      for (const block of BLOCKS) {
        if (!groupMap.has(block.descriptionNorm)) groupMap.set(block.descriptionNorm, []);
        groupMap.get(block.descriptionNorm).push(block);
      }

      // 数据结构与groupMap保持一致，用来记录带有描述块任务的断点位置
      const resumingMap = new Map();
      for (const block of BLOCKS) {
        if (!resumingMap.has(block.descriptionNorm)) resumingMap.set(block.descriptionNorm, []);
        resumingMap.get(block.descriptionNorm).push(block);
      }

      const execCounter = new Map();

      const detectCurrentDesc = async () => {
        const region = { X: 75, Y: 240, WIDTH: 280, HEIGHT: 43 };
        const ocr = await Utils.easyOCR(region);
        let best = { sim: 0, descNorm: null };
        for (let i = 0; i < ocr.count; i++) {
          log.info("正在匹配任务区文本: {text}", ocr[i].text);
          const txt = Utils.normalizeText(ocr[i].text);
          for (const [descNorm] of groupMap) {
            if (!descNorm) continue;
            const sim = Utils.similarity(txt, descNorm);
            if (sim > best.sim) best = { sim, descNorm };
          }
        }
        if(ocr.count === 0){
          log.info("未匹配到任务描述文本");
        }
        return best.sim >= 0.9 ? best.descNorm : null;
      };

      /* ================================================================
         「地图追踪 / 键鼠脚本」的参数重载支持
         ================================================================

         格式 1：路径名
         格式 2：路径名 次数 主界面 boolean
         格式 3：路径名 次数 图片路径 boolean1 boolean2

         详细语义见 utils/dsl.js 顶部注释。
         ================================================================ */

      /**
       * 暂停并等待用户按「暂停键」继续（供「超出最大循环次数」时使用）。
       *
       * 与「注入」里的暂停逻辑**同源**（同样走共享按键钩子、
       * 同样在等待期间 pumpAndBeat 保持收信），但刻意保持独立实现，
       * 避免改动「注入」那段已验证稳定的代码。
       *
       * @param {string} reason 暂停原因（写入日志与面板）
       */
      const pauseForManual = async (reason) => {
        const stopkey = settings.pause;   // 与「注入」用同一个暂停键配置
        let isPaused = true;
        let pauseKeyHandler = null;
        try {
          notifyPause(reason || "超出最大执行次数");   // 面板显示暂停
          /* ★ 先按「暂停前按键」（实验性，未配置则跳过），
             再发带上下文的通知：当前运行：xxx，第 N 行 xxx，原因，… */
          pauseNotice(reason || "超出最大循环次数");
          log.warn(`完成后按 ${stopkey} 键继续...`);

          /* ★ 走共享按键钩子，绝不自己 new KeyMouseHook()。
             BetterGI 的 KeyMouseHook 是全局键盘钩子，自行创建或 dispose
             会连带破坏 overlay 的 N/K 热键。 */
          pauseKeyHandler = function (pressedKey) {
            if (String(pressedKey) === String(stopkey)) {
              isPaused = false;
              log.info(`已检测到 ${stopkey} 键，准备继续执行`);
            }
          };
          if (!subscribeKey(pauseKeyHandler)) {
            log.error(`无法注册暂停键 ${stopkey}，脚本将无法继续（请检查 BetterGI 版本）`);
          }
          while (isPaused) {
            await sleep(100);
            pumpAndBeat();          // 暂停期间保持收信：可切换剧情、N/K 热键仍可用
          }
          log.info("脚本继续执行...");
          notifyResume();           // 面板恢复「运行中」
        } catch (error) {
          log.error("暂停等待时出错: {error}", error.message);
        } finally {
          unsubscribeKey(pauseKeyHandler);   // ★ 只注销回调，不销毁共享钩子
        }
      };

      /**
       * 模板匹配：判断指定图片是否出现在游戏画面上。
       * 参考 rec.md 与既有「图像匹配」指令的写法。
       *
       * @param {string} imagePath 相对 process.json 所在目录的图片路径
       * @param {string} process_path 当前 process.json 的路径
       * @returns {Promise<boolean>} 是否匹配到
       */
      const matchTemplateOnScreen = async (imagePath, process_path) => {
        const dir = process_path.replace(/[^\\/]+$/, "");
        const fullPath = dir + imagePath;
        let template = null;
        let screen = null;
        try {
          template = file.ReadImageMatSync(fullPath);
          screen = captureGameRegion();
          const ro = RecognitionObject.templateMatch(template, 0, 0, 1920, 1080);
          ro.Threshold = 0.8;
          const found = screen.find(ro);
          return !found.isEmpty();
        } catch (e) {
          log.error("循环条件模板匹配失败: {path}，错误：{err}", fullPath, e.message);
          return false;              // 匹配失败按「未命中」处理
        } finally {
          try { if (screen) screen.dispose(); } catch (e) { /* 忽略 */ }
          try { if (template) template.dispose(); } catch (e) { /* 忽略 */ }
        }
      };

      /**
       * 带「最大次数 + 跳出条件」的重复执行。
       *
       * @param {object} parsed   parseRepeatableArgs 的结果
       * @param {Function} runOnce 执行一遍的函数（无参数，返回 Promise）
       * @param {string} process_path 当前 process.json 路径（解析图片用）
       * @param {object} instr    原始指令（用于面板显示）
       * @returns {Promise<'done'|'switched'>}
       */
      const runWithRepeat = async (parsed, runOnce, process_path, instr) => {
        // 次数为 0 → 跳过此条（执行 0 次），且**不暂停**
        if (parsed.maxCount === 0) {
          log.info(`循环次数为 0，跳过此条指令: ${instr.raw || instr.type}`);
          return 'done';
        }

        let executed = 0;
        while (true) {
          // ★ 每轮开始前检查用户是否请求切换/放弃剧情
          if (shouldSwitch()) return 'switched';

          await runOnce();
          executed++;

          // 计算本轮的判定值
          let matched = null;
          if (parsed.condition === 'mainui') {
            matched = isInMainUI();
          } else if (parsed.condition === 'image') {
            matched = await matchTemplateOnScreen(parsed.image, process_path);
          }

          const verdict = decideRepeat(parsed, executed, matched);

          // 把循环进度推给面板（HTML 遮罩适配）
          if (verdict.action === 'run') {
            log.info(`第 ${executed}/${parsed.maxCount} 次完成：${verdict.reason}`);
            sendLoopProgress(instr, executed, parsed.maxCount);
          } else {
            log.info(`循环结束（已执行 ${executed} 次）：${verdict.reason}`);
          }

          if (verdict.action === 'stop') return 'done';
          if (verdict.action === 'pause') {
            await pauseForManual(verdict.reason);
            return 'done';
          }
          await sleep(200);          // 轮间短暂间隔（与既有指令间隔一致）
        }
      };

      const executeInstruction = async (instr) => {
        const type = instr.type;
        const data = instr.data;
        switch (type) {
          case "注入": {
            let pluginErrorInformation
            // data 是外部 js 文件路径（相对脚本根目录），读取文件内容并作为代码执行
            try {
              // 路径清洗：去掉开头斜杠，补 .js 后缀（支持 "注入 /process/exampleTask/plugin" 或 "注入 plugin.js"）
              let filePath = String(data || "").trim();
              if (!filePath) {
                log.warn("注入指令缺少文件路径，已跳过");
                break;
              }
              if (filePath.startsWith("/")) filePath = filePath.slice(1);
              if (filePath.startsWith("\\")) filePath = filePath.slice(1);
              if (!filePath.endsWith(".js")) filePath += ".js";

              // 用 BetterGI 提供的 file.readTextSync 读取 js 文件内容
              const injectedCode = file.readTextSync(filePath);
              // 将读取到的代码作为代码执行（与"尝试"指令的 eval 原理一致）
              eval(injectedCode);
              log.info("注入脚本成功: {path}", filePath);
                pluginErrorInformation = await pluginMethod()
            } catch (injectError) {
              log.error("注入脚本失败: {path}，错误：{err}", String(data), injectError.message);
            }
            if (!pluginErrorInformation) {
              let isPaused = true;
              let pauseKeyHandler = null;   // 暂停键回调（共享钩子）
              let stopkey = settings.pause //定义暂停键(可能多此一举？)
              try {
                await sleep(1000);//暂停前等待（似乎没用吧）
                notifyPause("注入失败");        // 面板显示暂停
                /* ★ 先按「暂停前按键」（实验性），再发带上下文的通知 */
                pauseNotice("注入脚本运行失败（超出最大尝试次数）");

                if(data)
                {
                  log.warn('{data} <-\n     plugin脚本运行失败，请按照指示手动完成',data);
                }
                log.warn(`完成后按 ${stopkey} 键继续...`);
                /* ★ 走共享按键钩子，绝不自己 new KeyMouseHook()。
                   BetterGI 的 KeyMouseHook 是全局键盘钩子，自行创建或 dispose
                   会连带破坏 overlay 的 N/K 热键（表现为暂停后 K/N 全部失效）。 */
                pauseKeyHandler = function (pressedKey) {
                  if (String(pressedKey) === String(stopkey)) {
                    isPaused = false;
                    log.info(`已检测到 ${stopkey} 键，准备继续执行`);
                  }
                };
                if (!subscribeKey(pauseKeyHandler)) {
                  log.error(`无法注册暂停键 ${stopkey}，脚本将无法继续（请检查 BetterGI 版本）`);
                }
                // 等待按下暂停键
                while (isPaused) {
                  await sleep(100); // 等待减少资源消耗
                  pumpAndBeat();   // 暂停期间保持收信：可切换剧情、N/K 热键仍可用
                }
                log.info("脚本继续执行...");
                notifyResume();                 // 面板恢复「运行中」
              } catch (error) {
                log.error("发生错误:", error);
              } finally {
                // 释放键鼠资源
                unsubscribeKey(pauseKeyHandler);   // ★ 只注销回调，不销毁共享钩子
                log.info("已释放资源");
              }


            }
            break;
          }
          case "尝试":{
            eval(data)
            break;
          }

          case "地图追踪": {
            /* ★ 参数重载：格式 1 直接执行一次；格式 2/3 进入循环 */
            const mp = parseRepeatableArgs(data);
            if (!mp.ok) {
              log.warn(`地图追踪参数解析失败（${mp.error}），按格式 1 执行: ${data}`);
              await StepProcessor.processMapTracking({ data: String(data || '').trim().split(/\s+/)[0] }, process_path);
              break;
            }
            if (!needsRepeat(mp)) {
              // 格式 1（或次数为 0）→ 与原行为一致
              if (mp.maxCount === 0) {
                log.info(`循环次数为 0，跳过此条指令: ${instr.raw || instr.type}`);
                break;
              }
              log.info(mp.path);
              await StepProcessor.processMapTracking({ data: mp.path }, process_path);
              break;
            }
            await runWithRepeat(mp, async () => {
              await StepProcessor.processMapTracking({ data: mp.path }, process_path);
            }, process_path, instr);
            break;
          }
          case "键鼠脚本": {
            /* ★ 与「地图追踪」同样的参数重载逻辑 */
            const km = parseRepeatableArgs(data);
            if (!km.ok) {
              log.warn(`键鼠脚本参数解析失败（${km.error}），按格式 1 执行: ${data}`);
              await StepProcessor.processKeyMouseScript({ data: String(data || '').trim().split(/\s+/)[0] }, process_path);
              break;
            }
            if (!needsRepeat(km)) {
              if (km.maxCount === 0) {
                log.info(`循环次数为 0，跳过此条指令: ${instr.raw || instr.type}`);
                break;
              }
              await StepProcessor.processKeyMouseScript({ data: km.path }, process_path);
              break;
            }
            await runWithRepeat(km, async () => {
              await StepProcessor.processKeyMouseScript({ data: km.path }, process_path);
            }, process_path, instr);
            break;
          }
          case "对话": {
            // 优先点击NPC名
            await DialogProcessor.executeAutoTalk(data);
            break;
          }
          case "交互": {
            if (data) {
              await UIUtils.clickTargetByText(data);
              await sleep(300);
            }
            break;
          }
          case "等待返回主界面":
            await StepProcessor.processWaitMainUI(data);
            break;
          case "追踪图标": {
            const iconType = data || "Bigmap";
            await Execute.autoNavigateToIcon(iconType);
            break;
          }
          case "追踪委托": {
            if (typeof data === "string") {
              await StepProcessor.processCommissionTracking({ data });
            } else if (data && typeof data === "object") {
              await StepProcessor.processCommissionTracking({ data });
            }
            break;
          }
          case "提示": {
            if (data) {
              log.info("提示: {data}", data);
            }
            break;
          }
          case "调时间":{
            await sleep(1000);//等待任务弹出
            let filePath = `data/time.json`;
            await keyMouseScript.runFile(filePath);
            break;
          }
		  case "按键":
		  const keyData = typeof data === "string" 
          ? {data}
          : data;
          await StepProcessor.processKeyPress({data});
          break;
          case "等待":
            log.info("等待{data}毫秒", data);
            await sleepChunked(typeof data === "number" ? data : 5000);
            break;
          case "自动拾取":
            if(data === "关闭")
            {
              log.info("关闭自动拾取");
              dispatcher.ClearAllTriggers();
              dispatcher.AddTrigger(new RealtimeTimer("AutoSkip"));
              if (!settings.noEat) {
                dispatcher.AddTrigger(new RealtimeTimer("AutoEat"));
              }
            }
            else
            {
              log.info("开启自动拾取");
              dispatcher.AddTrigger(new RealtimeTimer("AutoPick"));
            }
            break;
          case "任务完成":
            return "DONE";
          case "暂停":
			let isPaused = true;
			let pauseKeyHandler = null;   // 暂停键回调（共享钩子）   
			let stopkey = settings.pause //定义暂停键(可能多此一举？)
			try {
              notifyPause("暂停指令");           // 面板显示暂停
              await sleep(1000);//暂停前等待（似乎没用吧）
              /* ★ 先按「暂停前按键」（实验性），再发带上下文的通知。
                 原因带上作者提示（DSL 里 `暂停 xxx` 的 xxx），便于对照。 */
              pauseNotice(data ? `暂停指令（作者提示：${data}）` : "暂停指令");
              if(data)
              {
                log.warn('作者提示：{data}',data);
              }
				log.warn(`完成后按 ${stopkey} 键继续...`);
				/* ★ 走共享按键钩子，绝不自己 new KeyMouseHook()。
				   BetterGI 的 KeyMouseHook 是全局键盘钩子，自行创建或 dispose
				   会连带破坏 overlay 的 N/K 热键（表现为暂停后 K/N 全部失效）。 */
				pauseKeyHandler = function (pressedKey) {
				  if (String(pressedKey) === String(stopkey)) {
				    isPaused = false;
				    log.info(`已检测到 ${stopkey} 键，准备继续执行`);
				  }
				};
				if (!subscribeKey(pauseKeyHandler)) {
				  log.error(`无法注册暂停键 ${stopkey}，脚本将无法继续（请检查 BetterGI 版本）`);
				}
				// 等待按下暂停键
				while (isPaused) {
					await sleep(100); // 等待减少资源消耗
				  pumpAndBeat();   // 暂停期间保持收信：可切换剧情、N/K 热键仍可用
				}      
				log.info("脚本继续执行...");
			} catch (error) {
				log.error("发生错误:", error);
			} finally {
				// 释放键鼠资源
					unsubscribeKey(pauseKeyHandler);   // ★ 只注销回调，不销毁共享钩子
					log.info("已释放资源");
			} 
			// 继续执行其他任务
			log.info("执行后续任务...");
			notifyResume();                     // 面板恢复「运行中」
			await sleep(1000);
			break;
          case "战斗":
            await dispatcher.runTask(new SoloTask("AutoFight"));
            break;
          case "切换": {
            // 通用切换函数
            const switchToCharacters = async (targetChars) => {
              const currentTeam = Array.from(getAvatars() || []);
              const aliases = Utils.readAliases();
              for (let i = 0; i < targetChars.length; i++) {
                const char = targetChars[i];
                const name = aliases[char] || char;
                if (currentTeam.includes(name)) {
                  log.info(`${name} 已在队伍中，跳过`);
                  continue;
                }
                if (!await StepProcessor.processSwitchRole({ data: { position: i + 1, character: char } })) {
                  log.error(`切换失败：第${i + 1}号位 ${char}`);
                  return false;
                }
              }
              return true;
            };

            const args = data.trim().split(/\s+/);
            if (args[0] === "原来队伍") {
              if (!originalTeam || originalTeam.length === 0) {
                log.warn("未记录原始队伍，无法恢复");
                break;
              }
              log.info("开始恢复原始队伍");
              if (!await switchToCharacters(originalTeam)) log.warn("恢复失败");
              originalTeam = null;
              log.info("已恢复原始队伍");
            } else {
              if (!originalTeam) {
                originalTeam = Array.from(getAvatars() || []);
                log.info(`记录原始队伍: ${originalTeam.join(", ")}`);
              }
              if (!await switchToCharacters(args.slice(0, 4))) log.warn("切换失败");
              log.info("角色切换完成");
            }
            keyPress("VK_ESCAPE");
            await sleep(500);
            keyPress("VK_ESCAPE");
            await sleep(500);
            break;
          }
          case "点击": {
            const parts = String(data).split(/[,，]/);
            const cx = parseInt(parts[0], 10);
            const cy = parseInt(parts[1], 10);
            if (!isNaN(cx) && !isNaN(cy)) {
              log.info("点击坐标: ({x}, {y})", cx, cy);
              click(cx, cy);
              await sleep(300);
            } else {
              log.warn("点击指令格式错误，应为：点击 x,y，实际：{data}", data);
            }
            break;
          }
          case "切换队伍": {
            const teamArgs = String(data).trim().split(/\s+/);
            const teamType = teamArgs[0] || "战斗";
            const needStatue = teamArgs[1] === "是";
            const partyName = teamType === "元素采集" ? elementTeam : team;
            if (!partyName) {
              log.warn("未配置{teamType}队伍名称", teamType);
              break;
            }
            if (needStatue) {
              log.info("前往神像切换队伍: {partyName}", partyName);
              await genshin.tpToStatueOfTheSeven();
            }
            await switchPartyIfNeeded(partyName);
            break;
          }
          case "图像匹配": {
            const imagePath = String(data);
            const dir = process_path.replace(/[^\\/]+$/, "");
            const fullPath = dir + imagePath;
            log.info("图像匹配: {path}", fullPath);
            try {
              const template = file.ReadImageMatSync(fullPath);
              const screen = captureGameRegion();
              try {
                const ro = RecognitionObject.templateMatch(template, 0, 0, 1920, 1080);
                ro.Threshold = 0.8;
                const found = screen.find(ro);
                if (!found.isEmpty()) {
                  found.click();
                  log.info("图像匹配成功，已点击");
                  await sleep(300);
                } else {
                  log.warn("图像匹配未找到: {path}", fullPath);
                }
              } finally {
                screen.dispose();
                template.dispose();
              }
            } catch (e) {
              log.error("图像匹配失败: {e}", e);
            }
            break;
          }
          case "切换角色体型": {
            const targetBodyType = String(data);
            log.info("切换角色体型: {bodyType}", targetBodyType);
            try {
              const currentTeam = Array.from(getAvatars() || []);
              if (currentTeam.length === 0) {
                log.warn("无法识别当前队伍");
                break;
              }
              let avatarData;
              try {
                avatarData = JSON.parse(file.readTextSync("Data/avatar/combat_avatar.json"));
              } catch {
                log.warn("未找到角色数据文件 Data/avatar/combat_avatar.json");
                break;
              }
              const getBodyType = (charName) => {
                for (const entry of avatarData) {
                  if (entry.name === charName || (entry.alias && entry.alias.includes(charName))) {
                    return entry.bodyType;
                  }
                }
                return null;
              };
              let targetIndex = -1;
              for (let i = 0; i < currentTeam.length; i++) {
                const bt = getBodyType(currentTeam[i]);
                if (bt === targetBodyType) {
                  targetIndex = i;
                  break;
                }
              }
              if (targetIndex === -1) {
                log.warn("队伍中没有体型为{bodyType}的角色", targetBodyType);
                break;
              }/*
              if (targetIndex === 0) {
                log.info("当前出战角色已是{bodyType}体型: {name}", targetBodyType, currentTeam[0]);
                break;
              }*/ //这段不知道能不能跑起来
              const slotKey = ["1", "2", "3", "4"][targetIndex];
              log.info("切换到第{idx}号位: {name}", targetIndex + 1, currentTeam[targetIndex]);
              keyPress(slotKey);
              await sleep(200);
              keyPress(slotKey);
              await sleep(200);
              keyPress(slotKey);
              await sleep(5000);
            } catch (e) {
              log.error("切换角色体型失败: {e}", e);
            }
            break;
          }
          case "点击文字": {
            // 格式：点击文字 x,y,w,h,文字
            const ocrParts = String(data).split(/[,，]/);
            if (ocrParts.length < 5) {
              log.warn("点击文字指令格式错误，应为：点击文字 x,y,w,h,文字，实际：{data}", data);
              break;
            }
            const ox = parseInt(ocrParts[0], 10);
            const oy = parseInt(ocrParts[1], 10);
            const ow = parseInt(ocrParts[2], 10);
            const oh = parseInt(ocrParts[3], 10);
            const targetText = ocrParts.slice(4).join(",");
            if (isNaN(ox) || isNaN(oy) || isNaN(ow) || isNaN(oh)) {
              log.warn("点击文字坐标无效: {data}", data);
              break;
            }
            log.info("点击文字: 区域({x},{y},{w},{h}) 目标文字: {text}", ox, oy, ow, oh, targetText);
            try {
              const screen = captureGameRegion();
              try {
                const ro = RecognitionObject.ocr(ox, oy, ow, oh);
                const regions = screen.findMulti(ro);
                let bestMatch = null;
                let bestSim = 0;
                for (let i = 0; i < regions.Count; i++) {
                  const txt = Utils.normalizeText(regions[i].Text);
                  const sim = Utils.similarity(txt, Utils.normalizeText(targetText));
                  if (sim > bestSim) {
                    bestSim = sim;
                    bestMatch = regions[i];
                  }
                }
                if (bestMatch && bestSim >= 0.6) {
                  bestMatch.click();
                  log.info("点击文字成功，相似度: {sim}", bestSim.toFixed(2));
                  await sleep(300);
                } else {
                  log.warn("点击文字未找到匹配: 目标={text}，最高相似度={sim}", targetText, bestSim.toFixed(2));
                }
              } finally {
                screen.dispose();
              }
            } catch (e) {
              log.error("点击文字失败: {e}", e);
            }
            break;
          }
          case "返回主界面":
            log.info("执行返回主界面");
            await genshin.returnMainUi();
            await sleep(500);
            break;
          default:
            log.warn("未实现的指令类型: {type}", type);
        }
        return "OK";
      };

      /* ------------------------------------------------------------
         分片等待：把长等待切成小段，每段之间收信/投递
         好处：① 长等待期间面板仍显示「运行中」
               ② 用户点「切换剧情」能在一个分片内及时生效
               ③ 交互模式（K 键）下能及时暂停
               ④ 点「放弃剧情」也能及时中断
         ------------------------------------------------------------ */
      const sleepChunked = async (totalMs, chunkMs) => {
        const step = chunkMs || 500;
        let left = Math.max(0, Number(totalMs) || 0);
        while (left > 0) {
          await waitWhileInteracting();      // 交互模式 → 在此暂停（bug 3）
          const d = Math.min(step, left);
          await sleep(d);
          left -= d;
          pumpAndBeat();
          if (hasInterruptRequest()) return;  // 切换/放弃 → 提前结束等待
        }
      };

      /* ------------------------------------------------------------
         指令执行包装：向运行面板汇报「当前行」，并轮询面板消息
         ------------------------------------------------------------ */
      const runInstr = async (instr) => {
        // ★ 交互模式（按 K）时在此暂停：BetterGI 运行中会截获游戏窗口，
        //   不暂停则鼠标点不到 HTML 面板上的按钮（bug 3）
        await waitWhileInteracting();
        sendCurrentLine(instr);                    // 推送当前执行的 DSL 行
        /* ★ 记录「当前行」供暂停通知使用（剧情名由 Main 单独维护） */
        setNotifyContext(instr);
        pumpAndBeat();                             // 收取面板消息 + 投递热键指令
        const res = await executeInstruction(instr);
        pumpAndBeat();
        return res;
      };

      /** 是否有待处理的「切换剧情」或「放弃剧情」请求；有则中断当前流程 */
      const shouldSwitch = () => hasInterruptRequest();
      
      //await StepProcessor.processAutoTask({ data: { action: "enable", taskType: "AutoSkip" } });

      // 检查是否有非默认块（任务描述块）
      const hasTaskBlocks = BLOCKS.some(block => !block.isDefault);

      // 如果没有任务描述块，只有默认块，则直接执行默认块一次后返回
      if (!hasTaskBlocks && defaultBlock) {
        log.info("脚本中无任务描述块，直接执行默认块");
        //log.info("位置: {path}", process_path);
        while (0 < defaultBlock.instructions.length) {
          const instr = defaultBlock.instructions[0];
          const res = await runInstr(instr);
          if (shouldSwitch()) return true;        // 用户请求切换 → 中断当前剧情

          log.info("当前流程执行完毕，更新断点文件");
          defaultBlock.instructions.splice(0, 1);
          file.writeTextSync(`resuming/${relativePath}`, JSON.stringify(simpleScript, null, 2));
          if (res === "DONE") {
            log.info("收到任务完成指令，任务完成");
            return true;
          }
          await sleep(200);
        }
        return true;
      }

      let safety = 0;
      let lastMatchedDescNorm = null; // 记录上一次匹配到的描述
      let retryCount = 0; // 重试计数器
      const MAX_RETRY = 2; // 最大重试次数

      while (safety++ < 200) {
        // 13秒窗口尝试匹配
        let matchedDescNorm = null;
        await genshin.returnMainUi();
        for (let i = 0; i < 13; i++) {
          matchedDescNorm = await detectCurrentDesc();
          if (matchedDescNorm) break;
          keyPress("V");
          await sleep(1000);
        }

        // 保存断点进度
        if (lastMatchedDescNorm && matchedDescNorm !== lastMatchedDescNorm) {
          try {
            log.info("流程执行完毕，更新断点文件");
            resumingMap.get(lastMatchedDescNorm).shift();
            const descriptionNorms = Array.from(resumingMap.keys());
            const blocks = descriptionNorms.flatMap(norm => resumingMap.get(norm));
            const simpleScript = { meta: META,blocks: blocks};
            file.writeTextSync(`resuming/${relativePath}`, JSON.stringify(simpleScript, null, 2));
          } catch (error) {
            log.error(`更新断点文件时出错{error}`, error.message);
            break;
          }
        }

        // 如果任务描述变为其他，重置计数器
        if (matchedDescNorm !== lastMatchedDescNorm) {
          retryCount = 0;
          lastMatchedDescNorm = matchedDescNorm;
          const ran = execCounter.get(matchedDescNorm) || 0;
          execCounter.set(matchedDescNorm, ran + 1);
        } else {
          // 如果匹配到跟上次一样的，增加重试计数
          retryCount++;
        }

        // 如果重试超过限制，直接退出
        if (retryCount > MAX_RETRY) {
          log.error("同一任务描述已重试2次，执行失败，结束流程");
          break;
        }

        let blockToRun = null;
        if (matchedDescNorm && groupMap.has(matchedDescNorm)) {
          const ran = execCounter.get(matchedDescNorm) || 0;
          const list = groupMap.get(matchedDescNorm);
          const idx = Math.min(ran - 1, list.length - 1);
          blockToRun = list[idx];
          log.info("匹配到任务描述块: {desc}，第{idx}次执行", blockToRun.description, idx + 1);
        } else if (defaultBlock) {
          blockToRun = defaultBlock;
          log.info("未匹配到任务描述，执行默认块: {desc}", defaultBlock.description);
        } else {
          log.warn("未匹配到任务描述且不存在默认块，结束流程");
          break;
        }

        // 执行块内指令
        for (const instr of blockToRun.instructions) {
          const res = await runInstr(instr);
          if (shouldSwitch()) return true;        // 用户请求切换 → 中断当前剧情
          if (res === "DONE") {
            log.info("收到任务完成指令，任务完成");
            return true;
          }
          await sleep(200); // 指令间短暂间隔
        }

        await sleep(500); // 块间间隔
      }

      return true;
    },

    // 执行对话委托流程（优化版）
    // ★ startLine（可选）：从 process.json 的第几行开始执行（真实文件行号）
    executeTalkCommission: async (process_path, startLine) => {
      try {

        const processSteps = await Execute.loadAndParseProcessFile(process_path);

        //log.info("文件位置: {path}", process_path);

        // 使用统一的处理器执行流程
        if (processSteps && processSteps.__simpleScript) {
          // ★ 显式指定了起始行 → 优先于断点文件（用户的即时意图优先）
          if (Number(startLine) > 1) {
            return await Execute.executeSimpleScriptFlow(processSteps.script, process_path, startLine);
          }
          if (settings.useBreakPoint) {
            try {
              log.info("尝试读取断点文件");
              // 拼接断点文件路径
              const breakpointFilePath = `resuming/${relativePath}`;
              const simpleScript = JSON.parse(file.readTextSync(breakpointFilePath));
              return await Execute.executeSimpleScriptFlow(simpleScript, process_path);
            } catch (error) {
              log.debug(`读取断点文件时出错: {error}`, error.message);
              log.info("未找到断点文件，执行完整任务流程");
            }
          }
          return await Execute.executeSimpleScriptFlow(processSteps.script, process_path, startLine);
        }
        return await Execute.executeUnifiedTalkProcess(
          processSteps,
          process_path
        );
      } catch (error) {
        log.error("执行对话委托时出错: {error}", error.message);
        if(settings.xiaoxitongzhi)notification.error("执行对话委托时出错: " + error.message);
        return false;
      }
    },

    // 自动导航到NPC对话位置（从main_branch.js移植）
    autoNavigateToTalk: async (npcName = "", iconType = "") => {
      try {
        // 设置目标NPC名称
        const textArray = npcName;

        // 根据图标类型选择不同的识别对象
        let boxIconRo;
        if (iconType === "Bigmap") {
          boxIconRo = RecognitionObject.TemplateMatch(
            file.ReadImageMatSync(
              "Data/RecognitionObject/Commission/IconBigmapCommission.jpg"
            )
          );
          log.info("使用大地图图标");
        }
        else if (iconType === "Question") {
          boxIconRo = RecognitionObject.TemplateMatch(
            file.ReadImageMatSync(
              "Data/RecognitionObject/Commission/IconQuestionCommission.png"
            )
          );
          log.info("使用问号任务图标");
        } 
        else {
          // 默认使用任务图标
          boxIconRo = RecognitionObject.TemplateMatch(
            file.ReadImageMatSync(
              "Data/RecognitionObject/Commission/IconTaskCommission.png"
            )
          );
          log.info("使用任务图标");
        }

        let advanceNum = 0; //前进次数

        middleButtonClick();
        await sleep(800);

        while (true) {
          // 1. 优先检查是否已到达
          await sleep(500);// 等待0.5秒
          let captureRegion = captureGameRegion();
          let rewardTextArea = captureRegion.DeriveCrop(1210, 515, 200, 50);
          let rewardResult = rewardTextArea.find(RecognitionObject.ocrThis);
          log.debug("检测到文字: " + rewardResult.text);
          // 检测到特点文字则结束！！！
          if (rewardResult.text == textArray) {
            log.info("已到达指定位置，检测到文字: " + rewardResult.text);
            return;
          } else if (advanceNum > 80) {
            throw new Error("前进时间超时");
          }
          // 2. 未到达领奖点，则调整视野
          for (let i = 0; i < 100; i++) {
            captureRegion = captureGameRegion();
            let iconRes = captureRegion.Find(boxIconRo);
            log.info("检测到委托图标位置 ({x}, {y})", iconRes.x, iconRes.y);
            if (iconRes.x >= 920 && iconRes.x <= 980 && iconRes.y <= 540) {
              advanceNum++;
              log.info(`视野已调正，前进第${advanceNum}次`);
              break;
            } else {
              // 小幅度调整
              if (iconRes.y >= 520) moveMouseBy(0, 920);
              let adjustAmount = iconRes.x < 920 ? -20 : 20;
              let distanceToCenter = Math.abs(iconRes.x - 920); // 计算与920的距离
              let scaleFactor = Math.max(1, Math.floor(distanceToCenter / 50)); // 根据距离缩放，最小为1
              let adjustAmount2 = iconRes.y < 540 ? scaleFactor : 10;
              moveMouseBy(adjustAmount * adjustAmount2, 0);
              await sleep(100);
            }
            if (i > 50) throw new Error("视野调整超时");
          }
          // 3. 前进一小步
          keyDown("w");
          await sleep(200);
          keyPress("VK_SPACE");
          await sleep(200);
          keyPress("VK_SPACE");
          await sleep(200);
          keyUp("w");
          await sleep(200); // 等待角色移动稳定
        }
      } catch (error) {
        log.error("自动导航到NPC对话位置时出错: {error}", error.message);
        throw error;
      }
    },

    autoNavigateToIcon: async (iconType = "Bigmap") => {
      try {
        const iconLogMap = {
          Question: "感叹号",
          Task: "问号",
          Into: "进入",
          Bigmap: "菱形"
        };
        const _log = iconLogMap[iconType] ? iconLogMap[iconType] : iconType;
        log.info(`追踪图标：{logMsg}`, _log);

        //读取所有图标路径并转为数组
        let allIconPaths = file.readPathSync("Data/RecognitionObject/Icon/");
        allIconPaths = Array.from(allIconPaths);

        //筛选包含iconType的路径
        const filteredPaths = allIconPaths.filter(path => {
          const fileName = path.split(/[\\/]/).pop();
          return fileName.includes(iconType);
        });
        //批量创建包含指定iconType图标的RO
        const IconRos = filteredPaths.map(iconPath => {
          let ro = RecognitionObject.TemplateMatch(
            //icon只会出现在这个范围，且避免识别到委托描述的Icon
            file.ReadImageMatSync(iconPath), 300, 100, 1300, 800
          );
          ro.threshold = 0.8
          return ro
        });

        let inTalkRO = RecognitionObject.TemplateMatch(
          file.ReadImageMatSync("Data/RecognitionObject/IconInTalk.png"),
          0, 0, 500, 200
        );

        let advanceNum = 0; //前进次数
        let consecutiveFailCount = 0; //未检测到图标次数,
        middleButtonClick();
        await sleep(800);

        while (true) {
          // 调整视野
          for (let i = 0; i < 100; i++) {
            captureRegion = captureGameRegion()

            // 检测进入对话
            let inTalk = captureRegion.Find(inTalkRO);
            if (inTalk.isExist()) {
              log.info("已进入对话，停止前进");
              return;
            }

            let iconRes
            for (let boxIconRo of IconRos) {
              iconRes = captureRegion.Find(boxIconRo);
              if (iconRes.isEmpty()) {
                continue;
              } else {
                iconRes.DrawSelf("debug")
                consecutiveFailCount = 0
                break
              }
            }
            if (iconRes.isEmpty()) {
              log.info("未检测到图标，重试");
              consecutiveFailCount++;
              captureRegion.dispose();
              keyPress("V");
              await sleep(1000);
              continue;
            }
            //连续多次未检测到图标，停止前进
            if (consecutiveFailCount > 5) {
              log.info("连续5次未检测到图标，停止前进");
              captureRegion.dispose();
              return;
            }
            if (iconRes.x >= 920 && iconRes.x <= 980 && iconRes.y <= 540) {
              advanceNum++;
              break;
            } else {
              // 小幅度调整
              if (iconRes.y >= 520) moveMouseBy(0, 920);
              let adjustAmount = iconRes.x < 920 ? -20 : 20;
              let distanceToCenter = Math.abs(iconRes.x - 960); // 计算与920的距离
              let scaleFactor = Math.max(1, Math.floor(distanceToCenter / 20)); // 根据距离缩放，最小为1
              let adjustAmount2 = iconRes.y < 540 ? scaleFactor : 10;
              moveMouseBy(adjustAmount * adjustAmount2, 0);
              await sleep(100);
            }
            captureRegion.dispose();
            if (i > 50) throw new Error("视野调整超时");
          }
          // 3. 前进一小步
          keyDown("w");
          await sleep(200);
          keyPress("VK_SPACE");
          await sleep(200);
          keyPress("VK_SPACE");
          await sleep(200);
          keyUp("w");
          await sleep(200); // 等待角色移动稳定
        }
      } catch (error) {
        log.error("追踪Icon时出错: {error}", error.message);
        throw error;
      }
    },

    // 统一的对话委托流程处理器（重构版 - 更简洁的主控制函数）
    executeUnifiedTalkProcess: async (
      processSteps,
      commissionName,
      location
    ) => {
      try {
        log.info("执行统一对话委托流程: {name}", commissionName);

        if (!processSteps || processSteps.length === 0) {
          log.warn("没有找到有效的流程步骤");
          return false;
        }

        // 初始化UI检测器和配置
        const isInMainUI = UIUtils.createMainUIChecker();
        let priorityOptions = [];
        let npcWhiteList = [];

        // 刚开始就追踪委托目标
        //await Execute.findCommissionTarget(commissionName);

        // 执行处理步骤
        for (let i = 0; i < processSteps.length; i++) {
          const step = processSteps[i];
          log.info("执行流程步骤 {step}: {type}", i + 1, step.type || step);

          try {
            // 重置为默认值并处理自定义配置
            const stepConfig = Execute.processStepConfiguration(
              step,
              priorityOptions,
              npcWhiteList
            );
            priorityOptions = stepConfig.priorityOptions;
            npcWhiteList = stepConfig.npcWhiteList;

            // TAG:添加脚本功能点3
            const context = {
              commissionName,
              location,
              processSteps,
              currentIndex: i,
              isInMainUI,
              priorityOptions,
              npcWhiteList,
            };

            // 处理步骤
            await Execute.processStep(step, context);
          } catch (stepError) {
            log.error(
              "执行步骤 {step} 时出错: {error}",
              i + 1,
              stepError.message
            );
            // 继续执行下一步，不中断整个流程
          }

          // 每个步骤之间等待一段时间
          await sleep(2000);
        }

        log.info("统一对话委托流程执行完成: {name}", commissionName);
        return true;
      } catch (error) {
        log.error("执行统一对话委托流程时出错: {error}", error.message);
        return false;
      }
    },

    // 处理步骤配置（优先选项和NPC白名单）
    processStepConfiguration: (
      step,
      defaultPriorityOptions,
      defaultNpcWhiteList
    ) => {
      let priorityOptions = [...defaultPriorityOptions];
      let npcWhiteList = [...defaultNpcWhiteList];

      // 如果步骤中包含自定义的优先选项和NPC白名单，则使用它们
      if (step.data && typeof step.data === "object") {
        if (Array.isArray(step.data.priorityOptions)) {
          priorityOptions = step.data.priorityOptions;
          log.info("使用自定义优先选项: {options}", priorityOptions.join(", "));
        }
        if (Array.isArray(step.data.npcWhiteList)) {
          npcWhiteList = step.data.npcWhiteList;
          log.info("使用自定义NPC白名单: {npcs}", npcWhiteList.join(", "));
        }
      }

      return { priorityOptions, npcWhiteList };
    },

    // 处理单个步骤
    processStep: async (step, context) => {
      if (typeof step === "string") {
        // 简单格式处理
        await Execute.processStringStep(step, context);
      } else if (typeof step === "object") {
        // JSON格式处理
        await Execute.processObjectStep(step, context);
      }
    },

    // 处理字符串格式的步骤
    processStringStep: async (step, context) => {
      if (step.endsWith(".json")) {
        // 地图追踪文件
        await StepProcessor.processMapTracking(
          step,
          process_path
        );
      } else if (step === "F") {
        // 按F键并执行优化的自动剧情
        log.info("执行自动剧情");
        await DialogProcessor.executeOptimizedAutoTalk(
          null,
          5,
          context.priorityOptions,
          context.npcWhiteList,
          context.isInMainUI
        );
      }
    },

    // 处理对象格式的步骤
    processObjectStep: async (step, context) => {
      if (step.note) {
        log.info("步骤说明: {note}", step.note);
      }

      // 使用步骤处理器工厂来处理步骤
      await StepProcessorFactory.process(step, context);
    },

    // 示例：注册自定义步骤处理器
    registerCustomStepProcessors: () => {
      // 注册等待步骤处理器
      StepProcessorFactory.register("等待", async (step, context) => {
        const waitTime = step.data || 1000;
        log.info("等待 {time} 毫秒", waitTime);
        await sleep(waitTime);
      });

      // 注册截图步骤处理器
      StepProcessorFactory.register("截图", async (step, context) => {
        const filename = step.data || `screenshot_${Date.now()}.png`;
        log.info("截图保存为: {filename}", filename);
        // 这里可以添加实际的截图逻辑
      });

      // 注册条件检查步骤处理器
      StepProcessorFactory.register("条件检查", async (step, context) => {
        const condition = step.data.condition;
        const trueSteps = step.data.trueSteps || [];
        const falseSteps = step.data.falseSteps || [];

        log.info("执行条件检查: {condition}", condition);

        // 这里可以添加条件判断逻辑
        const conditionResult = true; // 示例结果

        const stepsToExecute = conditionResult ? trueSteps : falseSteps;
        for (const subStep of stepsToExecute) {
          await Execute.processStep(subStep, context);
        }
      });

      log.info("自定义步骤处理器注册完成");
    },

    // 处理对话步骤
    processDialogStep: async (
      step,
      priorityOptions,
      npcWhiteList,
      isInMainUI
    ) => {
      log.info("执行对话");
      let skipCount = 2; // 默认跳过2次
      
      // 处理对话选项
      if (typeof step.data === "number") {
        // 兼容旧版本，如果data是数字，则视为skipCount
        skipCount = step.data;
      } else if (typeof step.data === "object" && step.data.skipCount) {
        // 新版本，data是对象，包含skipCount
        skipCount = step.data.skipCount;
      }

      // 执行对话，使用当前步骤的优先选项和NPC白名单
      await DialogProcessor.executeOptimizedAutoTalk(
        null,
        skipCount,
        priorityOptions,
        npcWhiteList,
        isInMainUI
      );
    },
  };

  const CommissionsFunc = {

    // 计算两点之间的距离
    calculateDistance: (point1, point2) => {
      if (
        !point1 ||
        !point2 ||
        !point1.X ||
        !point1.Y ||
        !point2.x ||
        !point2.y
      ) {
        log.warn("无效的位置数据");
        return Infinity;
      }
      return Math.sqrt(
        Math.pow(point1.X - point2.x, 2) + Math.pow(point1.Y - point2.y, 2)
      );
    },

    // 获取委托的目标坐标（从路径追踪文件中获取最后一个坐标）
    getCommissionTargetPosition: async (scriptPath) => {
      try {
        const scriptContent = await file.readText(scriptPath);
        const pathData = JSON.parse(scriptContent);

        if (!pathData.positions || pathData.positions.length === 0) {
          log.warn("路径追踪文件 {path} 中没有有效的坐标数据", scriptPath);
          return null;
        }

        const lastPosition = pathData.positions[pathData.positions.length - 1];
        if (!lastPosition.x || !lastPosition.y) {
          log.warn(
            "路径追踪文件 {path} 的最后一个路径点缺少坐标数据",
            scriptPath
          );
          return null;
        }

        log.debug(
          "从脚本路径 {path} 获取到目标坐标: ({x}, {y})",
          scriptPath,
          lastPosition.x,
          lastPosition.y
        );
        return {
          x: lastPosition.x,
          y: lastPosition.y,
        };
      } catch (error) {
        log.error("获取委托目标坐标时出错: {error}", error.message);
        return null;
      }
    },

    // 解析流程文件中的分支（从main_branch.js移植）
    parseProcessBranches: (content) => {
      const branches = [];
      const branchRegex =
        /分支:(\d+)[\s\S]*?判断方法"([^"]+)"[\s\S]*?data:"([^"]+)"([\s\S]*?)(?=分支:|$)/g;

      let match;
      while ((match = branchRegex.exec(content)) !== null) {
        const branchId = parseInt(match[1]);
        const judgmentMethod = match[2];
        const judgmentData = match[3];
        const stepsContent = match[4].trim();

        // 解析步骤
        let steps = [];
        try {
          // 尝试解析JSON数组
          const jsonContent = `[${stepsContent}]`;
          steps = JSON.parse(jsonContent);
        } catch (error) {
          log.warn("解析分支{id}的步骤出错: {error}", branchId, error);
          continue;
        }

        branches.push({
          id: branchId,
          method: judgmentMethod,
          data: judgmentData,
          steps: steps,
        });
      }

      return branches;
    },

    // 确定要执行的分支（从main_branch.js移植）
    determineBranch: async (branches) => {
      for (const branch of branches) {
        switch (branch.method) {
          case "坐标":
            if (await CommissionsFunc.checkCoordinateMatch(branch.data)) {
              return branch;
            }
            break;

          case "任务追踪":
            if (await CommissionsFunc.checkTaskMatch(branch.data)) {
              return branch;
            }
            break;

          default:
            log.warn("未知的判断方法: {method}", branch.method);
        }
      }

      return null;
    },

    // 检查当前坐标是否匹配（从main_branch.js移植）
    checkCoordinateMatch: async (coordData) => {
      try {
        const [targetX, targetY] = coordData
          .split(",")
          .map((c) => parseFloat(c.trim()));

        // 获取当前委托位置
        const playerPos = await CommissionsFunc.getCurrentCommissionPosition();
        if (!playerPos) return false;

        // 计算距离
        const distance = CommissionsFunc.calculateDistance(playerPos, {
          x: targetX,
          y: targetY,
        });
        log.info(
          "当前位置: ({x}, {y})，目标位置: ({tx}, {ty})，距离: {d}",
          playerPos.x,
          playerPos.y,
          targetX,
          targetY,
          distance
        );

        // 如果距离小于阈值，认为匹配
        return distance < 100; // 可以调整阈值
      } catch (error) {
        log.error("检查坐标匹配出错: {error}", error.message);
        return false;
      }
    },

    // 检查当前任务是否匹配（从main_branch.js移植）
    checkTaskMatch: async (taskName) => {
      try {
        // 识别左上角任务区域文本
        const taskRegion = { X: 75, Y: 240, WIDTH: 225, HEIGHT: 60 };
        const taskResults = await Utils.easyOCR(taskRegion);

        // 检查是否包含目标任务名称
        for (let i = 0; i < taskResults.count; i++) {
          const text = taskResults[i].text;
          log.info(`任务区域识别文本: ${text}`);

          if (text.includes(taskName)) {
            log.info(`找到匹配任务: ${taskName}`);
            return true;
          }
        }

        log.info(`未找到匹配任务: ${taskName}`);
        return false;
      } catch (error) {
        log.error("检查任务匹配出错: {error}", error.message);
        return false;
      }
    },

    // 获取当前委托位置（辅助函数）
    getCurrentCommissionPosition: async () => {
      try {
        // 这里可以通过多种方式获取当前位置
        // 1. 从大地图获取
        await genshin.setBigMapZoomLevel(2);
        const bigMapPosition = genshin.getPositionFromBigMap();
        if (bigMapPosition) {
          return bigMapPosition;
        }

        // 2. 从当前委托位置变量获取（如果有的话）
        if (currentCommissionPosition) {
          return currentCommissionPosition;
        }

        log.warn("无法获取当前委托位置");
        return null;
      } catch (error) {
        log.error("获取当前委托位置时出错: {error}", error.message);
        return null;
      }
    },
  };

  const Test = async () => {
    Utils.iframe(Datas.OCR_REGIONS.Main_Dev[0]);
    // 角色切换步骤使用示例：
    // 在process.json文件中添加如下步骤：
    // {
    //   "type": "切换角色",
    //   "data": {
    //     "position": 1,
    //     "character": "枫原万叶"
    //   },
    //   "note": "切换第1号位为枫原万叶"
    // }

    // // 切换角色示例（可选）
    // // 如果需要切换角色，可以取消注释下面的代码
    // const switchRoleStep = {
    //   type: "切换角色",
    //   data: { position: 1, character: "枫原万叶" },
    //   note: "切换第1号位为枫原万叶",
    // };
    // await StepProcessor.processSwitchRole(switchRoleStep);
  };

  //Main
  const Main = async () => {
    log.debug("版本: {version}", VERSION);
    try {
      if (!settings.pause) {
        log.error("请在JS脚本自定义配置中配置暂停键");
        log.error("");
        log.error("请在JS脚本自定义配置中配置暂停键");
        log.error("");
        log.error("请在JS脚本自定义配置中配置暂停键");
        log.error("");
        await sleep(10000);
        return;
      }
      if (selectedProcess === "刷新剧情列表") {
        // 刷新操作：扫描所有process.json并更新设置
        await refreshProcessList();
        log.info("委托列表已刷新，请重新选择并运行");
        return;
      }

      // 每次运行都会扫描一遍
      await refreshProcessList();

      // 读取剧情列表（供运行面板的设置窗口使用）
      const settingsContent0 = file.readTextSync("./settings.json");
      const settingsArray0 = JSON.parse(settingsContent0);
      const sel0 = settingsArray0.find(item => item.name === "process_selector");
      const processPaths = (sel0 && sel0.process_paths) || {};
      const processList = Object.keys(processPaths).map(n => ({ name: n, path: processPaths[n] }));

      // 初始化并显示运行面板
      initOverlay(getVersion());
      initKeyHook();

      /* ★ 注册「指令列表」提供者：面板请求某个剧情的行列表时调用。
         用于「从指定行开始运行」的可视化选择。

         返回 [{ line, text, kind, cmd, selectable }]：
           · line       process.json 的**真实文件行号**（与编辑器一致）
           · kind       comment | meta | header | instr | unknown
           · cmd        指令名（仅 instr），供面板上色区分
           · selectable 是否可选为起点
                        —— **注释/元数据/块头不可选**（它们不产生执行）

         ★ 为什么直接读原始行、而不是只用解析结果：
           解析器会把注释整行丢弃，但注释恰恰是「这段在干什么」的说明，
           对用户选行很有引导价值。所以这里**逐行读原文**，
           再用解析结果（行号 → 指令）标注哪几行是真正可执行的。 */
      setLineListProvider((name) => {
        try {
          const p = processPaths[name];
          if (!p) return [];
          const content = file.readTextSync(p);
          const parsed = Execute.parseExtendedSimpleScript(content);

          // 建立「行号 → 指令」映射（解析器给的是真实文件行号）
          const instrAt = new Map();
          for (const block of (parsed.blocks || [])) {
            for (const ins of block.instructions) {
              if (ins.line) instrAt.set(ins.line, ins);
            }
          }

          const rawLines = content.split('\n');
          const out = [];
          for (let i = 0; i < rawLines.length; i++) {
            const lineNo = i + 1;
            const raw = rawLines[i];
            const trimmed = raw.trim();

            // 空行：跳过，避免列表被大量空白撑开
            if (trimmed === '') continue;

            // ① 注释行（# 或 //）→ 显示，但不可选
            if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
              out.push({ line: lineNo, text: trimmed, kind: 'comment', selectable: false });
              continue;
            }

            // ② 元数据（作者 / 描述）→ 显示，但不可选
            const ci = Math.max(trimmed.indexOf('：'), trimmed.indexOf(':'));
            const key = ci === -1 ? '' : trimmed.slice(0, ci).trim();
            if (/^作者$/i.test(key) || /^描述$/i.test(key)) {
              out.push({ line: lineNo, text: trimmed, kind: 'meta', selectable: false });
              continue;
            }

            // ③ 可执行指令（以解析结果为准）→ 可选
            const ins = instrAt.get(lineNo);
            if (ins) {
              out.push({
                line: lineNo,
                text: raw.replace(/\s+$/, ''),   // 保留行内注释，便于阅读
                kind: 'instr',
                cmd: ins.type,
                selectable: true
              });
              continue;
            }

            // ④ 块头（以 ：/: 结尾，且非网址）→ 显示，但不可选
            if (/[:：]$/.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
              out.push({ line: lineNo, text: trimmed, kind: 'header', selectable: false });
              continue;
            }

            // ⑤ 兜底（例如未识别的指令）→ 显示，但不可选
            out.push({ line: lineNo, text: trimmed, kind: 'unknown', selectable: false });
          }
          return out;
        } catch (e) {
          log.warn('读取指令列表失败: ' + (e && e.message));
          return [];
        }
      });

      /* ★★ 持续运行模式（settings 里选「持续运行」）★★
         脚本常驻挂载，但**不自动运行任何 process.json**；
         等用户在运行面板里选一个剧情才开始跑。
         跑完或点「放弃剧情」后回到「挂载但空闲」的初始状态。 */
      const persistent = (selectedProcess === "持续运行");
      if (persistent) {
        log.info("持续运行模式：脚本已挂载，等待在运行面板中选择剧情");
      }

      let currentName = persistent ? '' : selectedProcess;
      /* ★ 暂停通知要显示「当前运行：xxx」，所以在剧情名确定/切换时同步记录 */
      setNotifyProcess(currentName);
      // ⚠️ 必须先 showOverlay 建立 winId，否则 send('/mode') 会因窗口未就绪被丢弃
      await showOverlay({
        current: currentName,
        processes: processList,
        status: persistent ? 'waiting' : 'running'   // 持续运行首帧即显示空闲态
      });
      setPersistentMode(persistent);

      // ---- 运行循环：支持「切换剧情」「放弃剧情」立即生效 ----
      let running = true;
      let idle = persistent;          // 是否处于「挂载但空闲」状态

      while (running) {
        /* ============ 空闲态（仅持续运行模式） ============
           不跑任何剧情，只保持收信，等用户在面板里选。 */
        if (idle) {
          notifyWaiting();
          sendProcessList(processList, '');
          // 阻塞等待「选择剧情」请求；期间保持收信
          //
          // ★ 必须也调用 waitWhileInteracting()：
          //   否则按 K 后 interactActive 永远不会变 true，
          //   面板不会关闭点击穿透 → 用户点不到 ⚙，
          //   日志里只会反复看到「已请求进入交互模式，将在当前指令结束后暂停」，
          //   因为空闲态根本没有「指令」可结束。
          while (running && !hasSwitchRequest() && !hasAbandonRequest()) {
            await waitWhileInteracting();   // 空闲态同样支持 K 键交互
            pumpAndBeat();
            await sleep(200);
          }
          if (!running) break;

          // 空闲时点「放弃」→ 无剧情可放弃，忽略
          if (consumeAbandonRequest()) {
            log.info("持续运行：当前没有正在运行的剧情，忽略「放弃」");
            continue;
          }

          const pick = consumeSwitchRequest();
          if (!pick) continue;
          if (!processPaths[pick]) {
            log.warn(`持续运行：面板选择的 "${pick}" 不在剧情列表中，已忽略`);
            consumeStartLine();              // 丢弃无效的起始行
            continue;
          }
          currentName = pick;
          selectedProcess = pick;
          setNotifyProcess(currentName);       // 暂停通知跟随当前剧情
          idle = false;
          resetElapsed();                      // 新剧情 → 时间归零
          sendProcessList(processList, currentName);
          log.info(`持续运行：开始执行所选剧情「${currentName}」`);
        }

        /* ============ 执行态 ============ */
        const process_path = processPaths[currentName];
        if (!process_path) {
          log.error(`未找到名称为 "${currentName}" 的流程路径配置`);
          consumeStartLine();
          if (persistent) { idle = true; currentName = ''; continue; }
          break;
        }

        /* ★ 取出「从第几行开始」请求（0 = 从头）。
           一次性消费，避免下次复用同一行号。 */
        const startLine = consumeStartLine();

        log.info("执行任务: {path}", currentName);
        relativePath = process_path.replace(/^process[\\/]/, '');

        log.info("启用自动剧情");
        dispatcher.AddTrigger(new RealtimeTimer("AutoSkip"));
        if (!settings.noSkip) {
          log.info("启用自动拾取");
          dispatcher.AddTrigger(new RealtimeTimer("AutoPick"));
        }
        if (!settings.noEat) {
          log.info("启用自动吃药");
          dispatcher.AddTrigger(new RealtimeTimer("AutoEat"));
        }

        await switchPartyIfNeeded(team);
        sendProcessList(processList, currentName);
        sendProgress({ status: 'running', process: currentName });

        // 执行当前剧情；期间由 overlay 模块汇报切换/放弃请求
        await Execute.executeTalkCommission(process_path, startLine);
        dispatcher.ClearAllTriggers();

        /* ★ 优先处理「放弃剧情」（用户点了面板上的放弃按钮） */
        if (consumeAbandonRequest()) {
          if (persistent) {
            // 持续运行 → 回到「挂载但空闲」的初始状态
            log.info(`持续运行：已放弃剧情「${currentName}」，回到等待选择状态`);
            idle = true;
            currentName = '';
            setNotifyProcess('');
            resetElapsed();
            sendProcessList(processList, '');
            sendProgress({ status: 'idle', process: '', line: '', lineNo: 0 });
            continue;
          } else {
            // 其他模式 → 结束（停止）整个脚本
            log.info(`已放弃剧情「${currentName}」，脚本结束`);
            running = false;
            break;
          }
        }

        // 检查是否有来自面板的切换请求
        const next = consumeSwitchRequest();
        if (next) {
          log.info(`切换剧情：${currentName} → ${next}`);
          currentName = next;
          selectedProcess = next;
          setNotifyProcess(currentName);       // 暂停通知跟随当前剧情
          // ★ 切换剧情后「已运行」时间归零重新计算（用户要求）
          resetElapsed();
          // 让面板立刻反映新剧情
          sendProcessList(processList, currentName);
          sendProgress({ status: 'running', process: currentName, line: '', lineNo: 0 });
          continue;                        // 立即开始新剧情
        }

        /* 剧情自然跑完 */
        if (persistent) {
          // 持续运行 → 回到空闲态，等用户再选
          log.info(`持续运行：剧情「${currentName}」已完成，回到等待选择状态`);
          idle = true;
          currentName = '';
          setNotifyProcess('');
          resetElapsed();
          sendProcessList(processList, '');
          sendProgress({ status: 'idle', process: '', line: '', lineNo: 0 });
          continue;
        }
        running = false;
      }

      notifyDone();
      if (settings.xiaoxitongzhi) notification.error("脚本执行完成");
    } catch (error) {
      log.error("执行出错: {error}", error.message);
      errorlog();
      if (settings.xiaoxitongzhi) notification.error("脚本执行出错: " + error.message);
    } finally {
      // 脚本结束 / 出错时都要释放面板与按键钩子
      disposeOverlay();
    }
  };

// 刷新委托列表（保留完整路径结构）
async function refreshProcessList() {
  // 读取所有process.json文件
  const allFiles = await readFolder("process/", true);
  
  // 筛选并处理符合条件的process.json文件
  const processEntries = allFiles
      .filter(file => file.fileName === "process.json" && file.fullPath !== "process/process.json")
      .map(file => {
          const pathSegments = file.folderPathArray;
          
          // 确保路径中有"process"部分
          const processIndex = pathSegments.indexOf("process");
          if (processIndex === -1) {
              throw new Error(`无效的路径结构: ${file.fullPath}`);
          }
          
          // 提取"process"之后的所有部分作为选项名称
          const optionName = pathSegments.slice(processIndex + 1).join('-');
          
          return {
              name: optionName,
              path: file.fullPath
          };
      });

  // 创建选项列表（以「刷新剧情列表」和「持续运行」开头）
  // ★ 这两个是**功能项**而非剧情，必须固定保留，不能被扫描结果覆盖。
  const options = ["刷新剧情列表", "持续运行", ...processEntries.map(entry => entry.name)];
  
  // 更新settings.json
  await updateSettingsFile(options, processEntries);
  log.info("已更新{count}个委托选项", processEntries.length);
}

// 更新settings.json文件
async function updateSettingsFile(options, processEntries) {
    const settingsPath = "./settings.json";
    let settingsArray;
    
    try {
        // 读取现有设置
        const content = file.readTextSync(settingsPath);
        settingsArray = JSON.parse(content);
    } catch (e) {
        // 文件不存在或解析失败时创建默认设置
        throw new Error("设置文件不存在");
    }
    
    // 更新process_selector选项
    const selectorIndex = settingsArray.findIndex(item => item.name === "process_selector");
    if (selectorIndex !== -1) {
        settingsArray[selectorIndex].options = options;
        settingsArray[selectorIndex].default = "刷新剧情列表";
        
        // 更新每个选项对应的process.json路径
        settingsArray[selectorIndex].process_paths = {};
        for (const entry of processEntries) {
            settingsArray[selectorIndex].process_paths[entry.name] = entry.path;
        }

    } else {
        // 如果不存在则添加
        const processPaths = {};
        for (const entry of processEntries) {
            processPaths[entry.name] = entry.path;
        }
        settingsArray.push({
            "name": "process_selector",
            "type": "select",
            "label": "可执行剧情列表",
            "options": options,
            "default": "刷新剧情列表",
            "process_paths": processPaths
        });
    }
    
    // 写入更新后的设置
    const success = file.writeTextSync(settingsPath, JSON.stringify(settingsArray, null, 2));
    if (!success) {
        throw new Error("写入设置文件失败");
    }
}

// 文件夹读取函数（优化版）
async function readFolder(folderPath, onlyJson) {
    log.info(`开始读取文件夹: ${folderPath}`);
    const folderStack = [folderPath];
    const files = [];

    while (folderStack.length > 0) {
        const currentPath = folderStack.pop();
        const items = file.ReadPathSync(currentPath);
        const subFolders = [];

        for (const itemPath of items) {
            if (file.IsFolder(itemPath)) {
                subFolders.push(itemPath);
            } else if (!onlyJson || itemPath.toLowerCase().endsWith(".json")) {
                const pathParts = itemPath.split(/[\\\/]/).filter(Boolean);
                const fileName = pathParts.pop();
                files.push({
                    fullPath: itemPath,
                    fileName: fileName,
                    folderPathArray: pathParts
                });
            }
        }

        // 保持原始顺序添加子文件夹
        folderStack.push(...subFolders.reverse());
    }

    return files;
}

//切换队伍
async function switchPartyIfNeeded(partyName) {
  if (!partyName) {
      await genshin.returnMainUi();
      return;
  }
  try {
      log.info("正在尝试切换至" + partyName);
      if (!await genshin.switchParty(partyName)) {
          log.info("切换队伍失败，前往七天神像重试");
          await genshin.tpToStatueOfTheSeven();
          await genshin.switchParty(partyName);
      }
  } catch {
      log.error("队伍切换失败，可能处于联机模式或其他不可切换状态");
      notification.error(`切换失败，可能处于联机模式或其他不可切换状态`);
      await genshin.returnMainUi();
  }
}

await Main();
})();

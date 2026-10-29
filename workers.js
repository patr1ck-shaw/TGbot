// Cloudflare Worker: Shaw Telegram 私聊 <-> 超级群话题 转发机器人 (完整功能 + Workers AI)

const SHAW_KV = {
  topicByUser: (userId) => `shaw:topic:user:${userId}`,
  userByThread: (threadId) => `shaw:topic:thread:${threadId}`,
  userProfile: (userId) => `shaw:user:${userId}:profile`,
  verifySession: (userId) => `shaw:verify:${userId}`,
  spamState: (userId) => `shaw:spam:${userId}`,
  mediaGroup: (direction, mediaGroupId) => `shaw:mg:${direction}:${mediaGroupId}`,
  rateLimit: (userId, windowSec, bucket) => `shaw:rl:${userId}:${windowSec}:${bucket}`,
  topicCreateLock: (userId) => `shaw:lock:topic:${userId}`,
};

const SHAW_SETTINGS = {
  verify: {
    ttlSec: 180,
    maxAttempts: 3,
    optionCount: 6,
  },
  trust: {
    newUserWindowMs: 24 * 60 * 60 * 1000, // 24小时内算新用户
    trustedBypassAdCheck: true,
  },
  rateLimit: {
    newcomer: [
      { windowSec: 10, limit: 2 },
      { windowSec: 60, limit: 6 },
    ],
    normal: [
      { windowSec: 10, limit: 4 },
      { windowSec: 60, limit: 12 },
    ],
  },
  antiSpam: {
    rejectForwardedPrivateMessages: true,
    repeatWindowMs: 90 * 1000,
    repeatThreshold: 3,
    riskWindowMs: 10 * 60 * 1000,
    riskThresholdHitsNew: 1,
    riskThresholdHitsNormal: 3,
    hardScoreNew: 4,
    hardScoreNormal: 5,
    softScoreNew: 1,
    softScoreNormal: 3,
    cooldownMs: 30 * 60 * 1000,
  },
  mediaGroupFlushDelayMs: 2000,
};

const SHAW_COMMON_SENSE_QUESTIONS = [
  { question: "太阳通常从哪边升起？", options: ["东边", "西边", "北边", "南边"], correctIndex: 0 },
  { question: "一年有多少个月？", options: ["10", "11", "12", "13"], correctIndex: 2 },
  { question: "水在标准大气压下大约多少℃沸腾？", options: ["0℃", "50℃", "100℃", "150℃"], correctIndex: 2 },
  { question: "地球上白天和黑夜主要由什么造成？", options: ["地球自转", "月亮绕地球", "太阳绕地球", "季节变化"], correctIndex: 0 },
  { question: "中国首都城市是？", options: ["上海", "北京", "广州", "深圳"], correctIndex: 1 },
  { question: "一周通常有几天？", options: ["5", "6", "7", "8"], correctIndex: 2 },
];

export default {
  async fetch(request, env, ctx) {
    const bootstrapError = validateEnv(env);
    if (bootstrapError) return new Response(bootstrapError, { status: 500 });

    if (request.method !== "POST") return new Response("OK");

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK");
    }

    try {
      if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
        return new Response("OK");
      }

      const msg = update.message;
      if (!msg) return new Response("OK");

      if (msg.chat?.type === "private") {
        await handlePrivateChatMessage(msg, env, ctx);
        return new Response("OK");
      }

      const supergroupId = Number(env.SUPERGROUP_ID);
      if (Number(msg.chat?.id) === supergroupId) {
        if (!msg.message_thread_id && msg.text?.startsWith("/")) {
          await handleSupergroupControlCommand(msg, env);
          return new Response("OK");
        }
        if (msg.message_thread_id) {
          await handleSupergroupThreadMessage(msg, env, ctx);
        }
      }
    } catch (err) {
      const errorText = err?.message || String(err);
      console.error("Unhandled error:", errorText);

      const privateChatId = update?.message?.chat?.type === "private" ? update.message.chat.id : null;
      if (privateChatId) {
        await shawTelegramCall(env, "sendMessage", {
          chat_id: privateChatId,
          text: `⚠️ 转发失败：${String(errorText).slice(0, 180)}`,
        });
      }
    }

    return new Response("OK");
  },
};

function validateEnv(env) {
  if (!env.PM) return "Error: KV 'PM' not bound.";
  if (!env.BOT_TOKEN) return "Error: BOT_TOKEN not set.";
  if (!env.SUPERGROUP_ID) return "Error: SUPERGROUP_ID not set.";
  return "";
}

// 修正 AI 识别函数（支持通过环境变量动态配置模型，默认使用 qwen3.8-27b）
async function checkSpamWithAI(env, text) {
  if (!env.AI || !text || text.trim().length < 4) return false;

  // 优先读取环境变量中配置的模型，未配置则使用默认的 qwen3.8-27b
  const modelName = env.AI_MODEL || "@cf/qwen/qwen3.8-27b";

  try {
    const response = await env.AI.run(modelName, {
      messages: [
        {
          role: "system",
          content: "你是一个 Telegram 账号安全风控助手。请判断用户发送的消息是否属于垃圾广告、黑产引流、买卖账号或诈骗。如果属于违规内容，请直接回答 YES；如果是正常交流或咨询，请直接回答 NO。不要输出任何多余字符。"
        },
        {
          role: "user",
          content: text
        }
      ],
      max_tokens: 256
    });

    const rawContent = response.choices?.[0]?.message?.content || response.response || "";
    // 剥离 Qwen 等模型的 <think> 思考链标签（兼容其他模型即使没有该标签也无影响）
    const cleanContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().toUpperCase();

    console.log(`使用模型 [${modelName}] 最终 AI 判断提取结果:`, cleanContent);
    return cleanContent.includes("YES");
  } catch (err) {
    console.error(`AI 模型 (${modelName}) 调用失败:`, err?.message || err);
    return false;
  }
}

async function handlePrivateChatMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const text = (msg.text || "").trim();
  const now = Date.now();

  const profile = await getUserProfile(userId, env);
  const isTrusted = profile.trusted === true;
  if (!isTrusted && profile.cooldownUntil && now < profile.cooldownUntil) {
    await shawTelegramCall(env, "sendMessage", {
      chat_id: userId,
      text: "⏳ 当前账号处于冷却中，请稍后再试。",
    });
    return;
  }

  if (text === "/start") {
    if (profile.verified) {
      await shawTelegramCall(env, "sendMessage", {
        chat_id: userId,
        text: "你已通过验证，可以直接发送消息。",
      });
    } else {
      await sendVerificationChallenge(userId, env);
    }
    return;
  }

  if (!profile.verified) {
    await ensureVerificationPrompt(userId, env);
    return;
  }

  if (msg.text?.startsWith("/")) return;

  const topicSnapshot = await getUserTopicIfExists(userId, env);
  if (topicSnapshot?.closed) {
    await shawTelegramCall(env, "sendMessage", {
      chat_id: userId,
      text: "🚫 当前对话已被管理员关闭。",
    });
    return;
  }

  // 1. 转发消息硬拦截
  if (SHAW_SETTINGS.antiSpam.rejectForwardedPrivateMessages && isForwardedMessage(msg)) {
    if (!isTrusted) {
      await applyAutoCooldownIfAllowed(userId, now + SHAW_SETTINGS.antiSpam.cooldownMs, env);
    }

    await notifyAdminSpamIntercept(userId, msg, env, {
      action: isTrusted ? "drop" : "cooldown",
      score: 99,
      reasons: ["forwarded:hard_block"],
      detail: "私聊转发消息触发硬拦截",
    });
    await shawTelegramCall(env, "sendMessage", {
      chat_id: userId,
      text: "⛔ 为防止转发推广绕过审核，机器人不接收转发消息。请直接输入你要咨询的内容。",
    });
    return;
  }

  // 2. Rate Limit 限频检测
  const isNewUser = !isTrusted && now - (profile.verifiedAt || now) < SHAW_SETTINGS.trust.newUserWindowMs;
  const limiterRules = isNewUser ? SHAW_SETTINGS.rateLimit.newcomer : SHAW_SETTINGS.rateLimit.normal;
  const allowed = await consumeRateLimit(userId, limiterRules, env, now);
  if (!allowed) {
    await shawTelegramCall(env, "sendMessage", {
      chat_id: userId,
      text: "⚠️ 发送太频繁了，请稍后再发。",
    });
    return;
  }

  // 3. 重复骚扰文本刷屏检测
  if (msg.text) {
    const spamVerdict = await evaluateRepeatSpam(userId, msg.text, env, now);
    if (spamVerdict.blocked) {
      await notifyAdminSpamIntercept(userId, msg, env, {
        action: "cooldown",
        score: 0,
        reasons: spamVerdict.reasons || ["repeat:text"],
        detail: "重复骚扰内容触发自动冷却",
      });
      await shawTelegramCall(env, "sendMessage", {
        chat_id: userId,
        text: "🚫 检测到重复骚扰内容，账号已临时冷却。",
      });
      return;
    }
  }

  // 4. 非信任用户的广告与 AI 双重检测
  if (!(isTrusted && SHAW_SETTINGS.trust.trustedBypassAdCheck)) {
    const rawText = msg.text || msg.caption || "";

    // ⚡ 第一步：先跑微秒级的静态规则与正则打分（先挡明枪，0 成本秒杀）
    const adVerdict = await evaluateAdSpam(userId, msg, isNewUser, env, now);
    
    // 如果正则打分直接达到了【硬拦截/冷却】标准，立即冷却并退出，不消耗 AI 额度
    if (adVerdict.blocked) {
      await notifyAdminSpamIntercept(userId, msg, env, {
        action: "cooldown",
        score: adVerdict.score,
        reasons: adVerdict.reasons,
        detail: "疑似广告/引流内容（静态规则）触发自动冷却",
      });
      await shawTelegramCall(env, "sendMessage", {
        chat_id: userId,
        text: "🚫 检测到疑似广告/引流内容，账号已临时冷却。",
      });
      return;
    }

    // 🤖 第二步：正则未达到硬拦截标准，但存在文本，再交给 AI 兜底识别（后防暗箭，抓变体）
    if (rawText) {
      // 截取前 300 字符，既保护 Token 额度，又能大幅提升 AI 响应速度
      const truncatedText = rawText.slice(0, 300);
      const isSpamByAI = await checkSpamWithAI(env, truncatedText);

      if (isSpamByAI) {
        await applyAutoCooldownIfAllowed(userId, now + SHAW_SETTINGS.antiSpam.cooldownMs, env);
        await notifyAdminSpamIntercept(userId, msg, env, {
          action: "cooldown",
          score: 99,
          reasons: ["workers_ai:spam"],
          detail: "AI 识别为广告/号商/黑产引流",
        });
        await shawTelegramCall(env, "sendMessage", {
          chat_id: userId,
          text: "🚫 检测到疑似广告/黑产引流内容，账号已临时冷却。",
        });
        return; // 👈 此处加了 return，拦截后不再触发后续逻辑
      }
    }

    // ⚠️ 第三步：AI 也觉得安全，最后才处理正则的【软警告/拦截单条不冷却】
    if (adVerdict.warned) {
      await notifyAdminSpamIntercept(userId, msg, env, {
        action: "drop",
        score: adVerdict.score,
        reasons: adVerdict.reasons,
        detail: "疑似广告/引流内容，本条已拦截但未冷却",
      });
      await shawTelegramCall(env, "sendMessage", {
        chat_id: userId,
        text: "⛔ 检测到疑似广告特征，本条消息已拦截且未转发。请勿发送链接、联系方式或转发推广内容。",
      });
      return;
    }
  }

  // 5. 校验通过，安全转发到超级群 Topic
  await forwardPrivateMessageToTopic(msg, userId, env, ctx);
}

// --- 验证码逻辑 ---

async function handleCallbackQuery(query, env) {
  const userId = query.from?.id;
  const data = query.data || "";

  if (!userId) {
    await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "无效操作", show_alert: false });
    return;
  }

  if (data.startsWith("admin_unfreeze|")) {
    await handleAdminUnfreezeCallback(query, env);
    return;
  }

  if (data.startsWith("admin_clean|")) {
    await handleAdminCleanCallback(query, env);
    return;
  }

  if (!data.startsWith("verify|")) {
    await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "无效操作", show_alert: false });
    return;
  }

  if (Number(query.message?.chat?.id) !== Number(userId)) {
    await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "验证来源异常", show_alert: true });
    return;
  }

  const parts = data.split("|");
  if (parts.length !== 3) {
    await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "验证数据异常", show_alert: true });
    return;
  }

  const [, nonce, selectedRaw] = parts;
  const selectedIndex = Number(selectedRaw);
  if (!Number.isInteger(selectedIndex)) {
    await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "选项无效", show_alert: true });
    return;
  }

  const key = SHAW_KV.verifySession(userId);
  const session = await env.PM.get(key, { type: "json" });
  const now = Date.now();

  if (!session || session.nonce !== nonce || now > session.expiresAt) {
    await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "验证已过期，请重新发送 /start", show_alert: true });
    return;
  }

  if (selectedIndex === session.correctIndex) {
    await markUserVerified(userId, env, now);
    await env.PM.delete(key);

    await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "✅ 验证通过", show_alert: false });

    if (query.message?.message_id) {
      await shawTelegramCall(env, "editMessageText", {
        chat_id: userId,
        message_id: query.message.message_id,
        text: "✅ 验证通过。现在你可以正常发送消息了。",
      });
    }
    return;
  }

  session.attempts += 1;
  if (session.attempts >= session.maxAttempts) {
    await applyAutoCooldownIfAllowed(userId, now + SHAW_SETTINGS.antiSpam.cooldownMs, env);
    await env.PM.delete(key);

    await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "验证失败次数过多，请稍后再试", show_alert: true });

    if (query.message?.message_id) {
      await shawTelegramCall(env, "editMessageText", {
        chat_id: userId,
        message_id: query.message.message_id,
        text: "❌ 验证失败次数过多，已进入冷却。请 30 分钟后再试。",
      });
    }
    return;
  }

  await env.PM.put(key, JSON.stringify(session), { expirationTtl: SHAW_SETTINGS.verify.ttlSec });
  await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: `答案错误，还剩 ${session.maxAttempts - session.attempts} 次`, show_alert: false });
}

async function ensureVerificationPrompt(userId, env) {
  const active = await env.PM.get(SHAW_KV.verifySession(userId), { type: "json" });
  if (active && Date.now() <= active.expiresAt) {
    await shawTelegramCall(env, "sendMessage", { chat_id: userId, text: "请先完成上方验证题目后再发送消息。" });
    return;
  }
  await sendVerificationChallenge(userId, env);
}

async function sendVerificationChallenge(userId, env) {
  const challenge = generateShawChallenge();
  const session = {
    nonce: challenge.nonce,
    correctIndex: challenge.correctIndex,
    options: challenge.options,
    attempts: 0,
    maxAttempts: SHAW_SETTINGS.verify.maxAttempts,
    expiresAt: Date.now() + SHAW_SETTINGS.verify.ttlSec * 1000,
    type: challenge.type,
  };

  await env.PM.put(SHAW_KV.verifySession(userId), JSON.stringify(session), { expirationTtl: SHAW_SETTINGS.verify.ttlSec });

  await shawTelegramCall(env, "sendMessage", {
    chat_id: userId,
    text: `🛡️ Shaw 安全验证（${Math.floor(SHAW_SETTINGS.verify.ttlSec / 60)} 分钟内有效）\n\n${challenge.question}`,
    reply_markup: { inline_keyboard: buildVerifyKeyboard(challenge.options, challenge.nonce) },
  });
}

function buildVerifyKeyboard(options, nonce) {
  const cols = 3;
  const rows = [];
  for (let i = 0; i < options.length; i += cols) {
    rows.push(options.slice(i, i + cols).map((optionText, idx) => ({ text: optionText, callback_data: `verify|${nonce}|${i + idx}` })));
  }
  return rows;
}

function generateShawChallenge() {
  const useMath = Math.random() < 0.78;
  return useMath ? generateShawMathChallenge() : generateShawCommonSenseChallenge();
}

function generateShawMathChallenge() {
  const style = randomInt(1, 3);
  let question = "", answer = 0;
  if (style === 1) {
    const a = randomInt(5, 35), b = randomInt(1, 20);
    answer = a - b; question = `请计算：${a} - ${b} = ?`;
  } else if (style === 2) {
    const a = randomInt(2, 12), b = randomInt(2, 9);
    answer = a * b; question = `请计算：${a} × ${b} = ?`;
  } else {
    const a = randomInt(1, 20), b = randomInt(1, 20), c = randomInt(1, 15);
    answer = a + b - c; question = `请计算：${a} + ${b} - ${c} = ?`;
  }

  const optionSet = new Set([answer]);
  while (optionSet.size < SHAW_SETTINGS.verify.optionCount) {
    const spread = Math.max(6, Math.ceil(Math.abs(answer) * 0.35));
    const offset = randomInt(-spread, spread);
    optionSet.add(Math.max(0, answer + offset));
  }

  const options = shuffleArray([...optionSet]).map((v) => String(v));
  return { type: "math", question, options, correctIndex: options.findIndex((v) => Number(v) === answer), nonce: createNonce() };
}

function generateShawCommonSenseChallenge() {
  const picked = SHAW_COMMON_SENSE_QUESTIONS[randomInt(0, SHAW_COMMON_SENSE_QUESTIONS.length - 1)];
  const order = shuffleArray([0, 1, 2, 3]);
  return { type: "general", question: `常识题：${picked.question}`, options: order.map((idx) => picked.options[idx]), correctIndex: order.findIndex((idx) => idx === picked.correctIndex), nonce: createNonce() };
}

async function markUserVerified(userId, env, now) {
  const profile = await getUserProfile(userId, env);
  profile.verified = true; profile.verifiedAt = now; profile.cooldownUntil = 0;
  await setUserProfile(userId, profile, env);
}

async function getUserProfile(userId, env) {
  return (await env.PM.get(SHAW_KV.userProfile(userId), { type: "json" })) || { verified: false, verifiedAt: 0, cooldownUntil: 0, trusted: false, trustedAt: 0, trustedBy: 0 };
}

async function setUserProfile(userId, profile, env) {
  await env.PM.put(SHAW_KV.userProfile(userId), JSON.stringify(profile));
}

// --- 限频与状态判定 ---

async function consumeRateLimit(userId, rules, env, nowMs) {
  const nowSec = Math.floor(nowMs / 1000);
  for (const rule of rules) {
    const bucket = Math.floor(nowSec / rule.windowSec);
    const key = SHAW_KV.rateLimit(userId, rule.windowSec, bucket);
    const current = Number((await env.PM.get(key)) || "0");
    if (current >= rule.limit) return false;
    await env.PM.put(key, String(current + 1), { expirationTtl: Math.max(60, rule.windowSec + 5) });
  }
  return true;
}

async function evaluateRepeatSpam(userId, text, env, now) {
  const key = SHAW_KV.spamState(userId);
  const state = ensureSpamStateShape(await env.PM.get(key, { type: "json" }));
  const normalized = normalizeText(text);
  const hash = simpleHash(normalized);

  if (hash === state.hash && now - state.lastAt <= SHAW_SETTINGS.antiSpam.repeatWindowMs) {
    state.count += 1;
  } else {
    state.hash = hash; state.count = 1;
  }

  state.lastAt = now;
  await env.PM.put(key, JSON.stringify(state), { expirationTtl: 24 * 3600 });

  if (state.count >= SHAW_SETTINGS.antiSpam.repeatThreshold) {
    await applyAutoCooldownIfAllowed(userId, now + SHAW_SETTINGS.antiSpam.cooldownMs, env);
    return { blocked: true, reasons: [`repeat:text:${state.count}`] };
  }
  return { blocked: false };
}

// 包含正则与特征打分的完整逻辑
async function evaluateAdSpam(userId, msg, isNewUser, env, now) {
  const key = SHAW_KV.spamState(userId);
  const state = ensureSpamStateShape(await env.PM.get(key, { type: "json" }));
  const { score, reasons } = scoreSpamSignals(msg, isNewUser);

  const hardScore = isNewUser ? SHAW_SETTINGS.antiSpam.hardScoreNew : SHAW_SETTINGS.antiSpam.hardScoreNormal;
  const softScore = isNewUser ? SHAW_SETTINGS.antiSpam.softScoreNew : SHAW_SETTINGS.antiSpam.softScoreNormal;
  const riskHitLimit = isNewUser ? SHAW_SETTINGS.antiSpam.riskThresholdHitsNew : SHAW_SETTINGS.antiSpam.riskThresholdHitsNormal;

  if (now - Number(state.riskWindowStart || 0) > SHAW_SETTINGS.antiSpam.riskWindowMs) {
    state.riskWindowStart = now; state.riskHits = 0;
  }

  if (score >= hardScore) {
    state.riskHits += 1; state.lastAt = now;
    await env.PM.put(key, JSON.stringify(state), { expirationTtl: 24 * 3600 });
    await applyAutoCooldownIfAllowed(userId, now + SHAW_SETTINGS.antiSpam.cooldownMs, env);
    return { blocked: true, warned: false, score, reasons };
  }

  if (score >= softScore) {
    state.riskHits += 1; state.lastAt = now;
    await env.PM.put(key, JSON.stringify(state), { expirationTtl: 24 * 3600 });
    if (state.riskHits >= riskHitLimit) {
      await applyAutoCooldownIfAllowed(userId, now + SHAW_SETTINGS.antiSpam.cooldownMs, env);
      return { blocked: true, warned: false, score, reasons };
    }
    return { blocked: false, warned: true, score, reasons };
  }

  if (state.riskHits > 0) {
    state.riskHits = Math.max(0, state.riskHits - 1); state.lastAt = now;
    await env.PM.put(key, JSON.stringify(state), { expirationTtl: 24 * 3600 });
  }

  return { blocked: false, warned: false, score, reasons };
}

function ensureSpamStateShape(raw) {
  return { hash: raw?.hash || "", count: Number(raw?.count || 0), lastAt: Number(raw?.lastAt || 0), riskHits: Number(raw?.riskHits || 0), riskWindowStart: Number(raw?.riskWindowStart || 0) };
}

// 保留原有的正则黑名单 + 综合打分
function scoreSpamSignals(msg, isNewUser = false) {
  let score = 0; const reasons = [];
  const text = (msg.text || msg.caption || "").trim();
  const normalized = normalizeText(text);
  const compact = compactForKeywordMatch(normalized);

  if (isForwardedMessage(msg)) { score += 4; reasons.push("forwarded:4"); }
  if (msg.via_bot) { score += 2; reasons.push("via_bot:2"); }

  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const riskyEntities = entities.filter((e) => new Set(["url", "text_link", "mention", "phone_number"]).has(e.type));
  if (riskyEntities.length > 0) {
    const entityScore = Math.min(3, riskyEntities.length);
    score += entityScore; reasons.push(`entity:${riskyEntities.map((e) => e.type).join(",")}:${entityScore}`);
  }

  if (/(https?:\/\/|t\.me\/|telegram\.me\/|tg:\/\/|telegra\.ph\/)/i.test(normalized)) { score += 3; reasons.push("link:3"); }
  if (/@[\p{L}\p{N}_]{5,}/u.test(normalized)) { score += 2; reasons.push("mention_text:2"); }

  // 广告关键词正则匹配（已精简特定词，留给 AI 去判断复杂黑产）
  if (
    /(群发|引流|广告|推广|全网覆盖|自动群发|兼职|返利|代发|私聊我|联系我|日入)/i.test(normalized) ||
    /(群发|引流|广告|推广|全网覆盖|自动群发|兼职|返利|代发|私聊我|联系我|微信|weixin|vx|v信)/i.test(compact)
  ) {
    score += 2;
    reasons.push("keyword:ad_contact:2");
  }

  // 以下新用户发媒体文件/图片的额外判定逻辑要保留
  if (isNewUser && msg.document) { score += 2; reasons.push("new_user_document:2"); }
  if (isNewUser && msg.video) { score += 1; reasons.push("new_user_video:1"); }
  if (isNewUser && msg.photo?.length && !text) { score += 1; reasons.push("new_user_photo_without_caption:1"); }

  return { score, reasons };
}

// 2. 优化管理员拦截日志推送（仅在专属话题内推送精简、易懂的中文提示）
async function notifyAdminSpamIntercept(userId, msg, env, verdict) {
  try {
    const supergroupId = Number(env.SUPERGROUP_ID);
    const topic = await getUserTopicIfExists(userId, env);

    if (!topic || !topic.threadId) {
      return;
    }

    // 💡 将底层代号归类并精简为通俗易懂的中文说明
    const simplifiedReasons = [];
    for (const r of verdict.reasons) {
      if (r.startsWith("forwarded")) simplifiedReasons.push("发送了转发消息");
      else if (r.startsWith("via_bot")) simplifiedReasons.push("使用了内联机器人");
      else if (r.includes("url") || r.includes("link") || r.includes("t.me")) simplifiedReasons.push("包含网址或链接");
      else if (r.includes("mention") || r.includes("phone")) simplifiedReasons.push("包含 @提及 或电话号码");
      else if (r.includes("keyword")) simplifiedReasons.push("包含广告关键词");
      else if (r.startsWith("new_user_")) simplifiedReasons.push("新用户受限媒体");
      else if (r === "workers_ai:spam") simplifiedReasons.push("AI识别为垃圾广告");
      else if (r.startsWith("repeat:text")) simplifiedReasons.push("重复刷屏");
      else simplifiedReasons.push("触发风控规则");
    }

    // 数组去重，避免重复提示同一类原因
    const uniqueReasons = [...new Set(simplifiedReasons)];
    const actionDesc = verdict.action === "cooldown" ? "已触发冷却禁言" : "已拦截单条消息";

    // 保持只发送精简的一行
    const logText = `⚠️ <b>[系统提示]</b> 消息已被拦截（动作: <code>${actionDesc}</code> | 原因: <b>${uniqueReasons.join("、")}</b>）`;

    const payload = {
      chat_id: supergroupId,
      text: logText,
      parse_mode: "HTML",
      message_thread_id: topic.threadId, 
    };

    await shawTelegramCall(env, "sendMessage", payload);
  } catch (e) {
    console.error("发送管理员拦截通知失败:", e);
  }
}

function isForwardedMessage(msg) {
  return Boolean(msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name || msg.forward_date || msg.is_automatic_forward);
}


// --- 超级群 Topic 转发逻辑 ---

async function forwardPrivateMessageToTopic(msg, userId, env, ctx) {
  let topic = await getOrCreateUserTopic(msg, userId, env);
  if (topic.closed) {
    await shawTelegramCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
    return;
  }

  if (msg.media_group_id) {
    await collectAndFlushMediaGroup(msg, env, ctx, { direction: "p2t", targetChatId: Number(env.SUPERGROUP_ID), threadId: topic.threadId });
    return;
  }

  const forwarded = await shawTelegramCall(env, "forwardMessage", {
    chat_id: Number(env.SUPERGROUP_ID),
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: topic.threadId,
  });

  const droppedInGeneral = forwarded.ok && !forwarded.result?.message_thread_id;
  if (!forwarded.ok || droppedInGeneral) {
    topic = await recreateTopicAndRefwd(msg, userId, env, forwarded);
  }

  return topic;
}

async function getOrCreateUserTopic(msg, userId, env) {
  const existing = await env.PM.get(SHAW_KV.topicByUser(userId), { type: "json" });
  if (existing?.threadId) {
    const reverse = Number(await env.PM.get(SHAW_KV.userByThread(existing.threadId)) || 0);
    if (reverse !== userId) await env.PM.put(SHAW_KV.userByThread(existing.threadId), String(userId));
    return existing;
  }

  return await withUserTopicCreateLock(userId, env, async () => {
    const latest = await env.PM.get(SHAW_KV.topicByUser(userId), { type: "json" });
    if (latest?.threadId) return latest;

    const title = buildTopicTitle(msg);
    const created = await shawTelegramCall(env, "createForumTopic", { chat_id: Number(env.SUPERGROUP_ID), name: title });
    if (!created.ok) throw new Error(`创建话题失败: ${created.description}`);

    const record = { userId, threadId: created.result.message_thread_id, title, closed: false, createdAt: Date.now() };
    await env.PM.put(SHAW_KV.topicByUser(userId), JSON.stringify(record));
    await env.PM.put(SHAW_KV.userByThread(record.threadId), String(userId));
    return record;
  });
}

async function recreateTopicAndRefwd(msg, userId, env, forwarded) {
  const errDesc = (forwarded.description || "").toLowerCase();
  const shouldResetAndReverify = (!forwarded.ok && (errDesc.includes("thread") || errDesc.includes("topic") || errDesc.includes("not found"))) || (forwarded.ok && !forwarded.result?.message_thread_id);
  if (!shouldResetAndReverify) return null;

  if (forwarded.ok && forwarded.result?.message_id) {
    await shawTelegramCall(env, "deleteMessage", { chat_id: Number(env.SUPERGROUP_ID), message_id: forwarded.result.message_id });
  }

  const oldTopic = await getUserTopicIfExists(userId, env);
  await env.PM.delete(SHAW_KV.topicByUser(userId));
  if (oldTopic?.threadId) await env.PM.delete(SHAW_KV.userByThread(oldTopic.threadId));

  await resetUserVerification(userId, env);
  await shawTelegramCall(env, "sendMessage", { chat_id: userId, text: "⚠️ 原会话话题已失效（可能被管理员删除），请重新验证后发送：/start" });
  return null;
}

// --- 超级群管理员命令处理 ---

async function handleSupergroupControlCommand(msg, env) {
  const text = (msg.text || "").trim();
  const isAdmin = await isGroupAdmin(env, Number(env.SUPERGROUP_ID), msg.from?.id);
  if (!isAdmin) {
    await shawTelegramCall(env, "sendMessage", { chat_id: Number(env.SUPERGROUP_ID), text: "仅管理员可用。" });
    return;
  }

  if (text === "/help") { await sendAdminHelp(env); return; }
  if (text === "/cl" || text === "/cool") { await sendCooldownList(msg, env); return; }

  if (text.startsWith("/uf")) {
    const uid = Number(text.split(/\s+/)[1]);
    const ok = uid ? await unfreezeUser(uid, env) : false;
    await shawTelegramCall(env, "sendMessage", { chat_id: Number(env.SUPERGROUP_ID), text: ok ? `✅ 已解封 UID ${uid}` : `⚠️ UID ${uid} 当前无冷却或不存在` });
    return;
  }

  if (text.startsWith("/trust ")) {
    const uid = Number(text.split(/\s+/)[1]);
    const ok = uid ? await setUserTrust(uid, true, msg.from?.id, env) : false;
    await shawTelegramCall(env, "sendMessage", { chat_id: Number(env.SUPERGROUP_ID), text: ok ? `✅ 已加入信任列表 UID ${uid}` : `⚠️ UID ${uid} 未验证或无效` });
    return;
  }

  if (text.startsWith("/untrust ")) {
    const uid = Number(text.split(/\s+/)[1]);
    const ok = uid ? await setUserTrust(uid, false, msg.from?.id, env) : false;
    await shawTelegramCall(env, "sendMessage", { chat_id: Number(env.SUPERGROUP_ID), text: ok ? `✅ 已取消信任 UID ${uid}` : `⚠️️ UID ${uid} 无效` });
    return;
  }

  if (text.startsWith("/clean ")) {
    const uid = Number(text.split(/\s+/)[1]);
    const stats = uid ? await cleanupUserScopedData(uid, env) : null;
    await shawTelegramCall(env, "sendMessage", { chat_id: Number(env.SUPERGROUP_ID), text: stats ? `✅ 已清理 UID ${uid} 的关联数据` : `⚠️ UID ${uid} 无效` });
    return;
  }
}

async function handleAdminUnfreezeCallback(query, env) {
  const groupId = Number(env.SUPERGROUP_ID);
  if (Number(query.message?.chat?.id) !== groupId) return;
  const isAdmin = await isGroupAdmin(env, groupId, query.from?.id);
  if (!isAdmin) return;

  const uid = Number((query.data || "").split("|")[1]);
  const ok = uid ? await unfreezeUser(uid, env) : false;
  await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: ok ? `已解封 ${uid}` : "该用户当前无冷却", show_alert: false });
}

async function handleAdminCleanCallback(query, env) {
  const groupId = Number(env.SUPERGROUP_ID);
  if (Number(query.message?.chat?.id) !== groupId) return;
  const isAdmin = await isGroupAdmin(env, groupId, query.from?.id);
  if (!isAdmin) return;

  const uid = Number((query.data || "").split("|")[1]);
  const stats = uid ? await cleanupUserScopedData(uid, env) : null;
  await shawTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: stats ? `已清理 ${uid}（${stats.deleted}）` : "无效 UID", show_alert: false });
}

async function sendAdminHelp(env, threadId = null) {
  const payload = {
    chat_id: Number(env.SUPERGROUP_ID),
    text: [
      "🛠️ 管理员命令帮助", "",
      "/help - 查看本帮助",
      "/cl 或 /cool - 查看冷却用户列表",
      "/uf <uid> - 解封指定 UID",
      "/trust <uid> - 手动信任用户",
      "/untrust <uid> - 取消手动信任",
      "/clean <uid> - 清理用户状态数据"
    ].join("\n"),
  };
  if (threadId) payload.message_thread_id = threadId;
  await shawTelegramCall(env, "sendMessage", payload);
}

async function sendCooldownList(msg, env) {
  const now = Date.now();
  const users = await listCoolingUsers(env, now);
  if (users.length === 0) {
    await shawTelegramCall(env, "sendMessage", { chat_id: Number(env.SUPERGROUP_ID), text: "当前没有处于冷却中的用户。" });
    return;
  }
  const top = users.slice(0, 20);
  await shawTelegramCall(env, "sendMessage", {
    chat_id: Number(env.SUPERGROUP_ID),
    text: `⏳ 冷却列表（共 ${users.length} 人）：\n` + top.map((u, i) => `${i + 1}. UID ${u.uid}（剩余 ${u.leftMin} 分钟）`).join("\n"),
    reply_markup: {
      inline_keyboard: top.map((u) => [{ text: `解封 ${u.uid}`, callback_data: `admin_unfreeze|${u.uid}` }]),
    },
  });
}

async function listCoolingUsers(env, now) {
  const result = []; let cursor = undefined;
  do {
    const page = await env.PM.list({ prefix: "shaw:user:", cursor });
    for (const { name } of page.keys) {
      if (!name.endsWith(":profile")) continue;
      const uid = Number(name.split(":")[2]); if (!uid) continue;
      const profile = await env.PM.get(name, { type: "json" });
      if (profile?.cooldownUntil && profile.cooldownUntil > now) {
        result.push({ uid, leftMin: Math.ceil((profile.cooldownUntil - now) / 60000) });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return result.sort((a, b) => b.leftMin - a.leftMin);
}

async function isGroupAdmin(env, groupId, userId) {
  if (!userId) return false;
  const res = await shawTelegramCall(env, "getChatMember", { chat_id: groupId, user_id: userId });
  return ["creator", "administrator"].includes(res?.result?.status);
}

async function unfreezeUser(userId, env) {
  const profile = await getUserProfile(userId, env);
  if (!profile.cooldownUntil || profile.cooldownUntil <= Date.now()) return false;
  profile.cooldownUntil = 0;
  await setUserProfile(userId, profile, env);
  return true;
}

async function applyAutoCooldownIfAllowed(userId, cooldownUntil, env) {
  const profile = await getUserProfile(userId, env);
  if (profile.trusted === true) return false;
  profile.cooldownUntil = cooldownUntil;
  await setUserProfile(userId, profile, env);
  return true;
}

async function setUserTrust(userId, trusted, operatorId, env) {
  const profile = await getUserProfile(userId, env);
  if (!profile?.verified) return false;
  profile.trusted = trusted;
  profile.trustedAt = trusted ? Date.now() : 0;
  profile.trustedBy = trusted ? Number(operatorId || 0) : 0;
  if (trusted) profile.cooldownUntil = 0;
  await setUserProfile(userId, profile, env);
  return true;
}

async function cleanupUserScopedData(userId, env) {
  let deleted = 0;
  for (const key of [SHAW_KV.userProfile(userId), SHAW_KV.verifySession(userId), SHAW_KV.spamState(userId)]) {
    await env.PM.delete(key); deleted += 1;
  }
  return { deleted, hasMore: false };
}

// --- Topic 内消息转发给私聊用户 ---

async function handleSupergroupThreadMessage(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const userId = Number(await env.PM.get(SHAW_KV.userByThread(threadId)) || 0);
  if (!userId) return;

  const text = (msg.text || "").trim();
  if (text === "/close") {
    await setTopicClosedByThread(threadId, true, env);
    await shawTelegramCall(env, "closeForumTopic", { chat_id: Number(env.SUPERGROUP_ID), message_thread_id: threadId });
    return;
  }
  if (text === "/open") {
    await setTopicClosedByThread(threadId, false, env);
    await shawTelegramCall(env, "reopenForumTopic", { chat_id: Number(env.SUPERGROUP_ID), message_thread_id: threadId });
    return;
  }
  if (text === "/uf") {
    const ok = await unfreezeUser(userId, env);
    await shawTelegramCall(env, "sendMessage", { chat_id: Number(env.SUPERGROUP_ID), message_thread_id: threadId, text: ok ? `✅ 已解封 UID ${userId}` : `⚠️ UID ${userId} 当前无冷却` });
    return;
  }

  if (msg.media_group_id) {
    await collectAndFlushMediaGroup(msg, env, ctx, { direction: "t2p", targetChatId: userId, threadId: null });
    return;
  }

  await shawTelegramCall(env, "copyMessage", { chat_id: userId, from_chat_id: Number(env.SUPERGROUP_ID), message_id: msg.message_id });
}

async function getUserTopicIfExists(userId, env) {
  return await env.PM.get(SHAW_KV.topicByUser(userId), { type: "json" });
}

async function resetUserVerification(userId, env) {
  const profile = await getUserProfile(userId, env);
  profile.verified = false; profile.verifiedAt = 0; profile.cooldownUntil = 0;
  await setUserProfile(userId, profile, env);
  await env.PM.delete(SHAW_KV.verifySession(userId));
}

async function setTopicClosedByThread(threadId, closed, env) {
  const userId = Number(await env.PM.get(SHAW_KV.userByThread(threadId)) || 0);
  if (!userId) return;
  const key = SHAW_KV.topicByUser(userId);
  const topic = await env.PM.get(key, { type: "json" });
  if (!topic) return;
  topic.closed = closed;
  await env.PM.put(key, JSON.stringify(topic));
}

async function withUserTopicCreateLock(userId, env, work) {
  const key = SHAW_KV.topicCreateLock(userId);
  const lockTtlSec = 60, waitMs = 180, maxRounds = 35;
  const owner = createNonce();

  for (let i = 0; i < maxRounds; i += 1) {
    const now = Date.now();
    const lock = await env.PM.get(key, { type: "json" });
    if (!lock || Number(lock.expiresAt || 0) <= now) {
      await env.PM.put(key, JSON.stringify({ owner, expiresAt: now + lockTtlSec * 1000 }), { expirationTtl: lockTtlSec });
      const confirmed = await env.PM.get(key, { type: "json" });
      if (confirmed?.owner === owner) {
        try { return await work(); }
        finally {
          const again = await env.PM.get(key, { type: "json" });
          if (again?.owner === owner) await env.PM.delete(key);
        }
      }
    }
    await sleep(waitMs);
  }
  const fallback = await env.PM.get(SHAW_KV.topicByUser(userId), { type: "json" });
  if (fallback?.threadId) return fallback;
  throw new Error("话题创建繁忙，请稍后重试");
}

function buildTopicTitle(msg) {
  const from = msg.from || {}, chat = msg.chat || {};
  const name = (from.first_name || chat.first_name || "User").trim();
  return `${name} #${from.id || chat.id}`.slice(0, 64);
}

// --- 媒体组 (MediaGroup) 相册逻辑 ---

async function collectAndFlushMediaGroup(msg, env, ctx, { direction, targetChatId, threadId }) {
  const media = extractMedia(msg);
  if (!media) {
    const payload = { chat_id: targetChatId, from_chat_id: msg.chat.id, message_id: msg.message_id };
    if (threadId) payload.message_thread_id = threadId;
    await shawTelegramCall(env, "copyMessage", payload);
    return;
  }

  const key = SHAW_KV.mediaGroup(direction, msg.media_group_id);
  const now = Date.now();
  const record = (await env.PM.get(key, { type: "json" })) || { targetChatId, threadId, items: [], lastAt: now };

  record.items.push(media); record.lastAt = now;
  await env.PM.put(key, JSON.stringify(record), { expirationTtl: 60 });
  ctx.waitUntil(flushMediaGroupAfterDelay(env, key, now));
}

function extractMedia(msg) {
  if (msg.photo?.length) return { type: "photo", media: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption || "" };
  if (msg.video?.file_id) return { type: "video", media: msg.video.file_id, caption: msg.caption || "" };
  if (msg.document?.file_id) return { type: "document", media: msg.document.file_id, caption: msg.caption || "" };
  return null;
}

async function flushMediaGroupAfterDelay(env, key, expectedTs) {
  await sleep(SHAW_SETTINGS.mediaGroupFlushDelayMs);
  const record = await env.PM.get(key, { type: "json" });
  if (!record || record.lastAt !== expectedTs) return;

  const payload = {
    chat_id: record.targetChatId,
    media: record.items.map((it, index) => ({ type: it.type, media: it.media, caption: index === 0 ? it.caption : "" })),
  };
  if (record.threadId) payload.message_thread_id = record.threadId;

  if (payload.media.length > 0) await shawTelegramCall(env, "sendMediaGroup", payload);
  await env.PM.delete(key);
}

// --- 通用工具函数 ---

async function shawTelegramCall(env, method, body) {
  const base = env.API_BASE || "https://api.telegram.org";
  const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try { return await resp.json(); } catch { return { ok: false, description: `Non-JSON response: ${resp.status}` }; }
}

function normalizeText(text) {
  return String(text || "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function compactForKeywordMatch(normalizedText) {
  return String(normalizedText || "").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function simpleHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return String(hash);
}

function createNonce() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

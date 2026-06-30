import {
  db, getSettings, saveSettings, getState, saveState, mergeSeed,
  blankCard, DEFAULT_SETTINGS,
} from "./db.js";
import {
  todayStr, applyAnswer, isTypingCard, ensureDailyIntroduction, getDay,
} from "./srs.js";

// Build version shown in Settings. Bump together with CACHE in sw.js.
const APP_VERSION = "v11";

// ── DOM helpers ──
const view = document.getElementById("view");
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return n;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function toast(msg) {
  const node = el("div", { class: "toast", text: msg });
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 1800);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function fmtTime(ms) {
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function normalizeKo(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[.,!?·~]/g, "");
}
// Accepted typed answers for a word — leniently accepts both the dictionary form
// and the bare stem/noun (도입하다 ↔ 도입, 모순되다 ↔ 모순, 수사 ↔ 수사하다).
function acceptedAnswers(card) {
  const set = new Set();
  const add = (s) => { const n = normalizeKo(s); if (n) set.add(n); };
  add(card.ko);
  (card.alt || []).forEach(add);
  if (card.ko.endsWith("하다") || card.ko.endsWith("되다")) {
    add(card.ko.slice(0, -2));            // 도입하다 → 도입
  } else if (!card.ko.endsWith("다")) {
    add(card.ko + "하다");                // 수사 → 수사하다
    add(card.ko + "되다");                // 도입 → 도입되다
  }
  return set;
}

// ── i18n ──
// UI chrome is bilingual; the vocabulary itself (words, meanings, examples) is never
// translated. t(en, ko) returns the active language's string; persisted as settings.lang.
let LANG = "en";
function t(en, ko) { return LANG === "ko" ? ko : en; }
function navLabels() {
  return { home: t("Study", "학습"), stats: t("Stats", "통계"),
           words: t("Words", "단어"), settings: t("Settings", "설정") };
}

// ── Routing ──
const routes = {};
let currentRoute = "home";
const menu = document.getElementById("menu");
const menuBtn = document.getElementById("menu-btn");
const menuScrim = document.getElementById("menu-scrim");
const topbarTitle = document.getElementById("topbar-title");
const langBtn = document.getElementById("lang-btn");

function setMenuOpen(open) {
  menu.hidden = !open;
  menuScrim.hidden = !open;
  menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
}
menuBtn.addEventListener("click", () => setMenuOpen(menu.hidden));
menuScrim.addEventListener("click", () => setMenuOpen(false));

// Refresh the persistent chrome (menu labels, current title, language button).
function applyChrome() {
  const labels = navLabels();
  document.querySelectorAll(".menu-item").forEach((b) => {
    const span = b.querySelector("span");
    if (span) span.textContent = labels[b.dataset.route] || "";
  });
  topbarTitle.textContent = labels[currentRoute] || "";
  const ls = langBtn.querySelector("span");
  if (ls) ls.textContent = LANG === "ko" ? "한국어" : "EN";
}

async function setLang(lang) {
  LANG = lang === "ko" ? "ko" : "en";
  document.documentElement.lang = LANG;
  const s = await getSettings();
  s.lang = LANG;
  await saveSettings(s);
  applyChrome();                    // relabel the menu + language button
  go(currentRoute);                 // clear + re-render the current view in the new language
}
langBtn.addEventListener("click", () => setLang(LANG === "ko" ? "en" : "ko"));

function go(route) {
  currentRoute = route;
  document.querySelectorAll(".menu-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.route === route));
  topbarTitle.textContent = navLabels()[route] || "";
  setMenuOpen(false);
  clear(view);
  view.scrollTop = 0;
  routes[route]();
}
document.querySelectorAll(".menu-item").forEach((b) =>
  b.addEventListener("click", () => go(b.dataset.route)));

// ═══════════════════════ HOME ═══════════════════════
routes.home = async function () {
  await ensureDailyIntroduction();
  const cards = await db.getAll("cards");
  const settings = await getSettings();
  const active = cards.filter((c) => c.introduced && !c.suspended);
  const typingStage = active.filter((c) => isTypingCard(c, settings));
  const streak = await computeStreak();
  const day = await getDay(todayStr());
  const goalMet = !!day.passed;

  const wrap = el("div", { class: "stack" });
  wrap.appendChild(el("div", { class: "brand" }, [
    el("div", { class: "brand-name", text: "되새김 · Korean SRS" }),
    el("div", { class: "brand-tag", text: t("되새김 — \"rumination\": to chew over and recall again.", "되새김 — 곱씹어 다시 떠올리는 일.") }),
    el("div", { class: "brand-intent", html: t(
      "A personal, offline-first trainer for drilling intermediate–advanced Korean " +
      "vocabulary with spaced repetition. No accounts, no server — everything stays on your phone.",
      "중·고급 한국어 어휘를 간격 반복으로 익히는 개인용 오프라인 트레이너입니다. " +
      "계정도 서버도 없이 모든 데이터는 휴대폰에만 저장됩니다.") }),
  ]));
  wrap.appendChild(el("div", { class: "hero" }, [
    el("div", { class: "due-num", text: String(active.length) }),
    el("div", { class: "due-label", text: t("words in today's drill", "오늘 학습할 단어") }),
  ]));
  wrap.appendChild(el("div", { class: "stat-pills" }, [
    el("div", { class: "pill", html: t(`🔥 <b>${streak}</b> day streak`, `🔥 <b>${streak}</b>일 연속`) }),
    el("div", { class: "pill", html: t(`🎯 best today <b>${day.bestRate || 0}%</b>`, `🎯 오늘 최고 <b>${day.bestRate || 0}%</b>`) }),
    el("div", { class: "pill", html: goalMet ? t(`✅ <b>goal met</b>`, `✅ <b>목표 달성</b>`) : t(`🆕 <b>${day.newIntroduced}</b> new`, `🆕 새 단어 <b>${day.newIntroduced}</b>`) }),
  ]));

  wrap.appendChild(el("button", {
    class: "btn", text: goalMet ? t("Drill again (goal already met ✅)", "다시 학습 (목표 달성 ✅)") : t("Start daily drill", "오늘 학습 시작"),
    onclick: () => startSession(),
  }));
  wrap.appendChild(el("p", { class: "muted", style: "text-align:center;font-size:13px;margin:2px 0 0",
    text: t(
      `Keep going until your last ${clampGoal(settings.passGoal)}% run is clean — recent answers count, early misses age out (missed words come back more).`,
      `최근 ${clampGoal(settings.passGoal)}% 구간이 깨끗해질 때까지 계속하세요 — 최근 답만 반영되고 초반 실수는 점차 사라집니다 (틀린 단어는 더 자주 나옵니다).`) }));

  wrap.appendChild(el("h2", { text: t("Today", "오늘") }));
  wrap.appendChild(el("div", { class: "grid3" }, [
    tile((day.bestRate || 0) + "%", t("best pass", "최고 정답률")),
    tile(day.reviewed, t("answers", "답변 수")),
    tile(fmtTime(day.timeMs), t("time", "시간")),
  ]));

  wrap.appendChild(el("h2", { text: t("Library", "라이브러리") }));
  wrap.appendChild(el("div", { class: "grid3" }, [
    tile(active.length, t("active", "활성")),
    tile(typingStage.length, t("typing stage", "타이핑 단계")),
    tile(cards.filter((c) => !c.introduced && !c.suspended).length, t("upcoming", "예정")),
  ]));

  view.appendChild(wrap);
};
function tile(big, lbl) {
  return el("div", { class: "tile" }, [
    el("div", { class: "big", text: String(big) }),
    el("div", { class: "lbl", text: lbl }),
  ]);
}

// ═══════════════════════ SESSION / QUIZ ═══════════════════════
// One drill format ("continuous"): one pass through the list, then weighted draws
// (missed words shown more); ends when the pass rate over the last `recentWindow`
// answers (one deck's worth) reaches the goal, so early misses age out instead of
// anchoring a cumulative rate forever.
// Pass counts as wrong. Goal is adjustable in Settings (`passGoal`), clamped to
// a sane range so it stays achievable yet meaningful.
const GOAL_MIN = 50, GOAL_MAX = 100, GOAL_DEFAULT = 95;
function clampGoal(g) {
  g = parseInt(g, 10);
  if (!Number.isFinite(g)) g = GOAL_DEFAULT;
  return Math.min(GOAL_MAX, Math.max(GOAL_MIN, g));
}

async function startSession() {
  await ensureDailyIntroduction();
  const allCards = await db.getAll("cards");
  const list = allCards.filter((c) => c.introduced && !c.suspended);
  if (list.length === 0) { toast(t("No words yet — add some in Words tab", "아직 단어가 없어요 — 단어 탭에서 추가하세요")); return; }
  const settings = await getSettings();

  // Freeze each word's mode (MC vs typing) for the whole session.
  const modeById = {};
  list.forEach((c) => { modeById[c.id] = isTypingCard(c, settings); });

  const session = {
    format: "continuous", // only mode; Rounds was removed
    list, modeById, allCards, settings,
    goal: clampGoal(settings.passGoal), // % that ends the drill (from Settings)
    totalAnswers: 0, totalCorrect: 0, totalWrong: 0, bestRate: 0,
    // continuous mode
    introQueue: [], weights: {}, lastId: null, currentCard: null,
    // when set, the next question is a typing-reinforcement drill for this card
    // (pure practice — see afterReinforce); set after an MC answer.
    reinforce: null,
    // rolling window of recent results (true=correct); ends when the last
    // `recentWindow` answers reach the goal. Window = one deck's worth, so
    // early misses age out instead of anchoring a cumulative rate forever.
    recent: [], recentWindow: Math.max(20, list.length),
    startedAt: Date.now(), lastTick: Date.now(),
  };

  session.introQueue = shuffle(session.list);
  renderQuestion(session);
}

async function recordTime(session) {
  const now = Date.now();
  const delta = Math.min(now - session.lastTick, 60000); // cap idle gaps at 60s
  session.lastTick = now;
  const day = await getDay(todayStr());
  day.timeMs += delta;
  await db.put("days", day);
}

function recentRight(session) {
  return session.recent.reduce((n, ok) => n + (ok ? 1 : 0), 0);
}
function recentRate(session) {
  return session.recent.length
    ? Math.round((recentRight(session) / session.recent.length) * 100) : 0;
}
function overallRate(session) {
  return session.totalAnswers ? Math.round((session.totalCorrect / session.totalAnswers) * 100) : 0;
}

// Continuous picker: first exhaust the intro pass (every word once), then draw
// weighted toward missed words, never the same word twice in a row.
function pickContinuous(session) {
  if (session.introQueue.length) return session.introQueue.shift();
  const choices = session.list.length === 1
    ? session.list
    : session.list.filter((c) => c.id !== session.lastId);
  let total = 0;
  const cum = [];
  for (const c of choices) {
    total += 1 + 2 * (session.weights[c.id] || 0); // missed words weigh more
    cum.push([c, total]);
  }
  const r = Math.random() * total;
  for (const [c, upTo] of cum) { if (r < upTo) return c; }
  return choices[choices.length - 1];
}

function renderQuestion(session) {
  clear(view);
  // A pending reinforcement drill jumps the queue: same word, forced typing.
  let reinforce = false, card;
  if (session.reinforce) {
    card = session.reinforce;
    session.reinforce = null;
    reinforce = true;
  } else {
    card = pickContinuous(session);
  }
  session.currentCard = card;
  const typing = reinforce || session.modeById[card.id];

  // ✓/✗ are the running session tally (always climb); the rate is the rolling
  // window that actually ends the drill, shown separately so they don't look at odds.
  const n = session.recent.length, win = session.recentWindow;
  const windowLabel = n >= win ? `${t("last", "최근")} ${win}` : `${t("last", "최근")} ${n}/${win}`;
  const scoreHtml =
    `<b class="ok-num">✓ ${session.totalCorrect}</b>&nbsp;&nbsp;` +
    `<b class="no-num">✗ ${session.totalWrong}</b>&nbsp;&nbsp;·&nbsp;&nbsp;` +
    `<span class="muted">${windowLabel}:</span>&nbsp;<b>${recentRate(session)}%</b>&nbsp;<span class="muted">→ ${session.goal}%</span>`;

  const quiz = el("div", { class: "quiz" });
  quiz.appendChild(el("div", { class: "quiz-top" }, [
    el("span", { class: "scoreline", html: scoreHtml }),
    el("span", { class: "muted", onclick: () => endSession(session), text: t("End ✕", "종료 ✕"), style: "cursor:pointer" }),
  ]));

  if (typing) renderTyping(quiz, session, card, reinforce);
  else renderMultipleChoice(quiz, session, card);

  view.appendChild(quiz);
}

// What Korean to show as the MC prompt: drop the 하다/되다 ending so the
// grammatical form doesn't telegraph the "to …" verb option (과감하다 → 과감).
// Other endings (e.g. 드물다) are shown whole.
function promptKo(ko) {
  return (ko.endsWith("하다") || ko.endsWith("되다")) ? ko.slice(0, -2) : ko;
}

function renderMultipleChoice(quiz, session, card) {
  quiz.appendChild(el("div", { class: "prompt-card" }, [
    el("div", { class: "mode-tag", text: t("Recognize · pick the meaning", "인식 · 뜻 고르기") }),
    el("div", { class: "word", text: promptKo(card.ko) }),
  ]));

  const distractPool = shuffle(
    session.allCards.filter((c) => c.id !== card.id && c.en !== card.en)
  ).slice(0, 3);
  const options = shuffle([card, ...distractPool]);

  const choicesBox = el("div", { class: "choices" });
  const feedback = el("div", { class: "feedback" });
  const buttons = [];

  function reveal(correct) {
    buttons.forEach((bb) => { bb.disabled = true; });
    const correctBtn = buttons.find((x) => x._cardId === card.id);
    if (correctBtn) correctBtn.classList.add("correct");
    feedback.className = "feedback " + (correct ? "ok" : "no");
    feedback.textContent = correct ? t("Correct! ✓", "정답! ✓") : `${t("Answer", "정답")}: ${card.ko} — ${card.en}`;
    afterAnswer(session, card, correct, false, quiz, null);
  }

  options.forEach((opt) => {
    const b = el("button", {
      class: "choice", text: opt.en,
      onclick: () => {
        const correct = opt.id === card.id;
        if (!correct) b.classList.add("wrong");
        reveal(correct);
      },
    });
    b._cardId = opt.id;
    buttons.push(b);
    choicesBox.appendChild(b);
  });
  quiz.appendChild(choicesBox);

  // Pass = honest "I don't know" (counts as wrong).
  const actions = el("div", { class: "mc-actions" }, [
    el("button", { class: "btn ghost sm", text: t("Pass · I don't know", "모름 · 패스"), onclick: () => reveal(false) }),
  ]);
  quiz.appendChild(actions);
  quiz.appendChild(feedback);
}

function renderTyping(quiz, session, card, reinforce) {
  quiz.appendChild(el("div", { class: "prompt-card" }, [
    el("div", { class: "mode-tag", text: reinforce
      ? t("Reinforce · type the Korean", "복습 · 한국어 입력")
      : t("Produce · type the Korean", "생성 · 한국어 입력") }),
    el("div", { class: "word", text: card.en }),
    card.topic ? el("div", { class: "sub", text: "(" + card.topic + ")" }) : null,
  ]));

  const input = el("input", { type: "text", autocomplete: "off", autocapitalize: "off",
    autocorrect: "off", spellcheck: "false", placeholder: t("Type in Korean…", "한국어 입력…"), lang: "ko" });
  const feedback = el("div", { class: "feedback" });
  const reveal = el("div");
  let checked = false;

  function check(forceWrong) {
    if (checked) return;
    checked = true;
    const correct = !forceWrong && acceptedAnswers(card).has(normalizeKo(input.value));
    input.disabled = true;
    feedback.className = "feedback " + (correct ? "ok" : "no");
    feedback.textContent = correct ? t("Correct! ✓", "정답! ✓") : t("Try again", "다시 보자");
    clear(reveal);
    reveal.appendChild(el("div", { class: "answer-reveal" }, [
      el("div", { class: "ko", text: card.ko }),
      el("div", { class: "muted", text: card.en }),
      card.ex ? el("div", { class: "example", html: `${card.ex}<br>${card.exEn || ""}` }) : null,
    ]));
    submit.remove(); // drop the Check button; afterAnswer adds "Next →"
    if (reinforce) afterReinforce(session, quiz);
    else afterAnswer(session, card, correct, true, quiz, reveal);
  }
  const submit = el("button", { class: "btn", text: t("Check", "확인") });
  submit.addEventListener("click", () => check(false));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") check(false); });

  quiz.appendChild(input);
  quiz.appendChild(el("div", { class: "mc-actions" }, [
    el("button", { class: "btn ghost sm", text: t("Pass · I don't know", "모름 · 패스"), onclick: () => check(true) }),
  ]));
  quiz.appendChild(reveal);
  quiz.appendChild(feedback);
  quiz.appendChild(submit);
  setTimeout(() => input.focus(), 50);
}

async function afterAnswer(session, card, correct, typed, quiz, revealNode) {
  const firstSeen = card.seen === 0; // capture before applyAnswer bumps it
  session.totalAnswers += 1;
  if (correct) session.totalCorrect += 1; else session.totalWrong += 1;
  applyAnswer(card, correct, typed);
  await db.put("cards", card);
  const day = await getDay(todayStr());
  day.reviewed += 1;
  if (correct) day.correct += 1; else day.wrong += 1;

  let goalReached = false;
  // weight missed words up, correct ones decay back toward baseline
  const miss = session.weights[card.id] || 0;
  session.weights[card.id] = correct ? Math.max(0, miss - 1) : Math.min(4, miss + 1);
  session.lastId = card.id;
  // rolling window: push this result, drop the oldest beyond the window
  session.recent.push(correct);
  if (session.recent.length > session.recentWindow) session.recent.shift();
  // only judge once the window is full (a deck's worth of recent answers)
  if (session.recent.length >= session.recentWindow) {
    const r = recentRate(session);
    session.bestRate = Math.max(session.bestRate, r);
    day.bestRate = Math.max(day.bestRate || 0, r);
    if (r >= session.goal) { day.passed = true; goalReached = true; }
  }
  await db.put("days", day);
  await recordTime(session);

  // After an MC question, drill the same word by typing it — the first time the
  // word is ever seen, or whenever the MC was missed. Pure practice: the typing
  // result doesn't touch SRS/score (see afterReinforce). Skip once the goal is hit.
  if (!typed && (firstSeen || !correct) && !goalReached) session.reinforce = card;

  const actions = quiz.querySelector(".mc-actions");
  if (actions) actions.remove();

  // For multiple choice, show the example sentence (typing already revealed it).
  if (!revealNode && card.ex) {
    quiz.insertBefore(
      el("div", { class: "answer-reveal" }, [
        el("div", { class: "example", html: `${card.ex}<br>${card.exEn || ""}` }),
      ]),
      quiz.querySelector(".feedback")
    );
  }

  const label = goalReached ? t("Finish 🏆", "완료 🏆") : t("Next →", "다음 →");
  const onNext = goalReached
    ? () => renderGoalReached(session, recentRate(session))
    : () => renderQuestion(session);
  const next = el("button", { class: "btn", text: label });
  next.addEventListener("click", onNext);
  quiz.appendChild(next);
  setTimeout(() => next.focus(), 30);
}

// Reinforcement drill: pure practice. The reveal/example is already shown by
// renderTyping's check(); we only log study time and advance — no SRS, no score,
// no rolling-window, so a wrong answer here just moves on.
async function afterReinforce(session, quiz) {
  await recordTime(session);
  const actions = quiz.querySelector(".mc-actions");
  if (actions) actions.remove();
  const next = el("button", { class: "btn", text: t("Next →", "다음 →") });
  next.addEventListener("click", () => renderQuestion(session));
  quiz.appendChild(next);
  setTimeout(() => next.focus(), 30);
}

async function endSession(session) {
  await recordTime(session);
  renderStopped(session);
}

function resume(session) {
  renderQuestion(session);
}

function renderGoalReached(session, rate) {
  clear(view);
  const wrap = el("div", { class: "stack" });
  wrap.appendChild(el("div", { class: "done-emoji", text: "🏆" }));
  wrap.appendChild(el("h1", { text: t(`${session.goal}% goal reached!`, `${session.goal}% 목표 달성!`), style: "text-align:center" }));
  wrap.appendChild(el("div", { class: "grid3" }, [
    tile(rate + "%", t(`last ${session.recentWindow}`, `최근 ${session.recentWindow}`)),
    tile("✓ " + session.totalCorrect, t("correct", "정답")),
    tile("✗ " + session.totalWrong, t("wrong", "오답")),
  ]));
  wrap.appendChild(el("p", { class: "muted", style: "text-align:center", text: t("Nice work — see you tomorrow for +5 new words.", "잘했어요 — 내일 새 단어 +5개로 만나요.") }));
  wrap.appendChild(el("button", { class: "btn", text: t("Back to home", "홈으로"), onclick: () => go("home") }));
  wrap.appendChild(el("button", { class: "btn secondary", text: t("Drill again anyway", "그래도 다시 학습"), onclick: () => resume(session) }));
  view.appendChild(wrap);
}

function renderStopped(session) {
  clear(view);
  const rate = overallRate(session);
  const wrap = el("div", { class: "stack" });
  wrap.appendChild(el("div", { class: "done-emoji", text: "💪" }));
  wrap.appendChild(el("h1", { text: t("Stopped", "중단됨"), style: "text-align:center" }));
  wrap.appendChild(el("div", { class: "grid3" }, [
    tile(rate + "%", t("overall", "전체")),
    tile("✓ " + session.totalCorrect, t("correct", "정답")),
    tile("✗ " + session.totalWrong, t("wrong", "오답")),
  ]));
  wrap.appendChild(el("p", { class: "muted", style: "text-align:center",
    text: t(`You didn't hit ${session.goal}% yet — pick it back up anytime today.`, `아직 ${session.goal}%에 도달하지 못했어요 — 오늘 중 언제든 이어서 하세요.`) }));
  wrap.appendChild(el("button", { class: "btn", text: t("Back to home", "홈으로"), onclick: () => go("home") }));
  wrap.appendChild(el("button", { class: "btn secondary", text: t("Resume drilling", "이어서 학습"), onclick: () => resume(session) }));
  view.appendChild(wrap);
}

// ═══════════════════════ STATS ═══════════════════════
async function computeStreak() {
  const days = await db.getAll("days");
  const active = new Set(days.filter((d) => d.reviewed > 0).map((d) => d.date));
  let streak = 0;
  const d = new Date();
  // if not studied today yet, streak can still count up to yesterday
  if (!active.has(todayStr(d))) d.setDate(d.getDate() - 1);
  while (active.has(todayStr(d))) { streak += 1; d.setDate(d.getDate() - 1); }
  return streak;
}

routes.stats = async function () {
  const cards = await db.getAll("cards");
  const days = await db.getAll("days");
  const streak = await computeStreak();

  const totalCorrect = cards.reduce((s, c) => s + c.correct, 0);
  const totalWrong = cards.reduce((s, c) => s + c.wrong, 0);
  const retention = totalCorrect + totalWrong
    ? Math.round((totalCorrect / (totalCorrect + totalWrong)) * 100) : 0;

  const byStatus = { new: 0, learning: 0, review: 0, suspended: 0, upcoming: 0 };
  for (const c of cards) {
    if (c.suspended) byStatus.suspended++;
    else if (!c.introduced) byStatus.upcoming++;
    else byStatus[c.status]++;
  }
  const mastered = cards.filter((c) => !c.suspended && c.intervalDays >= 21).length;

  const wrap = el("div", {});
  wrap.appendChild(el("h1", { text: t("Statistics", "통계") }));
  wrap.appendChild(el("div", { class: "grid2" }, [
    tile("🔥 " + streak, t("day streak", "일 연속")),
    tile(retention + "%", t("overall retention", "전체 정답률")),
  ]));
  wrap.appendChild(el("div", { class: "grid2", style: "margin-top:12px" }, [
    tile(byStatus.review, t("in review", "복습 중")),
    tile(mastered, t("mastered (21d+)", "숙달 (21일+)")),
  ]));

  wrap.appendChild(el("h2", { text: t("Word breakdown", "단어 분류") }));
  wrap.appendChild(el("div", { class: "card" }, [
    statLine(t("Active – review", "활성 – 복습"), byStatus.review),
    statLine(t("Active – learning", "활성 – 학습"), byStatus.learning),
    statLine(t("Upcoming (not yet introduced)", "예정 (아직 미도입)"), byStatus.upcoming),
    statLine(t("Do-not-show (suspended)", "표시 안 함 (보류)"), byStatus.suspended),
    statLine(t("Total in library", "라이브러리 전체"), cards.length, true),
  ]));

  // last 14 days
  wrap.appendChild(el("h2", { text: t("Last 14 days · reviews", "최근 14일 · 복습 수") }));
  wrap.appendChild(buildBars(days, 14, "reviewed"));

  wrap.appendChild(el("h2", { text: t("Last 14 days · accuracy %", "최근 14일 · 정답률 %") }));
  wrap.appendChild(buildAccuracyBars(days, 14));

  view.appendChild(wrap);
};
function statLine(label, value, strong) {
  return el("div", { class: "wordrow", style: "padding:8px 0" }, [
    el("div", { class: "grow" }, [el("span", { text: label, style: strong ? "font-weight:700" : "" })]),
    el("b", { text: String(value) }),
  ]);
}
function lastNDates(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d); x.setDate(d.getDate() - i);
    out.push(todayStr(x));
  }
  return out;
}
function buildBars(days, n, field) {
  const map = Object.fromEntries(days.map((d) => [d.date, d]));
  const dates = lastNDates(n);
  const vals = dates.map((dt) => (map[dt] ? map[dt][field] : 0));
  const max = Math.max(1, ...vals);
  const bars = el("div", { class: "bars" });
  vals.forEach((v) => {
    bars.appendChild(el("div", { class: "b", title: String(v) }, [
      el("i", { style: `height:${Math.round((v / max) * 100)}%` }),
    ]));
  });
  const xs = el("div", { class: "bars-x" });
  dates.forEach((dt) => xs.appendChild(el("span", { text: dt.slice(5) })));
  return el("div", { class: "card" }, [bars, xs]);
}
function buildAccuracyBars(days, n) {
  const map = Object.fromEntries(days.map((d) => [d.date, d]));
  const dates = lastNDates(n);
  const vals = dates.map((dt) => {
    const d = map[dt];
    if (!d || (d.correct + d.wrong) === 0) return 0;
    return Math.round((d.correct / (d.correct + d.wrong)) * 100);
  });
  const bars = el("div", { class: "bars" });
  vals.forEach((v) => {
    bars.appendChild(el("div", { class: "b", title: v + "%" }, [
      el("i", { style: `height:${v}%` }),
    ]));
  });
  const xs = el("div", { class: "bars-x" });
  dates.forEach((dt) => xs.appendChild(el("span", { text: dt.slice(5) })));
  return el("div", { class: "card" }, [bars, xs]);
}

// ═══════════════════════ WORDS ═══════════════════════
let wordFilter = "";
routes.words = async function () {
  const cards = (await db.getAll("cards")).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const wrap = el("div", {});
  const header = el("div", { class: "row", style: "align-items:center;justify-content:space-between" }, [
    el("h1", { text: t(`Words (${cards.length})`, `단어 (${cards.length})`), style: "margin:0" }),
    el("button", { class: "iconbtn", text: t("＋ Add", "＋ 추가"), onclick: () => openWordForm(null) }),
  ]);
  wrap.appendChild(header);

  const search = el("input", { class: "search", type: "search", placeholder: t("Search Korean or English…", "한국어 또는 영어 검색…"),
    value: wordFilter, oninput: (e) => { wordFilter = e.target.value; renderWordList(list, cards); } });
  wrap.appendChild(el("div", { style: "margin-top:12px" }, [search]));

  const list = el("div", {});
  wrap.appendChild(list);
  renderWordList(list, cards);
  view.appendChild(wrap);
};

function renderWordList(list, cards) {
  clear(list);
  const f = wordFilter.trim().toLowerCase();
  const filtered = cards.filter((c) =>
    !f || c.ko.toLowerCase().includes(f) || c.en.toLowerCase().includes(f) || (c.topic || "").includes(f));
  if (filtered.length === 0) {
    list.appendChild(el("div", { class: "empty", text: t("No matching words.", "일치하는 단어가 없어요.") }));
    return;
  }
  filtered.forEach((c) => {
    const status = c.suspended ? "suspended" : (!c.introduced ? "new" : c.status);
    const acc = c.seen ? Math.round((c.correct / c.seen) * 100) + "%" : "—";
    const tail = c.introduced && !c.suspended ? t("due ", "복습 ") + dueLabel(c.due) : statusLabel(status);
    const meta = t(`${c.topic} · seen ${c.seen} · acc ${acc} · ${tail}`,
                   `${c.topic} · ${c.seen}회 · 정답률 ${acc} · ${tail}`);
    const row = el("div", { class: "wordrow" }, [
      el("div", { class: "grow", onclick: () => openWordForm(c) }, [
        el("div", { class: "ko", text: c.ko }),
        el("div", { class: "en", text: c.en }),
        el("div", { class: "meta", text: meta }),
      ]),
      el("span", { class: "badge " + status, text: statusLabel(status) }),
      el("button", { class: "iconbtn", text: c.suspended ? "👁" : "🚫", title: t("Do Not Show", "표시 안 함"),
        onclick: async () => { c.suspended = !c.suspended; await db.put("cards", c); go("words"); } }),
    ]);
    list.appendChild(row);
  });
}
// Card status → localized label (the raw status string still drives the CSS class).
function statusLabel(status) {
  return {
    new: t("new", "새 단어"), learning: t("learning", "학습"),
    review: t("review", "복습"), suspended: t("suspended", "보류"),
  }[status] || status;
}
function dueLabel(due) {
  const diff = due - Date.now();
  if (diff <= 0) return t("now", "지금");
  const d = Math.round(diff / 86400000);
  if (d < 1) return t("today", "오늘");
  return t(d + "d", d + "일");
}

function openWordForm(card) {
  const editing = !!card;
  const c = card || blankCard({});
  const overlay = el("div", { class: "overlay" });
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const f = (label, key, ph) => {
    const input = el("input", { type: "text", value: c[key] || "", placeholder: ph || "" });
    input._key = key;
    return { node: el("label", { class: "field" }, [el("span", { text: label }), input]), input };
  };
  const ko = f(t("Korean", "한국어"), "ko", "한국어");
  const en = f(t("English meaning", "영어 뜻"), "en", t("meaning", "뜻"));
  const topicSel = el("select", {}, ["society","business","emotion","medical","finance","economy","government","general","verb","adjective","idiom","law","tech","politics","education"]
    .map((topic) => el("option", { value: topic, ...(topic === c.topic ? { selected: "selected" } : {}) }, topic)));
  const ex = f(t("Example (Korean, optional)", "예문 (한국어, 선택)"), "ex");
  const exEn = f(t("Example translation (optional)", "예문 번역 (선택)"), "exEn");

  const modal = el("div", { class: "modal stack" }, [
    el("h1", { text: editing ? t("Edit word", "단어 편집") : t("Add word", "단어 추가") }),
    ko.node, en.node,
    el("label", { class: "field" }, [el("span", { text: t("Topic", "주제") }), topicSel]),
    ex.node, exEn.node,
    el("button", { class: "btn", text: t("Save", "저장"), onclick: async () => {
      c.ko = ko.input.value.trim();
      c.en = en.input.value.trim();
      c.topic = topicSel.value;
      c.ex = ex.input.value.trim();
      c.exEn = exEn.input.value.trim();
      if (!c.ko || !c.en) { toast(t("Korean and English are required", "한국어와 영어는 필수입니다")); return; }
      await db.put("cards", c);
      close(); go("words"); toast(editing ? t("Saved", "저장됨") : t("Added", "추가됨"));
    } }),
    editing ? el("button", { class: "btn danger", text: t("Delete word", "단어 삭제"), onclick: async () => {
      if (confirm(t("Delete this word and its stats?", "이 단어와 통계를 삭제할까요?"))) { await db.del("cards", c.id); close(); go("words"); }
    } }) : null,
    el("button", { class: "btn ghost", text: t("Cancel", "취소"), onclick: close }),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ═══════════════════════ SETTINGS ═══════════════════════
routes.settings = async function () {
  const s = await getSettings();
  const wrap = el("div", { class: "stack" });
  wrap.appendChild(el("h1", { text: t("Settings", "설정") }));

  wrap.appendChild(el("h2", { text: t("Overview", "개요") }));
  wrap.appendChild(el("div", { class: "card stack" }, [
    el("p", { class: "muted", html: t(
      "<b>되새김 · Korean SRS</b> is a spaced-repetition trainer for intermediate–advanced " +
      "Korean vocabulary. It introduces a handful of new words each day, then drills them " +
      "until your recent pass rate hits your goal — missed words come back more often, and a " +
      "rough start ages out instead of sinking the whole session.",
      "<b>되새김 · Korean SRS</b>는 중·고급 한국어 어휘를 위한 간격 반복 학습 도구입니다. " +
      "매일 새 단어를 조금씩 도입하고, 최근 정답률이 목표에 도달할 때까지 반복합니다 — " +
      "틀린 단어는 더 자주 나오고, 초반 실수는 세션 전체를 망치지 않고 점차 사라집니다.") }),
    el("p", { class: "muted", html: t(
      "Each word starts as multiple choice (recognize the meaning) and graduates to typing " +
      "(produce the Korean) once you know it. Everything runs offline and stays on this " +
      "device — no accounts, no server — so export a backup now and then.",
      "각 단어는 객관식(뜻 인식)으로 시작해 익숙해지면 타이핑(한국어 입력)으로 넘어갑니다. " +
      "모든 것은 오프라인으로 이 기기에만 저장됩니다 — 계정도 서버도 없으니 가끔 백업을 내보내 두세요.") }),
    el("p", { class: "muted", style: "margin-top:4px",
      html: t("Made by and for <b>Hyun Cho (조현진)</b> using Claude Code.",
              "<b>조현진 (Hyun Cho)</b>이(가) Claude Code로 직접 만들고 사용합니다.") }),
  ]));

  const numField = (label, key, hint) => {
    const input = el("input", { type: "number", inputmode: "numeric", min: "0", value: String(s[key]) });
    input._key = key;
    return { node: el("label", { class: "field" }, [
      el("span", { text: label + (hint ? ` — ${hint}` : "") }), input]), input };
  };
  const first = numField(t("First-day word count", "첫날 단어 수"), "firstDayCount");
  const perDay = numField(t("New words per day", "하루 새 단어 수"), "newPerDay");
  const mins = numField(t("Target session minutes", "목표 학습 시간(분)"), "sessionMinutes", t("soft goal", "느슨한 목표"));
  const thr = numField(t("Typing graduation (days)", "타이핑 전환 (일)"), "typingThreshold", t("interval to switch MC→typing", "객관식→타이핑 전환 간격"));

  const goalInput = el("input", { type: "number", inputmode: "numeric",
    min: String(GOAL_MIN), max: String(GOAL_MAX), value: String(clampGoal(s.passGoal)) });
  const goalField = el("label", { class: "field" }, [
    el("span", { text: t(`Pass goal % — ${GOAL_MIN}–${GOAL_MAX}, ends a drill`, `통과 목표 % — ${GOAL_MIN}–${GOAL_MAX}, 학습 종료 기준`) }), goalInput]);

  wrap.appendChild(el("div", { class: "card stack" }, [
    first.node, perDay.node, mins.node, thr.node, goalField,
    el("button", { class: "btn", text: t("Save settings", "설정 저장"), onclick: async () => {
      const out = { ...s, passGoal: clampGoal(goalInput.value) };
      [first, perDay, mins, thr].forEach((f) => { out[f.input._key] = Math.max(0, parseInt(f.input.value || "0", 10)); });
      await saveSettings(out); toast(t("Settings saved", "설정 저장됨"));
    } }),
  ]));

  wrap.appendChild(el("h2", { text: t("Backup", "백업") }));
  wrap.appendChild(el("div", { class: "card stack" }, [
    el("p", { class: "muted", text: t("All data lives on this device. Export a backup file regularly so clearing your browser can't lose your progress.", "모든 데이터는 이 기기에 저장됩니다. 브라우저를 지워도 진행 상황을 잃지 않도록 백업 파일을 정기적으로 내보내세요.") }),
    el("button", { class: "btn secondary", text: t("⬇ Export backup", "⬇ 백업 내보내기"), onclick: exportData }),
    el("button", { class: "btn secondary", text: t("⬆ Import backup", "⬆ 백업 가져오기"), onclick: importData }),
  ]));

  wrap.appendChild(el("h2", { text: t("Danger zone", "위험 구역") }));
  wrap.appendChild(el("div", { class: "card stack" }, [
    el("button", { class: "btn danger", text: t("Reset progress (keep words)", "진행 초기화 (단어 유지)"), onclick: resetProgress }),
    el("button", { class: "btn danger", text: t("Erase everything", "전체 삭제"), onclick: eraseAll }),
  ]));

  wrap.appendChild(el("p", { class: "muted", style: "text-align:center;margin-top:20px",
    text: t("되새김 · Korean SRS — your personal vocabulary trainer", "되새김 · Korean SRS — 나만의 어휘 트레이너") + ` · ${APP_VERSION}` }));
  view.appendChild(wrap);
};

async function exportData() {
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    cards: await db.getAll("cards"),
    days: await db.getAll("days"),
    settings: await getSettings(),
    state: await getState(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `korean-srs-backup-${todayStr()}.json` });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(t("Backup exported", "백업 내보냄"));
}

function importData() {
  const input = el("input", { type: "file", accept: "application/json,.json" });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.cards) throw new Error(t("Invalid file", "잘못된 파일"));
      if (!confirm(t("This replaces all current data with the backup. Continue?", "현재 데이터를 모두 백업으로 교체합니다. 계속할까요?"))) return;
      await db.clear("cards"); await db.clear("days");
      await db.bulkPut("cards", data.cards);
      if (data.days) await db.bulkPut("days", data.days);
      if (data.settings) await saveSettings(data.settings);
      if (data.state) await saveState(data.state);
      const s = await getSettings();
      LANG = s.lang === "ko" ? "ko" : "en";
      document.documentElement.lang = LANG;
      applyChrome();
      toast(t("Backup imported", "백업 가져옴")); go("home");
    } catch (e) { toast(t("Import failed: ", "가져오기 실패: ") + e.message); }
  });
  input.click();
}

async function resetProgress() {
  if (!confirm(t("Reset all study progress and stats? Your word list stays.", "모든 학습 진행과 통계를 초기화할까요? 단어 목록은 유지됩니다."))) return;
  const cards = await db.getAll("cards");
  for (const c of cards) {
    Object.assign(c, { introduced: false, status: "new", ease: 2.5, intervalDays: 0,
      reps: 0, lapses: 0, due: 0, introducedAt: 0, seen: 0, correct: 0, wrong: 0, lastSeen: 0 });
  }
  await db.bulkPut("cards", cards);
  await db.clear("days");
  await saveState({ lastIntroDate: null, firstDayDone: false });
  toast(t("Progress reset", "진행 초기화됨")); go("home");
}

async function eraseAll() {
  if (!confirm(t("Erase EVERYTHING (words, progress, settings)? This cannot be undone.", "전부 삭제할까요 (단어, 진행, 설정)? 되돌릴 수 없습니다."))) return;
  await db.clear("cards"); await db.clear("days"); await db.clear("meta");
  await mergeSeed();
  toast(t("Everything erased & reseeded", "전부 삭제 후 초기 단어 복원됨")); go("home");
}

// ═══════════════════════ BOOT ═══════════════════════
async function boot() {
  const added = await mergeSeed();
  const s = await getSettings();
  LANG = s.lang === "ko" ? "ko" : "en";
  document.documentElement.lang = LANG;
  applyChrome();
  go("home");
  if (added > 0) toast(t(`Added ${added} new words to your library`, `라이브러리에 새 단어 ${added}개 추가됨`));
  if ("serviceWorker" in navigator) {
    // updateViaCache:"none" → always re-fetch sw.js from network on update checks,
    // so a deploy is picked up promptly instead of being masked by the HTTP cache.
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  }
}
boot();

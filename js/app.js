import {
  db, getSettings, saveSettings, getState, saveState, mergeSeed,
  blankCard, DEFAULT_SETTINGS,
} from "./db.js";
import {
  todayStr, applyAnswer, isTypingCard, ensureDailyIntroduction, getDay,
} from "./srs.js";

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
  const t = el("div", { class: "toast", text: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
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

// ── Routing ──
const routes = {};
let currentRoute = "home";
function go(route) {
  currentRoute = route;
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.route === route));
  clear(view);
  view.scrollTop = 0;
  routes[route]();
}
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => go(t.dataset.route)));

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
  wrap.appendChild(el("div", { class: "hero" }, [
    el("div", { class: "due-num", text: String(active.length) }),
    el("div", { class: "due-label", text: "words in today's drill" }),
  ]));
  wrap.appendChild(el("div", { class: "stat-pills" }, [
    el("div", { class: "pill", html: `🔥 <b>${streak}</b> day streak` }),
    el("div", { class: "pill", html: `🎯 best today <b>${day.bestRate || 0}%</b>` }),
    el("div", { class: "pill", html: goalMet ? `✅ <b>goal met</b>` : `🆕 <b>${day.newIntroduced}</b> new` }),
  ]));

  // Format selector (saved as the default).
  const fmt = settings.format === "round" ? "round" : "continuous";
  const seg = el("div", { class: "segmented" });
  [["continuous", "Continuous"], ["round", "Rounds"]].forEach(([val, label]) => {
    seg.appendChild(el("button", {
      class: "seg" + (val === fmt ? " on" : ""), text: label,
      onclick: async () => { settings.format = val; await saveSettings(settings); go("home"); },
    }));
  });
  wrap.appendChild(seg);

  wrap.appendChild(el("button", {
    class: "btn", text: goalMet ? "Drill again (goal already met ✅)" : "Start daily drill",
    onclick: () => startSession(),
  }));
  wrap.appendChild(el("p", { class: "muted", style: "text-align:center;font-size:13px;margin:2px 0 0",
    text: fmt === "continuous"
      ? `Keep going until your overall rate hits ${PASS_GOAL}% (missed words come back more).`
      : `Repeat full passes until one whole pass scores ${PASS_GOAL}%.` }));

  wrap.appendChild(el("h2", { text: "Today" }));
  wrap.appendChild(el("div", { class: "grid3" }, [
    tile((day.bestRate || 0) + "%", "best pass"),
    tile(day.reviewed, "answers"),
    tile(fmtTime(day.timeMs), "time"),
  ]));

  wrap.appendChild(el("h2", { text: "Library" }));
  wrap.appendChild(el("div", { class: "grid3" }, [
    tile(active.length, "active"),
    tile(typingStage.length, "typing stage"),
    tile(cards.filter((c) => !c.introduced && !c.suspended).length, "upcoming"),
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
// Two formats:
//  • "round"      — repeated full passes; ends when one complete pass scores >= goal.
//  • "continuous" — one pass through the list, then weighted draws (missed words
//                   shown more); ends when the cumulative pass rate reaches the goal.
// Pass counts as wrong. Goal default 95%.
const PASS_GOAL = 95;

async function startSession() {
  await ensureDailyIntroduction();
  const allCards = await db.getAll("cards");
  const list = allCards.filter((c) => c.introduced && !c.suspended);
  if (list.length === 0) { toast("No words yet — add some in Words tab"); return; }
  const settings = await getSettings();

  // Freeze each word's mode (MC vs typing) for the whole session.
  const modeById = {};
  list.forEach((c) => { modeById[c.id] = isTypingCard(c, settings); });

  const session = {
    format: settings.format === "round" ? "round" : "continuous",
    list, modeById, allCards, settings,
    totalAnswers: 0, totalCorrect: 0, totalWrong: 0, bestRate: 0,
    // round mode
    roundNum: 0, roundQueue: [], roundCorrect: 0, roundWrong: 0,
    // continuous mode
    introQueue: [], weights: {}, lastId: null, currentCard: null,
    startedAt: Date.now(), lastTick: Date.now(),
  };

  if (session.format === "round") startRound(session);
  else { session.introQueue = shuffle(session.list); renderQuestion(session); }
}

function startRound(session) {
  session.roundNum += 1;
  session.roundQueue = shuffle(session.list);
  session.roundCorrect = 0;
  session.roundWrong = 0;
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

function roundRate(session) {
  const t = session.roundCorrect + session.roundWrong;
  return t ? Math.round((session.roundCorrect / t) * 100) : 0;
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
  let card;
  if (session.format === "round") {
    if (session.roundQueue.length === 0) { roundComplete(session); return; }
    card = session.roundQueue[0];
  } else {
    card = pickContinuous(session);
    session.currentCard = card;
  }
  const typing = session.modeById[card.id];

  let scoreHtml;
  if (session.format === "round") {
    scoreHtml =
      `<b class="ok-num">✓ ${session.roundCorrect}</b>&nbsp;&nbsp;` +
      `<b class="no-num">✗ ${session.roundWrong}</b>&nbsp;&nbsp;·&nbsp;&nbsp;` +
      `<b>${roundRate(session)}%</b>&nbsp;<span class="muted">(round ${session.roundNum})</span>`;
  } else {
    scoreHtml =
      `<b class="ok-num">✓ ${session.totalCorrect}</b>&nbsp;&nbsp;` +
      `<b class="no-num">✗ ${session.totalWrong}</b>&nbsp;&nbsp;·&nbsp;&nbsp;` +
      `<b>${overallRate(session)}%</b>&nbsp;<span class="muted">→ ${PASS_GOAL}%</span>`;
  }

  const quiz = el("div", { class: "quiz" });
  quiz.appendChild(el("div", { class: "quiz-top" }, [
    el("span", { class: "scoreline", html: scoreHtml }),
    el("span", { class: "muted", onclick: () => endSession(session), text: "End ✕", style: "cursor:pointer" }),
  ]));

  if (typing) renderTyping(quiz, session, card);
  else renderMultipleChoice(quiz, session, card);

  view.appendChild(quiz);
}

function renderMultipleChoice(quiz, session, card) {
  quiz.appendChild(el("div", { class: "prompt-card" }, [
    el("div", { class: "mode-tag", text: "Recognize · pick the meaning" }),
    el("div", { class: "word", text: card.ko }),
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
    feedback.textContent = correct ? "정답! ✓" : `Answer: ${card.ko} — ${card.en}`;
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
    el("button", { class: "btn ghost sm", text: "Pass · I don't know", onclick: () => reveal(false) }),
  ]);
  quiz.appendChild(actions);
  quiz.appendChild(feedback);
}

function renderTyping(quiz, session, card) {
  quiz.appendChild(el("div", { class: "prompt-card" }, [
    el("div", { class: "mode-tag", text: "Produce · type the Korean" }),
    el("div", { class: "word", text: card.en }),
    card.topic ? el("div", { class: "sub", text: "(" + card.topic + ")" }) : null,
  ]));

  const input = el("input", { type: "text", autocomplete: "off", autocapitalize: "off",
    autocorrect: "off", spellcheck: "false", placeholder: "한국어 입력…", lang: "ko" });
  const feedback = el("div", { class: "feedback" });
  const reveal = el("div");
  let checked = false;

  function check(forceWrong) {
    if (checked) return;
    checked = true;
    const correct = !forceWrong && acceptedAnswers(card).has(normalizeKo(input.value));
    input.disabled = true;
    feedback.className = "feedback " + (correct ? "ok" : "no");
    feedback.textContent = correct ? "정답! ✓" : "다시 보자";
    clear(reveal);
    reveal.appendChild(el("div", { class: "answer-reveal" }, [
      el("div", { class: "ko", text: card.ko }),
      el("div", { class: "muted", text: card.en }),
      card.ex ? el("div", { class: "example", html: `${card.ex}<br>${card.exEn || ""}` }) : null,
    ]));
    afterAnswer(session, card, correct, true, quiz, reveal);
  }
  const submit = el("button", { class: "btn", text: "Check" });
  submit.addEventListener("click", () => check(false));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") check(false); });

  quiz.appendChild(input);
  quiz.appendChild(el("div", { class: "mc-actions" }, [
    el("button", { class: "btn ghost sm", text: "Pass · I don't know", onclick: () => check(true) }),
  ]));
  quiz.appendChild(reveal);
  quiz.appendChild(feedback);
  quiz.appendChild(submit);
  setTimeout(() => input.focus(), 50);
}

async function afterAnswer(session, card, correct, typed, quiz, revealNode) {
  session.totalAnswers += 1;
  if (correct) session.totalCorrect += 1; else session.totalWrong += 1;
  applyAnswer(card, correct, typed);
  await db.put("cards", card);
  const day = await getDay(todayStr());
  day.reviewed += 1;
  if (correct) day.correct += 1; else day.wrong += 1;

  let goalReached = false;
  if (session.format === "round") {
    if (correct) session.roundCorrect += 1; else session.roundWrong += 1;
    session.roundQueue.shift(); // one pass per round
  } else {
    // weight missed words up, correct ones decay back toward baseline
    const miss = session.weights[card.id] || 0;
    session.weights[card.id] = correct ? Math.max(0, miss - 1) : Math.min(4, miss + 1);
    session.lastId = card.id;
    // only judge the cumulative rate after a full first pass through the list
    if (session.totalAnswers >= session.list.length) {
      const r = overallRate(session);
      session.bestRate = Math.max(session.bestRate, r);
      day.bestRate = Math.max(day.bestRate || 0, r);
      if (r >= PASS_GOAL) { day.passed = true; goalReached = true; }
    }
  }
  await db.put("days", day);
  await recordTime(session);

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

  let label, onNext;
  if (session.format === "round") {
    const last = session.roundQueue.length === 0;
    label = last ? "Finish round" : "Next →";
    onNext = () => renderQuestion(session);
  } else {
    label = goalReached ? "Finish 🏆" : "Next →";
    onNext = goalReached
      ? () => renderGoalReached(session, overallRate(session))
      : () => renderQuestion(session);
  }
  const next = el("button", { class: "btn", text: label });
  next.addEventListener("click", onNext);
  quiz.appendChild(next);
  setTimeout(() => next.focus(), 30);
}

async function endSession(session) {
  await recordTime(session);
  renderStopped(session);
}

// Called when a full pass through the list is complete.
async function roundComplete(session) {
  const rate = roundRate(session);
  session.bestRate = Math.max(session.bestRate, rate);
  const day = await getDay(todayStr());
  day.bestRate = Math.max(day.bestRate || 0, rate);
  if (rate >= PASS_GOAL) day.passed = true;
  await db.put("days", day);
  await recordTime(session);

  if (rate >= PASS_GOAL) { renderGoalReached(session, rate); return; }

  // Show the round result and offer to keep drilling.
  clear(view);
  const wrap = el("div", { class: "stack" });
  wrap.appendChild(el("h1", { text: `Round ${session.roundNum} complete`, style: "text-align:center" }));
  wrap.appendChild(el("div", { class: "grid3" }, [
    tile("✓ " + session.roundCorrect, "correct"),
    tile("✗ " + session.roundWrong, "wrong"),
    tile(rate + "%", "pass rate"),
  ]));
  wrap.appendChild(el("p", { class: "muted", style: "text-align:center",
    text: `Goal is ${PASS_GOAL}%. Keep going for another full pass.` }));
  wrap.appendChild(el("button", { class: "btn", text: "Continue drilling", onclick: () => startRound(session) }));
  wrap.appendChild(el("button", { class: "btn ghost", text: "Stop for now", onclick: () => renderStopped(session) }));
  view.appendChild(wrap);
}

function resume(session) {
  if (session.format === "round") startRound(session);
  else renderQuestion(session);
}

function renderGoalReached(session, rate) {
  clear(view);
  const wrap = el("div", { class: "stack" });
  wrap.appendChild(el("div", { class: "done-emoji", text: "🏆" }));
  wrap.appendChild(el("h1", { text: `${PASS_GOAL}% goal reached!`, style: "text-align:center" }));
  wrap.appendChild(el("div", { class: "grid3" }, [
    tile(rate + "%", session.format === "round" ? "final pass" : "overall"),
    tile("✓ " + session.totalCorrect, "correct"),
    tile("✗ " + session.totalWrong, "wrong"),
  ]));
  wrap.appendChild(el("p", { class: "muted", style: "text-align:center", text: "Nice work — see you tomorrow for +5 new words." }));
  wrap.appendChild(el("button", { class: "btn", text: "Back to home", onclick: () => go("home") }));
  wrap.appendChild(el("button", { class: "btn secondary", text: "Drill again anyway", onclick: () => resume(session) }));
  view.appendChild(wrap);
}

function renderStopped(session) {
  clear(view);
  const rate = session.format === "round" ? session.bestRate : overallRate(session);
  const wrap = el("div", { class: "stack" });
  wrap.appendChild(el("div", { class: "done-emoji", text: "💪" }));
  wrap.appendChild(el("h1", { text: "Stopped", style: "text-align:center" }));
  wrap.appendChild(el("div", { class: "grid3" }, [
    tile(rate + "%", session.format === "round" ? "best pass" : "overall"),
    tile("✓ " + session.totalCorrect, "correct"),
    tile("✗ " + session.totalWrong, "wrong"),
  ]));
  wrap.appendChild(el("p", { class: "muted", style: "text-align:center",
    text: `You didn't hit ${PASS_GOAL}% yet — pick it back up anytime today.` }));
  wrap.appendChild(el("button", { class: "btn", text: "Back to home", onclick: () => go("home") }));
  wrap.appendChild(el("button", { class: "btn secondary", text: "Resume drilling", onclick: () => resume(session) }));
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
  wrap.appendChild(el("h1", { text: "Statistics" }));
  wrap.appendChild(el("div", { class: "grid2" }, [
    tile("🔥 " + streak, "day streak"),
    tile(retention + "%", "overall retention"),
  ]));
  wrap.appendChild(el("div", { class: "grid2", style: "margin-top:12px" }, [
    tile(byStatus.review, "in review"),
    tile(mastered, "mastered (21d+)"),
  ]));

  wrap.appendChild(el("h2", { text: "Word breakdown" }));
  wrap.appendChild(el("div", { class: "card" }, [
    statLine("Active – review", byStatus.review),
    statLine("Active – learning", byStatus.learning),
    statLine("Upcoming (not yet introduced)", byStatus.upcoming),
    statLine("Do-not-show (suspended)", byStatus.suspended),
    statLine("Total in library", cards.length, true),
  ]));

  // last 14 days
  wrap.appendChild(el("h2", { text: "Last 14 days · reviews" }));
  wrap.appendChild(buildBars(days, 14, "reviewed"));

  wrap.appendChild(el("h2", { text: "Last 14 days · accuracy %" }));
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
    el("h1", { text: `Words (${cards.length})`, style: "margin:0" }),
    el("button", { class: "iconbtn", text: "＋ Add", onclick: () => openWordForm(null) }),
  ]);
  wrap.appendChild(header);

  const search = el("input", { class: "search", type: "search", placeholder: "Search Korean or English…",
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
    list.appendChild(el("div", { class: "empty", text: "No matching words." }));
    return;
  }
  filtered.forEach((c) => {
    const status = c.suspended ? "suspended" : (!c.introduced ? "new" : c.status);
    const acc = c.seen ? Math.round((c.correct / c.seen) * 100) + "%" : "—";
    const row = el("div", { class: "wordrow" }, [
      el("div", { class: "grow", onclick: () => openWordForm(c) }, [
        el("div", { class: "ko", text: c.ko }),
        el("div", { class: "en", text: c.en }),
        el("div", { class: "meta", text: `${c.topic} · seen ${c.seen} · acc ${acc} · ${c.introduced && !c.suspended ? "due " + dueLabel(c.due) : status}` }),
      ]),
      el("span", { class: "badge " + status, text: status }),
      el("button", { class: "iconbtn", text: c.suspended ? "👁" : "🚫", title: "Do Not Show",
        onclick: async () => { c.suspended = !c.suspended; await db.put("cards", c); go("words"); } }),
    ]);
    list.appendChild(row);
  });
}
function dueLabel(due) {
  const diff = due - Date.now();
  if (diff <= 0) return "now";
  const d = Math.round(diff / 86400000);
  if (d < 1) return "today";
  return d + "d";
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
  const ko = f("Korean", "ko", "한국어");
  const en = f("English meaning", "en", "meaning");
  const topicSel = el("select", {}, ["society","business","emotion","medical","finance","economy","government","general","verb","adjective","idiom","law","tech","politics","education"]
    .map((t) => el("option", { value: t, ...(t === c.topic ? { selected: "selected" } : {}) }, t)));
  const ex = f("Example (Korean, optional)", "ex");
  const exEn = f("Example translation (optional)", "exEn");

  const modal = el("div", { class: "modal stack" }, [
    el("h1", { text: editing ? "Edit word" : "Add word" }),
    ko.node, en.node,
    el("label", { class: "field" }, [el("span", { text: "Topic" }), topicSel]),
    ex.node, exEn.node,
    el("button", { class: "btn", text: "Save", onclick: async () => {
      c.ko = ko.input.value.trim();
      c.en = en.input.value.trim();
      c.topic = topicSel.value;
      c.ex = ex.input.value.trim();
      c.exEn = exEn.input.value.trim();
      if (!c.ko || !c.en) { toast("Korean and English are required"); return; }
      await db.put("cards", c);
      close(); go("words"); toast(editing ? "Saved" : "Added");
    } }),
    editing ? el("button", { class: "btn danger", text: "Delete word", onclick: async () => {
      if (confirm("Delete this word and its stats?")) { await db.del("cards", c.id); close(); go("words"); }
    } }) : null,
    el("button", { class: "btn ghost", text: "Cancel", onclick: close }),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ═══════════════════════ SETTINGS ═══════════════════════
routes.settings = async function () {
  const s = await getSettings();
  const wrap = el("div", { class: "stack" });
  wrap.appendChild(el("h1", { text: "Settings" }));

  const numField = (label, key, hint) => {
    const input = el("input", { type: "number", inputmode: "numeric", min: "0", value: String(s[key]) });
    input._key = key;
    return { node: el("label", { class: "field" }, [
      el("span", { text: label + (hint ? ` — ${hint}` : "") }), input]), input };
  };
  const first = numField("First-day word count", "firstDayCount");
  const perDay = numField("New words per day", "newPerDay");
  const mins = numField("Target session minutes", "sessionMinutes", "soft goal");
  const thr = numField("Typing graduation (days)", "typingThreshold", "interval to switch MC→typing");

  const formatSel = el("select", {}, [
    el("option", { value: "continuous", ...(s.format !== "round" ? { selected: "selected" } : {}) }, "Continuous (weighted, missed words more)"),
    el("option", { value: "round", ...(s.format === "round" ? { selected: "selected" } : {}) }, "Rounds (full passes)"),
  ]);

  wrap.appendChild(el("div", { class: "card stack" }, [
    el("label", { class: "field" }, [el("span", { text: "Default drill format" }), formatSel]),
    first.node, perDay.node, mins.node, thr.node,
    el("button", { class: "btn", text: "Save settings", onclick: async () => {
      const out = { format: formatSel.value };
      [first, perDay, mins, thr].forEach((f) => { out[f.input._key] = Math.max(0, parseInt(f.input.value || "0", 10)); });
      await saveSettings(out); toast("Settings saved");
    } }),
  ]));

  wrap.appendChild(el("h2", { text: "Backup" }));
  wrap.appendChild(el("div", { class: "card stack" }, [
    el("p", { class: "muted", text: "All data lives on this device. Export a backup file regularly so clearing your browser can't lose your progress." }),
    el("button", { class: "btn secondary", text: "⬇ Export backup", onclick: exportData }),
    el("button", { class: "btn secondary", text: "⬆ Import backup", onclick: importData }),
  ]));

  wrap.appendChild(el("h2", { text: "Danger zone" }));
  wrap.appendChild(el("div", { class: "card stack" }, [
    el("button", { class: "btn danger", text: "Reset progress (keep words)", onclick: resetProgress }),
    el("button", { class: "btn danger", text: "Erase everything", onclick: eraseAll }),
  ]));

  wrap.appendChild(el("p", { class: "muted", style: "text-align:center;margin-top:20px",
    text: "되새김 · Korean SRS — your personal vocabulary trainer" }));
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
  toast("Backup exported");
}

function importData() {
  const input = el("input", { type: "file", accept: "application/json,.json" });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.cards) throw new Error("Invalid file");
      if (!confirm("This replaces all current data with the backup. Continue?")) return;
      await db.clear("cards"); await db.clear("days");
      await db.bulkPut("cards", data.cards);
      if (data.days) await db.bulkPut("days", data.days);
      if (data.settings) await saveSettings(data.settings);
      if (data.state) await saveState(data.state);
      toast("Backup imported"); go("home");
    } catch (e) { toast("Import failed: " + e.message); }
  });
  input.click();
}

async function resetProgress() {
  if (!confirm("Reset all study progress and stats? Your word list stays.")) return;
  const cards = await db.getAll("cards");
  for (const c of cards) {
    Object.assign(c, { introduced: false, status: "new", ease: 2.5, intervalDays: 0,
      reps: 0, lapses: 0, due: 0, introducedAt: 0, seen: 0, correct: 0, wrong: 0, lastSeen: 0 });
  }
  await db.bulkPut("cards", cards);
  await db.clear("days");
  await saveState({ lastIntroDate: null, firstDayDone: false });
  toast("Progress reset"); go("home");
}

async function eraseAll() {
  if (!confirm("Erase EVERYTHING (words, progress, settings)? This cannot be undone.")) return;
  await db.clear("cards"); await db.clear("days"); await db.clear("meta");
  await mergeSeed();
  toast("Everything erased & reseeded"); go("home");
}

// ═══════════════════════ BOOT ═══════════════════════
async function boot() {
  const added = await mergeSeed();
  go("home");
  if (added > 0) toast(`Added ${added} new words to your library`);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
boot();

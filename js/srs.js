// Simplified SM-2 spaced-repetition scheduling + daily helpers.
import { db, getSettings, getState, saveState } from "./db.js";

const DAY_MS = 86400000;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Apply an answer outcome to a card and reschedule it.
// correct: bool. typed: bool (typing answers nudge ease up slightly).
export function applyAnswer(card, correct, typed) {
  const now = Date.now();
  card.seen += 1;
  card.lastSeen = now;
  if (correct) {
    card.correct += 1;
    card.reps += 1;
    if (card.reps === 1) card.intervalDays = 1;
    else if (card.reps === 2) card.intervalDays = 3;
    else card.intervalDays = Math.max(1, Math.round(card.intervalDays * card.ease));
    if (typed) card.ease = Math.min(3.0, card.ease + 0.1);
    card.due = now + card.intervalDays * DAY_MS;
    card.status = "review";
  } else {
    card.wrong += 1;
    if (card.status === "review") card.lapses += 1;
    card.reps = 0;
    card.intervalDays = 0;
    card.ease = Math.max(1.3, card.ease - 0.2);
    card.due = now; // stays due; keeps reappearing within the session
    card.status = "learning";
  }
  return card;
}

// Should this card be shown as typing (production) rather than multiple choice?
export function isTypingCard(card, settings) {
  return card.status === "review" && card.intervalDays >= settings.typingThreshold;
}

// Introduce the day's batch of new words (once per calendar day the app is opened).
export async function ensureDailyIntroduction() {
  const settings = await getSettings();
  const state = await getState();
  const today = todayStr();
  if (state.lastIntroDate === today) return 0;

  const cards = await db.getAll("cards");
  const notIntro = cards.filter((c) => !c.introduced && !c.suspended);

  const count = state.firstDayDone ? settings.newPerDay : settings.firstDayCount;
  // Pick the day's new words at random from the pool so learning order isn't
  // tied to seed/insertion order.
  const batch = shuffle(notIntro).slice(0, count);
  const now = Date.now();
  for (const c of batch) {
    c.introduced = true;
    c.status = "learning";
    c.due = now;
    c.introducedAt = now;
  }
  if (batch.length) await db.bulkPut("cards", batch);

  state.lastIntroDate = today;
  state.firstDayDone = true;
  await saveState(state);

  if (batch.length) {
    const day = await getDay(today);
    day.newIntroduced += batch.length;
    await db.put("days", day);
  }
  return batch.length;
}

export async function getDay(date) {
  const d = await db.get("days", date);
  return d || { date, reviewed: 0, correct: 0, wrong: 0, newIntroduced: 0, timeMs: 0, bestRate: 0, passed: false };
}

// Cards that are due right now (introduced, not suspended).
export async function dueCards() {
  const cards = await db.getAll("cards");
  const now = Date.now();
  return cards.filter((c) => c.introduced && !c.suspended && c.due <= now);
}

// Count breakdown for the home screen.
export async function homeCounts() {
  const cards = await db.getAll("cards");
  const now = Date.now();
  let dueNew = 0, dueReview = 0;
  for (const c of cards) {
    if (!c.introduced || c.suspended) continue;
    if (c.due > now) continue;
    if (c.status === "review") dueReview += 1; else dueNew += 1;
  }
  return { dueNew, dueReview, due: dueNew + dueReview };
}

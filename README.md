# 되새김 · Korean SRS

*되새김 (doesaegim) — "rumination," to chew over and recall again. The act of spaced repetition.*

A personal, offline-first mobile web app for drilling intermediate–advanced Korean
vocabulary with spaced repetition. No accounts, no server — all data lives in your
phone's browser (IndexedDB).

**Live:** https://hyuncho.github.io/korean-srs/

## How it works

- **Daily intro:** Day 1 introduces 20 words; each following day adds 5 more (configurable in Settings).
- **Drill to your pass goal (default 95%, adjustable in Settings):** goes through all ~20 words once, then keeps serving words drawn from the whole list but **weighted toward ones you've missed** (never the same word twice in a row). Ends when your pass rate over the **last *deck-sized* window** of answers (one deck's worth, min 20) reaches the goal — so a rough start **ages out** instead of permanently anchoring the score. The live ✓ / ✗ / % all describe that rolling window (no progress bar).
- **Pass = miss:** Tap **Pass** when you don't know a word; it reveals the answer and counts against your pass rate (same as a wrong answer), so you never guess.
- **MC → typing graduation:** A new word starts as **multiple choice** (see Korean → pick the English meaning). After a few good answers it graduates to **typing** (see English → type the Korean). Adjust the graduation point in Settings.
- **Do Not Show:** In the Words tab, tap 🚫 on anything too easy to suspend it — it drops out of the daily drill (stats are kept).
- **Stats:** streak, today's best pass / answers / time, word breakdown, and 14-day trend charts.

## Running it

It's plain HTML/CSS/JS (ES modules) — no build step. It just needs to be served over
HTTP(S) (ES modules + IndexedDB + service worker don't work from a `file://` URL).

### Quick local test (desktop)
```bash
cd korean-srs
python3 -m http.server 8000
# open http://localhost:8000
```

### Use it on your phone

Pick whichever is easiest:

1. **Same Wi-Fi:** run the command above, find your computer's LAN IP
   (`ipconfig getifaddr en0` on macOS), and open `http://<that-ip>:8000` on your phone.
   *(Note: on some browsers the typing/PWA features want HTTPS — option 2 is more robust.)*

2. **Free static hosting (recommended for daily use):** deploy this folder to
   **GitHub Pages**, **Netlify Drop** (drag-and-drop the folder at app.netlify.com/drop),
   or **Vercel**. You get an HTTPS URL.

3. **Install to home screen (PWA):** open the HTTPS URL on your phone →
   - iPhone Safari: Share → *Add to Home Screen*
   - Android Chrome: ⋮ menu → *Install app / Add to Home Screen*

   It then opens full-screen and works offline.

> **Typing mode** requires a Korean keyboard on your phone (iOS/Android: add Korean
> in keyboard settings, then switch with the 🌐 key).

## Backups

Data is per-browser. In **Settings → Backup**, use **Export** regularly to download a
JSON snapshot, and **Import** to restore it (or move to a new phone). Clearing your
browser data / site storage will erase progress if you have no backup.

## Adding & editing words

**Words tab → ＋ Add** (or tap a word to edit). The app ships with ~280 seed words across
society, business, emotions, medical, finance, economy, government, general, verbs,
adjectives, idioms (사자성어), law, tech/science/environment, politics, and education —
roughly two months at +5/day. Add more anytime; newly added words enter the "upcoming"
queue and get introduced on following days.

New seed words are **merged** into your library on launch (tracked so deleting one keeps
it gone), so updates add vocabulary without disturbing your progress.

## Files

```
index.html            app shell + bottom tab bar
css/styles.css        styling (dark, mobile-first)
js/app.js             UI, quiz engine, stats, words, settings, backup
js/db.js              IndexedDB wrapper, settings, seeding
js/srs.js             SM-2 scheduling + daily introduction
js/seed.js            starter vocabulary
manifest.webmanifest  PWA manifest
sw.js                 service worker (offline)
icon.svg              app icon
```

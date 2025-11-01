// sidepanel.js — Summarizer (styles) → >=6 key concepts → idempotent highlights → explain on click → open Quiz popup
"use strict";

/* ------------- DOM helpers ------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* Elements */
const srcSel             = $("#summary-source");
const customWrap         = $("#custom-input-wrap");
const customInput        = /** @type {HTMLTextAreaElement|null} */ ($("#custom-input"));
const runBtn             = $("#btn-run-summary");
const output             = $("#summary-output");

const conceptTerm        = $("#concept-term");
const conceptExplanation = $("#concept-explanation");
const conceptHistory     = $("#concept-history");

const btnOpenSummarizer  = $("#btn-open-summarizer");
const btnCreateQuiz      = $("#btn-create-quiz");

/* ------------- UI wiring ------------- */
btnOpenSummarizer?.addEventListener("click", () => {
  $("#sec-summarizer")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// Open Quiz popup and pass origin tabId
btnCreateQuiz?.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.runtime.sendMessage({ type: "OPEN_QUIZ_POPUP", tabId: tab?.id ?? null });
  } catch (e) {
    console.error("Failed to open quiz popup:", e);
  }
});

// Show custom textarea only when Source = "custom" (hardened)
function syncCustomVisibility() {
  if (!srcSel || !customWrap) return;
  const isCustom = (srcSel.value || "").trim() === "custom";
  customWrap.hidden = !isCustom;
  customWrap.style.display = isCustom ? "" : "none";
  customWrap.setAttribute("aria-hidden", String(!isCustom));
}
syncCustomVisibility();
srcSel?.addEventListener("change", syncCustomVisibility);

// Segmented control (style chooser)
function getSelectedStyle() {
  const active = $(".segmented .seg.active");
  return active?.dataset.style || "tldr";
}
$$(".segmented .seg").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".segmented .seg").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

/* ------------- Tab + messaging helpers ------------- */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function ensureContentScript(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: "__PING__" }); }
  catch { await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] }); }
}
async function getPageDump(source = "page") {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab.");
  const url = tab.url || "";
  if (!/^https?:\/\//.test(url) && !url.startsWith("file://")) {
    throw new Error("Open a regular HTTP(S) page. Content scripts can't run on chrome://, Web Store, or the default New Tab.");
  }
  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, { type: "PSH_EXTRACT", source });
}
async function highlightConceptsInPage(terms = []) {
  const tab = await getActiveTab();
  if (!tab?.id) return { ok: false, error: "No active tab" };
  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT_CONCEPTS", terms });
}
async function clearHighlightsInPage() {
  const tab = await getActiveTab();
  if (!tab?.id) return { ok: false, error: "No active tab" };
  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, { type: "CLEAR_HIGHLIGHTS" });
}

/* ------------- Summarizer (single instance) ------------- */
let SUMMARIZER = null;

async function ensureSummarizer() {
  if (!("Summarizer" in self)) {
    throw new Error("Summarizer API not detected in this context. Use Chrome 138+ and run from the Side Panel.");
  }
  if (SUMMARIZER) return SUMMARIZER;

  SUMMARIZER = await Summarizer.create({
    // Keep one model; we vary style by prefix instruction
    type: "tldr",
    length: "short",
    format: "markdown",
    outputLanguage: "en",
    expectedInputLanguages: ["en"],
    monitor(m) {
      m.addEventListener("downloadprogress", e => {
        console.log("Model download:", Math.round(e.loaded * 100) + "%");
      });
    }
  });
  return SUMMARIZER;
}

/* ------------- Pre-condense utilities ------------- */
function normalize(s) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function splitSentences(text) {
  return text
    .split(/(?<=[\.!?])\s+(?=[A-Z0-9“"(\[])/g)
    .map(s => s.trim())
    .filter(Boolean);
}
function condenseFast(raw, charCap = 8000) {
  const lines = normalize(raw).split(/\n+/).map(l => l.trim()).filter(Boolean);
  const dedup = new Set();
  const keep = [];
  for (const line of lines) {
    if (line.length < 25) continue;
    const isHeading = line.length <= 90 && !/[.!?]$/.test(line);
    if (isHeading) {
      const k = "H|" + line.toLowerCase();
      if (!dedup.has(k)) { keep.push(line); dedup.add(k); }
      continue;
    }
    const first = splitSentences(line)[0] || line;
    const k = "S|" + first.toLowerCase();
    if (!dedup.has(k)) { keep.push(first); dedup.add(k); }
    if (keep.join("\n").length >= charCap) break;
  }
  let condensed = keep.join("\n");
  if (condensed.length > charCap) condensed = condensed.slice(0, charCap);
  return condensed;
}

/* ------------- Timeout helper ------------- */
function withTimeout(promise, ms, onTimeout) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error("TIMEOUT")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
    .catch(err => (err && err.message === "TIMEOUT" && onTimeout ? onTimeout() : Promise.reject(err)));
}

/* ------------- Key concept extraction ------------- */
const STOP = new Set([
  "a","an","the","and","or","to","of","in","on","for","by","with","as","at","from","that","this","these","those",
  "is","are","was","were","be","being","been","it","its","into","over","under","about","than","then","so","such","via",
  "we","our","you","your","their","them","they","he","she","his","her","i","me","my","mine","yours","ours"
]);
const TITLE_SINGLE_BAN = new Set([
  "history","overview","introduction","methods","results","discussion","conclusion",
  "several","these","those","this","the","domestic","cats","cat","background"
]);

function tokenizeLower(s) { return (s.toLowerCase().match(/[a-z][a-z0-9\-]+/g) || []); }
function countWordFreq(tokens) { const m = new Map(); for (const t of tokens) m.set(t, (m.get(t)||0) + 1); return m; }
function wordsAreMostlyStop(term) {
  const ws = term.toLowerCase().split(/\s+/);
  const stopCount = ws.filter(w => STOP.has(w)).length;
  return stopCount / ws.length >= 0.5;
}
function cleanTerm(term) {
  return term.replace(/[^\w\- ]+/g, " ").replace(/\s+/g, " ").trim();
}
function appearsInPage(term, pageFreq) {
  const raw = pageFreq.__raw || "";
  if (term.includes(" ")) {
    const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return pattern.test(raw);
  }
  return (pageFreq.get(term.toLowerCase()) || 0) >= 2;
}
function scoreCandidates(cands, pageFreq) {
  const seen = new Map();
  const add = (term, score) => {
    const key = cleanTerm(term);
    if (!key) return;
    if (key.length < 4) return;
    if (/^[a-z]+$/.test(key) && STOP.has(key)) return;
    if (wordsAreMostlyStop(key)) return;
    if (!appearsInPage(key, pageFreq)) return;
    seen.set(key, Math.max(seen.get(key) || 0, score));
  };
  for (const [t, s] of cands) add(t, s);
  return seen;
}
function topByScore(seen, max) {
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([k]) => k);
}

// MAIN extractor
function extractKeyConceptsFromSummary(summary, pageText, max = 12) {
  const s = summary || "";
  const pageRaw = pageText || "";
  const pageTokens = tokenizeLower(pageRaw);
  const pageFreq = countWordFreq(pageTokens);
  pageFreq.__raw = pageRaw;

  const candidates = [];

  // **Bold**
  const boldRx = /\*\*([^*]+?)\*\*/g;
  for (let m; (m = boldRx.exec(s)); ) {
    const t = cleanTerm(m[1]); if (t) candidates.push([t, 6]);
  }

  // `code`
  const codeRx = /`([^`]+?)`/g;
  for (let m; (m = codeRx.exec(s)); ) {
    const t = cleanTerm(m[1]); if (t) candidates.push([t, 5]);
  }

  // Title Case (1–3 words), ban junk singles
  const titleRx = /(?:^|[^A-Za-z])([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?=$|[^A-Za-z])/g;
  for (let m; (m = titleRx.exec(s)); ) {
    const t = cleanTerm(m[1]); if (!t) continue;
    const wcount = t.split(" ").length;
    if (wcount === 1 && TITLE_SINGLE_BAN.has(t.toLowerCase())) continue;
    candidates.push([t, wcount >= 2 ? 4 : 3]);
  }

  // Frequent bigrams/trigrams (lowercase, non-stopword)
  const toks = tokenizeLower(s);
  const grams = new Map();
  const pushGram = (g) => grams.set(g, (grams.get(g) || 0) + 1);

  for (let i = 0; i < toks.length - 1; i++) {
    const w1 = toks[i], w2 = toks[i + 1];
    if (STOP.has(w1) || STOP.has(w2)) continue;
    if (w1.length < 3 || w2.length < 3) continue;
    pushGram(`${w1} ${w2}`);
  }
  for (let i = 0; i < toks.length - 2; i++) {
    const w1 = toks[i], w2 = toks[i + 1], w3 = toks[i + 2];
    if (STOP.has(w1) || STOP.has(w2) || STOP.has(w3)) continue;
    if (w1.length < 3 || w2.length < 3 || w3.length < 3) continue;
    pushGram(`${w1} ${w2} ${w3}`);
  }

  for (const [g, f] of grams) {
    const penalty = /^\w+ing\b/.test(g) ? 1 : 0;
    const base = g.split(" ").length === 3 ? 3 : 2;
    candidates.push([g, base + Math.min(f, 3) - penalty]);
  }

  const scored = scoreCandidates(candidates, pageFreq);
  return topByScore(scored, max);
}

/* ---- Ensure we have at least MIN_HL unique highlights by falling back to frequent terms from the page ---- */
const MIN_HL = 6;

function ensureMinConcepts(concepts, pageText, min = MIN_HL) {
  const have = new Set(concepts.map(c => c.toLowerCase()));
  if (have.size >= min) return concepts;

  const toks = tokenizeLower(pageText);
  const freq = countWordFreq(toks);
  // Candidate single words: length>=5, freq>=2, not stop
  const singles = [...freq.entries()]
    .filter(([w, c]) => !STOP.has(w) && w.length >= 5 && c >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([w]) => w);

  // Candidate bigrams
  const grams = new Map();
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i], b = toks[i+1];
    if (STOP.has(a) || STOP.has(b) || a.length < 3 || b.length < 3) continue;
    const g = `${a} ${b}`; grams.set(g, (grams.get(g) || 0) + 1);
  }
  const bigrams = [...grams.entries()]
    .filter(([,c]) => c >= 2)
    .sort((a,b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([g]) => g);

  for (const g of [...bigrams, ...singles]) {
    if (have.size >= min) break;
    if (!have.has(g)) {
      have.add(g);
      concepts.push(g);
    }
  }
  return concepts;
}

/* ------------- Concept Explorer helpers ------------- */
const conceptSet = new Set();
function addConceptToHistory(term, { clickToExplain = true } = {}) {
  if (!term || conceptSet.has(term)) return;
  conceptSet.add(term);
  if (!conceptHistory) return;
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.textContent = term;
  chip.title = "Explain concept";
  if (clickToExplain) chip.addEventListener("click", () => explainConcept(term));
  conceptHistory.prepend(chip);
}
async function explainConcept(term) {
  try {
    if (conceptTerm)        conceptTerm.textContent = term;
    if (conceptExplanation) conceptExplanation.textContent = "Explaining…";
    const s = await ensureSummarizer();
    const context = window.__lastContext__ || "";
    const prompt = `Explain the concept "${term}" in 3–5 bullet points with a simple example.\n\nContext:\n${context}`;
    const out = await s.summarize(prompt);
    if (conceptExplanation) conceptExplanation.textContent = out || "(No explanation produced)";
    addConceptToHistory(term);
  } catch (e) {
    console.error(e);
    if (conceptExplanation) conceptExplanation.textContent = e?.message || String(e);
  }
}

/* ------------- RUN: summarize → >=6 concepts → highlight → history ------------- */
runBtn?.addEventListener("click", async () => {
  try {
    output.textContent = "Summarizing…";
    await ensureSummarizer();

    const source = srcSel?.value || "page";
    let text = "";
    if (source === "custom") {
      text = (customInput?.value || "").trim();
    } else {
      const dump = await getPageDump("page");
      text = (dump?.text || "").trim();
    }
    if (!text) { output.textContent = "(No text found.)"; return; }

    const toSummarize = condenseFast(text, 8000);
    window.__lastContext__ = toSummarize;

    // Style directive
    const style = getSelectedStyle();
    const styleDirectives = {
      "tldr": "",
      "bullets": "Return 5–9 concise key bullet points in markdown.",
      "study-notes": "Write concise study notes in markdown with short headings and bullet points. Include key definitions, steps, and any formulas if present."
    };
    const prefix = styleDirectives[style] || "";
    const input = prefix ? `${prefix}\n\n${toSummarize}` : toSummarize;

    const s = await ensureSummarizer();
    const primary  = () => s.summarize(input);
    const fallback = () => s.summarize((prefix ? `${prefix}\n\n` : "") + toSummarize.slice(0, 3000));
    const summary  = await withTimeout(primary(), 45000, fallback);

    output.textContent = summary || "(No summary produced)";

    let concepts = extractKeyConceptsFromSummary(summary, text, 12);
    concepts = ensureMinConcepts(concepts, text, MIN_HL);

    await clearHighlightsInPage(); // clean slate
    if (concepts.length) {
      const res = await highlightConceptsInPage(concepts);
      console.log("Highlighted concepts:", concepts, res);
      concepts.forEach(term => addConceptToHistory(term));
    }
  } catch (e) {
    console.error(e);
    output.textContent = e?.message || String(e);
  }
});

/* ------------- Page clicks → explain in panel ------------- */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "CONCEPT_CLICKED") return;
  const term = (msg.term || "").trim();
  if (!term) return;
  explainConcept(term);
});

// quiz.js — Popup quiz using Chrome Prompt API (LanguageModel) with optional multimodal
"use strict";

/* ---------- DOM ---------- */
const $  = (s, r = document) => r.querySelector(s);

const srcSel    = $("#quiz-source");
const customWrap= $("#custom-wrap");
const customTxt = /** @type {HTMLTextAreaElement|null} */ ($("#custom-text"));

const mmWrap    = $("#mm-wrap");
const imgInput  = /** @type {HTMLInputElement|null} */ ($("#img-input"));
const audInput  = /** @type {HTMLInputElement|null} */ ($("#aud-input"));

const btnGen    = $("#btn-gen");
const btnReset  = $("#btn-reset");
const statusEl  = $("#status");

const quizBox   = $("#quiz-container");
const scoreEl   = $("#score");

/* ---------- UI wiring ---------- */
function syncCustomVisibility() {
  const isCustom = srcSel.value === "custom";
  customWrap.hidden = !isCustom;
  customWrap.setAttribute("aria-hidden", String(!isCustom));
}
srcSel.addEventListener("change", syncCustomVisibility);
syncCustomVisibility();

/* ---------- Utils ---------- */
function setStatus(s) { if (statusEl) statusEl.textContent = s || ""; }
function normalize(s) {
  return (s || "").replace(/\r/g,"").replace(/\u00A0/g," ").replace(/[ \t]+/g," ")
    .replace(/\n[ \t]+/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}
function splitSentences(text) {
  return text.split(/(?<=[\.!?])\s+(?=[A-Z0-9“"(\[])/g).map(s=>s.trim()).filter(Boolean);
}
function condenseFast(raw, cap=8000) {
  const lines = normalize(raw).split(/\n+/).map(l=>l.trim()).filter(Boolean);
  const dedup=new Set(); const keep=[];
  for(const line of lines){
    if(line.length<25) continue;
    const isHeading=line.length<=90 && !/[.!?]$/.test(line);
    if(isHeading){ const k="H|"+line.toLowerCase(); if(!dedup.has(k)){keep.push(line); dedup.add(k);} continue; }
    const first=splitSentences(line)[0]||line; const k="S|"+first.toLowerCase();
    if(!dedup.has(k)){ keep.push(first); dedup.add(k); }
    if(keep.join("\n").length>=cap) break;
  }
  let s=keep.join("\n"); if(s.length>cap) s=s.slice(0,cap); return s;
}
function withTimeout(promise, ms, onTimeout) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error("TIMEOUT")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
    .catch(err => (err && err.message === "TIMEOUT" && onTimeout ? onTimeout() : Promise.reject(err)));
}
function safeParseJSON(s) {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  const first = s.indexOf("{"), last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch {}
  }
  return null;
}

/* ---------- Get origin tab (the page to read) ---------- */
function getOriginTabIdFromQuery() {
  const q = new URLSearchParams(location.search);
  const n = Number(q.get("tabId"));
  return Number.isFinite(n) ? n : null;
}
async function getOriginTab() {
  const tabId = getOriginTabIdFromQuery();
  if (tabId) {
    try { return await chrome.tabs.get(tabId); } catch {}
  }
  const tabs = await chrome.tabs.query({ active: true });
  return tabs.find(t => t.url && !t.url.startsWith("chrome-extension://")) || null;
}
async function ensureContentScript(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: "__PING__" }); }
  catch { await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] }); }
}
async function extractFromPage() {
  const tab = await getOriginTab();
  if (!tab?.id) throw new Error("Couldn't find the origin page tab. Open the popup from a normal webpage.");
  const url = tab.url || "";

  const isRestricted =
    url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("about:") ||
    url.startsWith("chrome-extension://") || url.startsWith("chromewebstore://");

  if (isRestricted) { const err = new Error("RESTRICTED_SCHEME"); err.url = url; throw err; }

  if (url.startsWith("file://")) {
    try { await ensureContentScript(tab.id); }
    catch { const err = new Error("FILE_URL_BLOCKED"); err.url = url; throw err; }
  } else if (/^https?:\/\//.test(url)) {
    await ensureContentScript(tab.id);
  } else {
    const err = new Error("UNSUPPORTED_URL"); err.url = url; throw err;
  }

  return chrome.tabs.sendMessage(tab.id, { type: "PSH_EXTRACT", source: "page" });
}

/* ---------- Prompt API (LanguageModel) ---------- */
let LM = null;
let multimodalEnabled = false;

async function ensureLanguageModel() {
  if (!("LanguageModel" in self)) throw new Error("Prompt API (LanguageModel) not available.");

  // Try multimodal session first
  const mmOpts = {
    expectedInputs:  [{ type: "text", languages: ["en"] }, { type: "image" }, { type: "audio" }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    monitor(m){ m.addEventListener("downloadprogress", e => setStatus(`Model download: ${Math.round(e.loaded*100)}%`)); }
  };

  let availability = "unavailable";
  try { availability = await LanguageModel.availability(mmOpts); } catch {}

  if (availability !== "unavailable") {
    try {
      LM = await LanguageModel.create(mmOpts);
      multimodalEnabled = true;
      mmWrap?.classList.remove("hidden");
      return LM;
    } catch {}
  }

  // Fallback: text-only
  const textOpts = {
    expectedInputs:  [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    monitor(m){ m.addEventListener("downloadprogress", e => setStatus(`Model download: ${Math.round(e.loaded*100)}%`)); }
  };
  const a2 = await LanguageModel.availability(textOpts);
  if (a2 === "unavailable") throw new Error("Language model unavailable on this device.");
  LM = await LanguageModel.create(textOpts);
  multimodalEnabled = false;
  mmWrap?.classList.add("hidden");
  return LM;
}

/* ---------- Quiz generation ---------- */
let QUIZ = null;
let SCORE = 0;

btnGen.addEventListener("click", generateQuiz);
btnReset.addEventListener("click", resetQuiz);

async function generateQuiz() {
  try {
    setStatus("Preparing…");
    quizBox.innerHTML = `<div class="muted">Generating quiz…</div>`;
    scoreEl.textContent = "Score: 0 / 4";
    SCORE = 0;

    const lm = LM || await ensureLanguageModel();

    // Context
    let raw = "";
    if (srcSel.value === "custom") {
      raw = (customTxt?.value || "").trim();
    } else {
      try {
        const dump = await extractFromPage();
        raw = (dump?.text || "").trim();
      } catch (err) {
        const msg = String(err?.message || err);
        if (msg === "RESTRICTED_SCHEME") {
          quizBox.innerHTML = `<div class="muted">This page is restricted (e.g., chrome://, Web Store, Extensions, PDF viewer). Switch to <b>Custom input</b> or open a normal https page and try again.</div>`;
          setStatus("Restricted page — use Custom input or open an https page.");
          srcSel.value = "custom"; syncCustomVisibility();
          return;
        }
        if (msg === "FILE_URL_BLOCKED") {
          quizBox.innerHTML = `<div class="muted">You're on a <code>file://</code> page. In <code>chrome://extensions</code> → your extension → enable <b>Allow access to file URLs</b>, then retry. Or use <b>Custom input</b>.</div>`;
          setStatus("file:// access not enabled.");
          srcSel.value = "custom"; syncCustomVisibility();
          return;
        }
        if (msg === "UNSUPPORTED_URL" || msg.includes("Couldn't find the origin page")) {
          quizBox.innerHTML = `<div class="muted">Couldn’t read the page. Use <b>Custom input</b> or open a normal webpage and try again.</div>`;
          setStatus("Unsupported URL.");
          srcSel.value = "custom"; syncCustomVisibility();
          return;
        }
        throw err;
      }
    }

    if (!raw) {
      quizBox.innerHTML = `<div class="muted">No text available to generate a quiz.</div>`;
      setStatus(""); return;
    }

    const context = condenseFast(raw, 8000);

    // Optional multimodal append (image/audio)
    if (multimodalEnabled) {
      const content = [];
      content.push({ type: "text", value: "Include this as background context for questions." });
      if (imgInput?.files?.[0]) content.push({ type: "image", value: imgInput.files[0] });
      if (audInput?.files?.[0]) content.push({ type: "audio", value: audInput.files[0] });
      if (content.length > 1) {
        try { await lm.append([{ role: "user", content }]); }
        catch (e) { console.warn("Multimodal append failed, continuing with text-only:", e); }
      }
    }

    // Structured JSON schema
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["q", "options", "answer"],
            properties: {
              q: { type: "string", minLength: 3 },
              options: { type: "array", minItems: 4, maxItems: 4, items: { type: "string", minLength: 1 } },
              answer: { type: "integer", minimum: 0, maximum: 3 },
              explanation: { type: "string" }
            }
          }
        }
      }
    };

    const promptText = [
      "Create a 4-question multiple-choice quiz based ONLY on the content below.",
      "- Each question: exactly 4 options, exactly one correct answer.",
      "- Make distractors plausible but clearly incorrect.",
      "- Keep questions concise and unambiguous.",
      "- Return ONLY JSON that matches the provided schema.",
      "",
      "CONTENT:",
      context
    ].join("\n");

    setStatus("Generating with Prompt API…");
    const rawJson = await withTimeout(
      lm.prompt(promptText, { responseConstraint: schema, omitResponseConstraintInput: true }),
      45000
    );

    const data = safeParseJSON(rawJson);
    if (!data?.questions?.length) {
      quizBox.innerHTML = `<div class="muted">Couldn’t parse a quiz. Try again.</div>`;
      setStatus(""); return;
    }

    // Normalize to 4x4
    data.questions = data.questions
      .slice(0, 4)
      .map(q => ({
        q: String(q.q || "").trim(),
        options: Array.isArray(q.options) ? q.options.slice(0, 4).map(o => String(o || "").trim()) : [],
        answer: Number.isInteger(q.answer) ? Math.max(0, Math.min(3, q.answer)) : 0,
        explanation: String(q.explanation || "").trim()
      }))
      .filter(q => q.q && q.options.length === 4);

    QUIZ = data;
    SCORE = 0;
    renderQuiz(QUIZ);
    setStatus("");
  } catch (e) {
    console.error(e);
    quizBox.innerHTML = `<div class="muted">${e?.message || String(e)}</div>`;
    setStatus("");
  }
}

function resetQuiz() {
  QUIZ = null;
  SCORE = 0;
  quizBox.innerHTML = `<div class="muted">Quiz cleared. Click “Generate Quiz”.</div>`;
  scoreEl.textContent = "Score: 0 / 4";
}

function renderQuiz(qdata) {
  if (!quizBox) return;
  if (!qdata?.questions?.length) {
    quizBox.innerHTML = `<div class="muted">No questions.</div>`;
    return;
  }

  const letters = ["A","B","C","D"];
  quizBox.innerHTML = "";

  qdata.questions.forEach((q, qi) => {
    const card = document.createElement("div");
    card.className = "qcard";

    const title = document.createElement("div");
    title.className = "qtitle";
    title.textContent = `Q${qi + 1}. ${q.q}`;
    card.appendChild(title);

    const list = document.createElement("div");
    list.className = "choices";

    q.options.forEach((opt, oi) => {
      const btn = document.createElement("button");
      btn.className = "choice";
      btn.type = "button";
      btn.dataset.q = String(qi);
      btn.dataset.i = String(oi);

      const letter = document.createElement("span");
      letter.className = "letter";
      letter.textContent = letters[oi];

      const text = document.createElement("span");
      text.className = "text";
      text.textContent = opt;

      btn.appendChild(letter);
      btn.appendChild(text);

      btn.addEventListener("click", onChoiceClick);
      list.appendChild(btn);
    });

    card.appendChild(list);

    const expl = document.createElement("div");
    expl.className = "expl";
    expl.id = `expl-${qi}`;
    expl.hidden = true;
    card.appendChild(expl);

    quizBox.appendChild(card);
  });

  updateScore();
}

function onChoiceClick(e) {
  const btn = e.currentTarget;
  const qi = Number(btn.dataset.q);
  const oi = Number(btn.dataset.i);
  if (!QUIZ?.questions?.[qi]) return;

  const parent = btn.parentElement;
  if (!parent) return;

  // Ignore if already answered
  const answered = [...parent.querySelectorAll(".choice")]
    .some(c => c.classList.contains("is-correct") || c.classList.contains("is-wrong"));
  if (answered) return;

  const correct = QUIZ.questions[qi].answer;

  // Disable and mark all; always highlight the correct one
  [...parent.children].forEach((c, idx) => {
    c.disabled = true;
    if (idx === correct) c.classList.add("is-correct");
  });

  if (oi === correct) {
    btn.classList.add("is-correct");
    SCORE += 1;
  } else {
    btn.classList.add("is-wrong");
  }

  // Reveal explanation + explicit correct answer line
  const expl = document.getElementById(`expl-${qi}`);
  if (expl) {
    const letters = ["A","B","C","D"];
    const answerText = QUIZ.questions[qi].options[correct] || "";
    const extra = QUIZ.questions[qi].explanation ? `\n\n${QUIZ.questions[qi].explanation}` : "";
    expl.textContent = `Correct answer: ${letters[correct]}) ${answerText}${extra}`;
    expl.hidden = false;
  }

  updateScore();
}

function updateScore() {
  const total = Math.min(4, QUIZ?.questions?.length || 0) || 4;
  scoreEl.textContent = `Score: ${SCORE} / ${total}`;
}

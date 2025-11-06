# **AI Study Side Panel**

## A Chrome extension that opens a side panel next to any page and uses Chrome’s built-in AI:

* Summarizer API (Gemini Nano, on-device)** for TL;DR, key bullets, or study notes.
* Prompt API** for 4 MCQ quizzes with instant green/red feedback and explanations.
* A content script that auto-highlights 6+ key concepts in the page; clicking a highlight opens a plain-language explanation with examples.

## How We Built It
# Chrome platform

* Side Panel UI for summarize → concept explorer → quiz.
* Content Scripts + Scripting to extract readable text and inject non-duplicated <mark> highlights.
* Tabs + Runtime messaging to sync page ↔ side panel.
* (Optional) Storage to save concept history and quiz attempts.

  ## AI Flows
* Summarize current page or custom text with Summarizer API (styles: TL;DR / bullets / study notes).
* Extract concepts from the summary (bold/code spans, title-case nouns, frequent bi/tri-grams), then cross-check they appear in the page; if fewer than 6, backfill with frequent in-page terms.
* Explain on click: send the highlighted term to the Summarizer API with page context for a short, example-driven explanation.
* Quiz: Prompt API returns structured JSON for 4× MCQ; we render and auto-grade inline.

  ## Peek at Concept Scoring
  We blend (n)-gram frequency with small penalties to avoid junk:
  with (\text{penalty}(g)=1) for verbs ending in -ing and (0) otherwise. Single-word concepts are allowed if they’re domain-bearing (length ( \ge 5), frequency ( \ge 2), not a stop-word).

// content-script.js — extractor + idempotent highlighter (no duplicate marks) + concept click relay
(() => {
  /* ----- Click a highlighted concept → notify side panel ----- */
  const isConceptNode = (el) => el?.matches?.("mark.psh-mark, [data-concept]");
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!isConceptNode(t)) return;
    const term = (t.getAttribute("data-concept") || t.textContent || "").trim();
    if (!term) return;
    chrome.runtime.sendMessage({ type: "CONCEPT_CLICKED", term });
  }, true);

  /* ----- Ping so sidepanel can ensure we're loaded ----- */
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === "__PING__") { sendResponse({ ok: true }); return true; }
  });

  /* ----- Text extraction for summarizer/quiz ----- */
  function chooseMainRoot(doc = document) {
    const c = [doc.querySelector("article"), doc.querySelector("main"), doc.querySelector("#main-content"), doc.querySelector("[role=main]")].filter(Boolean);
    return c[0] || doc.body || doc.documentElement;
  }
  function stripBoilerplate(root) {
    root.querySelectorAll(["nav","header","footer","aside","form[role=search]","script","style","noscript","iframe","svg","canvas","video","audio","picture","source"].join(",")).forEach(n=>n.remove());
  }
  function normalizeText(s){return (s||"").replace(/\r/g,"").replace(/\u00A0/g," ").replace(/[ \t]+/g," ").replace(/\n[ \t]+/g,"\n").replace(/\n{3,}/g,"\n\n").trim();}

  chrome.runtime.onMessage.addListener((msg,_sender,sendResponse)=>{
    if (msg?.type !== "PSH_EXTRACT") return;
    const title=document.title||""; const url=location.href;

    const main=chooseMainRoot(document);
    const clone=main.cloneNode(true);
    stripBoilerplate(clone);

    let text=normalizeText(clone.textContent||"");
    if(!text) text=normalizeText(document.body?.textContent||"");
    const MAX=60000; if(text.length>MAX) text=text.slice(0,MAX);

    sendResponse({ title, url, text });
    return true;
  });

  /* ----- Highlighter (unique per term, first occurrence only) ----- */
  function escapeRx(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function unhighlightAll() {
    const marks = document.querySelectorAll("mark.psh-mark");
    for (const m of marks) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent || ""), m);
      parent.normalize();
    }
  }

  function highlightTerms(terms) {
    if (!terms?.length) return;

    // Normalize & de-dup requested terms
    const norm = (s) => String(s||"").toLowerCase().replace(/\s+/g, " ").trim();
    const firstOriginalByNorm = new Map();
    terms.forEach(t => {
      const n = norm(t);
      if (!n) return;
      if (!firstOriginalByNorm.has(n)) firstOriginalByNorm.set(n, String(t));
    });
    const wanted = Array.from(firstOriginalByNorm.keys());
    if (!wanted.length) return;

    const pattern = wanted.map(escapeRx).join("|");
    const rx = new RegExp(`\\b(${pattern})\\b`, "gi");

    const alreadyHighlighted = new Set(); // normalized term → highlighted once

    const REJECT = new Set(["SCRIPT","STYLE","NOSCRIPT","IFRAME","CODE","PRE","MARK"]);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n){
        const p = n.parentNode;
        if (!p || REJECT.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest("mark.psh-mark")) return NodeFilter.FILTER_REJECT;
        if (p.nodeType === 1 && getComputedStyle(p).display === "none") return NodeFilter.FILTER_REJECT;
        rx.lastIndex = 0;
        return rx.test(n.nodeValue || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    const nodes = [];
    let node; while ((node = walker.nextNode())) nodes.push(node);

    for (const n of nodes) {
      const text = n.nodeValue || "";
      let last = 0;
      const frag = document.createDocumentFragment();

      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text))) {
        const match = m[0];
        const start = m.index;
        const end   = start + match.length;

        if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));

        const key = norm(match);
        if (alreadyHighlighted.has(key)) {
          // Don't wrap duplicates in this run
          frag.appendChild(document.createTextNode(match));
        } else {
          alreadyHighlighted.add(key);
          const show = firstOriginalByNorm.get(key) || match;
          const mark = document.createElement("mark");
          mark.className = "psh-mark";
          mark.setAttribute("data-concept", show);
          mark.textContent = match; // keep original casing in page text
          frag.appendChild(mark);
        }

        last = end;

        // Stop early if we highlighted all requested terms once
        if (alreadyHighlighted.size === wanted.length) break;
      }

      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode?.replaceChild(frag, n);

      if (alreadyHighlighted.size === wanted.length) break;
    }
  }

  // Handle highlight commands
  chrome.runtime.onMessage.addListener((msg,_sender,sendResponse)=>{
    if (msg?.type === "HIGHLIGHT_CONCEPTS") {
      try {
        unhighlightAll();
        highlightTerms(msg.terms||[]);
        const count=document.querySelectorAll("mark.psh-mark").length;
        sendResponse({ ok:true, count });
      } catch(e) {
        console.error("HIGHLIGHT_CONCEPTS error:", e);
        sendResponse({ ok:false, error:String(e) });
      }
      return true;
    }
    if (msg?.type === "CLEAR_HIGHLIGHTS") {
      try { unhighlightAll(); sendResponse({ ok:true }); }
      catch(e){ console.error("CLEAR_HIGHLIGHTS error:", e); sendResponse({ ok:false, error:String(e) }); }
      return true;
    }
  });

  console.log("[content-script] ready on", location.href);
})();

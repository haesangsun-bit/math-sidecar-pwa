(() => {
  "use strict";

  const VERSION = "0.1.0";
  const START = "MATHPANEL_V1";
  const END = "END_MATHPANEL";
  const DB_NAME = "mathsidecar-pwa";
  const DB_VERSION = 1;
  const STORE = "cards";
  const START_PROMPT = [
    "이 대화에서는 앞으로 Math Sidecar 형식을 사용해라.",
    "",
    "수학이 필요한 답변은 다음 규칙을 지켜라:",
    "- 일반 본문에는 짧은 결론과 직관적 설명만 쓰고, 수식·LaTeX 원문·계산 과정은 넣지 않는다.",
    "- 모든 수식, 정의, 가정, 계산, 증명은 단 하나의 text 코드 블록 안에 넣는다.",
    "- 코드 블록 첫 줄은 정확히 MATHPANEL_V1, 마지막 줄은 정확히 END_MATHPANEL로 한다.",
    "- 블록 안 첫 제목은 # 풀이 제목 형식으로 쓴다.",
    "- 짧은 수식은 문장 안에서 반드시 \\( ... \\) 형태의 인라인 LaTeX로 쓰고, 독립식은 줄을 나눌 가치가 있을 때만 \\[ ... \\]로 쓴다.",
    "- 아래첨자에는 S_k, \\Gamma_0(N)처럼 _를 쓰고 \\_로 이스케이프하지 않는다.",
    "- 한국어 설명이나 흐름도를 \\text, gathered, aligned 같은 수학 환경에 넣지 않는다. 설명은 일반 텍스트로 쓰고 실제 수식만 LaTeX로 쓴다.",
    "- 코드 블록 밖에서 같은 수식을 반복하지 않는다.",
    "- LaTeX 서문, 외부 패키지, 사용자 정의 매크로, 중첩 코드 블록은 쓰지 않는다.",
    "- 수학이 필요 없는 질문에는 Math Sidecar 블록을 만들지 않는다.",
    "",
    "이 형식을 이 대화 전체에서 계속 유지해라."
  ].join("\n");

  const list = document.getElementById("list");
  const empty = document.getElementById("empty");
  const count = document.getElementById("count");
  const renderer = document.getElementById("renderer");
  const toast = document.getElementById("toast");
  const askPopup = document.getElementById("ask-popup");
  const importDialog = document.getElementById("import-dialog");
  const importText = document.getElementById("import-text");
  const importUrl = document.getElementById("import-url");
  const records = new Map();
  let order = [];
  let pendingSelection = null;
  let selectionTimer = null;
  let highlightedMath = new Set();
  let mathPointerStart = null;
  let deferredInstallPrompt = null;

  document.getElementById("version").textContent = `v${VERSION}`;

  function showToast(message, ms = 1900) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.hidden = true; }, ms);
  }

  function stableHash(text) {
    let hash = 2166136261;
    const source = String(text || "");
    for (let i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeIdentityText(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function sourceName(url, title = "") {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host === "claude.ai" || host.endsWith(".claude.ai")) return "Claude";
      if (host === "chatgpt.com" || host === "chat.openai.com" || host.endsWith(".openai.com")) return "ChatGPT";
      if (host) return host;
    } catch {}
    if (/claude/i.test(title)) return "Claude";
    if (/chatgpt|openai/i.test(title)) return "ChatGPT";
    return "공유";
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt");
          store.createIndex("hash", "hash", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result.sort((a,b) => a.createdAt - b.createdAt));
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function dbPut(card) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(card);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function dbPutMany(cards) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const card of cards) store.put(card);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  function parseOne(raw, fallbackTitle = "수학 풀이") {
    let inner = String(raw || "").trim();
    const start = inner.indexOf(START);
    const end = inner.lastIndexOf(END);
    if (start >= 0) inner = inner.slice(start + START.length, end > start ? end : undefined).trim();
    inner = inner.replace(/^```(?:text|markdown|math)?\s*/i, "").replace(/\s*```$/, "").trim();
    const lines = inner.split(/\r?\n/);
    let title = fallbackTitle || "수학 풀이";
    const titleIndex = lines.findIndex((line) => /^#{1,6}\s+/.test(line.trim()));
    if (titleIndex >= 0) {
      title = lines[titleIndex].trim().replace(/^#{1,6}\s+/, "").trim() || title;
      lines.splice(titleIndex, 1);
    }
    const body = lines.join("\n").trim();
    return { title, body, raw: String(raw || "").trim() };
  }

  function parseSharedText(text, fallbackTitle = "수학 풀이") {
    const source = String(text || "").trim();
    if (!source) return [];
    const blocks = [];
    const regex = /MATHPANEL_V1[\s\S]*?END_MATHPANEL/g;
    let match;
    while ((match = regex.exec(source)) !== null) blocks.push(parseOne(match[0], fallbackTitle));
    if (blocks.length) return blocks;
    return [parseOne(source, fallbackTitle)];
  }

  function normalizeMathMarkers(text) {
    return String(text || "")
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
      .replace(/[₩￦¥＼](?=\s*(?:[\[\]\(\)]|begin\{|end\{|text\{|Downarrow\b|Uparrow\b|rightarrow\b|left\b|right\b|mu\b|varpi\b|mathscr\b|chi\b|Gamma\b|zeta\b|operatorname\b|frac\b|sum\b|int\b))/g, "\\");
  }

  function normalizeMathTex(tex) {
    return String(tex || "").replace(/[₩￦¥＼]/g, "\\").replace(/\\_/g, "_");
  }

  function tokenizeSingleDollarMath(text) {
    const tokens = [];
    const source = String(text || "");
    let cursor = 0, i = 0;
    const escaped = (index) => {
      let slashes = 0;
      for (let j = index - 1; j >= 0 && source[j] === "\\"; j -= 1) slashes += 1;
      return slashes % 2 === 1;
    };
    while (i < source.length) {
      if (source[i] !== "$" || escaped(i) || source[i + 1] === "$" || source[i - 1] === "$") { i += 1; continue; }
      const open = i;
      let close = -1;
      i += 1;
      while (i < source.length && source[i] !== "\n") {
        if (source[i] === "$" && !escaped(i) && source[i + 1] !== "$" && source[i - 1] !== "$") { close = i; break; }
        i += 1;
      }
      if (close < 0) { i = open + 1; continue; }
      const tex = source.slice(open + 1, close);
      if (!tex.trim()) { i = close + 1; continue; }
      if (open > cursor) tokens.push({ type:"text", value:source.slice(cursor, open) });
      tokens.push({ type:"math", value:normalizeMathTex(tex), display:false });
      cursor = close + 1; i = close + 1;
    }
    if (cursor < source.length) tokens.push({ type:"text", value:source.slice(cursor) });
    return tokens.length ? tokens : [{ type:"text", value:source }];
  }

  function tokenizeBareMathEnvironments(text) {
    const tokens = [];
    const environments = "gathered|aligned|alignedat|split|cases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|array|equation\\*?|align\\*?|multline\\*?";
    const regex = new RegExp(String.raw`(?:\\+\s*\[\s*)?(\\+begin\{(${environments})\}[\s\S]*?\\+end\{\2\})(?:\s*\\+\s*\])?`, "g");
    let cursor = 0, match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > cursor) tokens.push({ type:"text", value:text.slice(cursor, match.index) });
      const tex = normalizeMathTex(match[1]).replace(/^\\+begin/, "\\begin").replace(/\\+end(?=\{[^{}]+\}\s*$)/, "\\end");
      tokens.push({ type:"math", value:tex, display:true });
      cursor = regex.lastIndex;
    }
    if (cursor < text.length) tokens.push({ type:"text", value:text.slice(cursor) });
    return tokens;
  }

  function tokenizeMath(text) {
    const source = normalizeMathMarkers(text);
    const primary = [];
    const regex = /\\+\s*\[([\s\S]*?)\\+\s*\]|\\+\s*\(([\s\S]*?)\\+\s*\)|\$\$([\s\S]*?)\$\$/g;
    let cursor = 0, match;
    while ((match = regex.exec(source)) !== null) {
      if (match.index > cursor) primary.push({ type:"text", value:source.slice(cursor, match.index) });
      if (match[1] !== undefined) primary.push({ type:"math", value:normalizeMathTex(match[1]), display:true });
      else if (match[2] !== undefined) primary.push({ type:"math", value:normalizeMathTex(match[2]), display:false });
      else primary.push({ type:"math", value:normalizeMathTex(match[3]), display:true });
      cursor = regex.lastIndex;
    }
    if (cursor < source.length) primary.push({ type:"text", value:source.slice(cursor) });
    const withDollars = [];
    for (const token of primary) withDollars.push(...(token.type === "math" ? [token] : tokenizeSingleDollarMath(token.value)));
    const out = [];
    for (const token of withDollars) out.push(...(token.type === "math" ? [token] : tokenizeBareMathEnvironments(token.value)));
    return out;
  }

  function cleanMarkdownText(text) {
    return String(text || "")
      .replace(/^(\s{0,3})#{1,6}[ \t]+/gm, "$1")
      .replace(/^(\s{0,3})>[ \t]?/gm, "$1› ")
      .replace(/^(\s*)[-+*][ \t]+/gm, "$1• ")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/__([^_\n]+)__/g, "$1")
      .replace(/~~([^~\n]+)~~/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1");
  }

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function renderMathInto(placeholder, tex, display) {
    try {
      await withTimeout(globalThis.MathJax.startup.promise, 8000, "MathJax startup");
      const node = await withTimeout(globalThis.MathJax.tex2svgPromise(tex, { display }), 8000, "MathJax render");
      const merror = node?.querySelector?.('[data-mjx-error], [data-mml-node="merror"]');
      if (merror) throw new Error(merror.getAttribute?.("data-mjx-error") || merror.textContent || "TeX parse error");
      placeholder.replaceChildren(node);
      placeholder.classList.remove("math-loading");
    } catch (error) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "수식 렌더링 오류 · LaTeX 보기";
      const pre = document.createElement("pre");
      pre.textContent = display ? `\\[\n${tex}\n\\]` : `\\(${tex}\\)`;
      details.append(summary, pre);
      placeholder.replaceChildren(details);
      placeholder.classList.remove("math-loading");
      placeholder.classList.add("math-error");
      placeholder.title = String(error?.message || error);
    }
  }

  function renderBody(record) {
    if (record.rendered || record.collapsed) return;
    record.rendered = true;
    record.body.replaceChildren();
    for (const token of tokenizeMath(record.data.body)) {
      if (token.type === "text") {
        record.body.appendChild(document.createTextNode(cleanMarkdownText(token.value)));
      } else {
        const el = document.createElement(token.display ? "div" : "span");
        el.className = `${token.display ? "display-math" : "inline-math"} math-loading`;
        el.dataset.mathsidecarTex = token.value;
        el.dataset.mathsidecarDisplay = token.display ? "1" : "0";
        el.textContent = token.display ? "수식 렌더링 중…" : "…";
        record.body.appendChild(el);
        renderMathInto(el, token.value, token.display);
      }
    }
  }

  function releaseBody(record) {
    if (!record.rendered) return;
    record.rendered = false;
    record.body.replaceChildren();
  }

  async function setCollapsed(record, collapsed, persist = true) {
    if (!record) return;
    record.collapsed = Boolean(collapsed);
    record.data.collapsed = record.collapsed;
    record.card.classList.toggle("collapsed", record.collapsed);
    record.body.hidden = record.collapsed;
    record.header.setAttribute("aria-expanded", String(!record.collapsed));
    record.chevron.textContent = record.collapsed ? "▸" : "▾";
    record.header.title = record.collapsed ? "눌러서 이 답변 펼치기" : "눌러서 이 답변 접기";
    if (record.collapsed) releaseBody(record); else renderBody(record);
    if (persist) await dbPut(record.data);
  }

  function scrollRecordStart(record, behavior = "smooth") {
    if (!record?.card) return;
    const listRect = list.getBoundingClientRect();
    const rect = record.card.getBoundingClientRect();
    list.scrollTo({ top: Math.max(0, list.scrollTop + rect.top - listRect.top), behavior });
  }

  async function copyText(text, okMessage = "복사했습니다.") {
    try {
      await navigator.clipboard.writeText(text);
      showToast(okMessage);
      return true;
    } catch {
      showToast("클립보드에 복사하지 못했습니다.");
      return false;
    }
  }

  function makeRecord(data) {
    const card = document.createElement("section");
    card.className = "card";
    card.dataset.cardId = data.id;

    const header = document.createElement("div");
    header.className = "card-header";
    header.tabIndex = 0;
    header.setAttribute("role", "button");

    const heading = document.createElement("div");
    heading.className = "card-heading";
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    const metaStack = document.createElement("div");
    metaStack.className = "meta-stack";
    const metaLine = document.createElement("div");
    metaLine.className = "meta-line";
    const label = document.createElement("span");
    label.className = "answer-label";
    label.textContent = `답변 ${data.answerIndex}`;
    const source = document.createElement("span");
    source.className = "source-badge";
    source.textContent = data.sourceName || "공유";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = data.title;
    metaLine.append(label, source);
    metaStack.append(metaLine, title);
    heading.append(chevron, metaStack);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const sourceLink = document.createElement("button");
    sourceLink.type = "button";
    sourceLink.className = "source-link";
    sourceLink.textContent = "대화";
    sourceLink.disabled = !data.sourceUrl;
    sourceLink.title = data.sourceUrl ? "공유된 원본 주소 열기" : "공유된 원본 주소가 없습니다";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "TeX 복사";
    actions.append(sourceLink, copy);
    header.append(heading, actions);

    const body = document.createElement("div");
    body.className = "card-body";
    card.append(header, body);
    list.appendChild(card);

    const record = { id:data.id, data, card, header, body, chevron, title, rendered:false, collapsed:Boolean(data.collapsed) };
    records.set(record.id, record);

    header.addEventListener("click", (event) => {
      if (event.target.closest("button,a,input,textarea,select")) return;
      setCollapsed(record, !record.collapsed);
    });
    header.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target.closest("button,a,input,textarea,select")) return;
      event.preventDefault();
      setCollapsed(record, !record.collapsed);
    });
    sourceLink.addEventListener("click", () => {
      if (record.data.sourceUrl) window.open(record.data.sourceUrl, "_blank", "noopener,noreferrer");
    });
    copy.addEventListener("click", async () => {
      const old = copy.textContent;
      if (await copyText(record.data.raw, "TeX를 복사했습니다.")) {
        copy.textContent = "복사됨";
        setTimeout(() => { copy.textContent = old; }, 900);
      }
    });

    setCollapsed(record, record.collapsed, false);
    return record;
  }

  function updateCounts() {
    count.textContent = String(order.length);
    empty.hidden = order.length > 0;
  }

  async function loadCards() {
    const cards = await dbAll();
    for (const data of cards) {
      order.push(data.id);
      makeRecord(data);
    }
    updateCounts();
    if (order.length) {
      const latest = records.get(order[order.length - 1]);
      setTimeout(() => scrollRecordStart(latest, "auto"), 0);
    }
  }

  async function addIncoming(text, sourceUrl = "", sharedTitle = "") {
    const parsed = parseSharedText(text, sharedTitle || "수학 풀이");
    if (!parsed.length) { showToast("가져올 텍스트가 없습니다."); return; }

    const existing = await dbAll();
    const existingByHash = new Map(existing.map((c) => [c.hash, c]));
    let answerIndex = existing.reduce((m, c) => Math.max(m, Number(c.answerIndex) || 0), 0);
    const changed = [];

    for (const old of existing) {
      if (!old.collapsed) {
        old.collapsed = true;
        changed.push(old);
        const rec = records.get(old.id);
        if (rec) await setCollapsed(rec, true, false);
      }
    }

    let lastNew = null;
    for (const item of parsed) {
      const identity = normalizeIdentityText(item.raw || item.body);
      const hash = stableHash(identity);
      const duplicate = existingByHash.get(hash);
      if (duplicate) {
        const rec = records.get(duplicate.id);
        if (rec) {
          await setCollapsed(rec, false, false);
          duplicate.collapsed = false;
          duplicate.sourceUrl = duplicate.sourceUrl || sourceUrl;
          duplicate.sourceName = duplicate.sourceName || sourceName(sourceUrl, sharedTitle);
          changed.push(duplicate);
          lastNew = rec;
        }
        continue;
      }

      answerIndex += 1;
      const now = Date.now() + answerIndex;
      const data = {
        id: `card-${now}-${hash}`,
        hash,
        answerIndex,
        title: item.title || sharedTitle || "수학 풀이",
        body: item.body,
        raw: item.raw,
        sourceUrl,
        sourceName: sourceName(sourceUrl, sharedTitle),
        createdAt: now,
        updatedAt: now,
        collapsed: false
      };
      const rec = makeRecord(data);
      order.push(data.id);
      existingByHash.set(hash, data);
      changed.push(data);
      lastNew = rec;
    }

    await dbPutMany(changed);
    updateCounts();
    if (lastNew) setTimeout(() => scrollRecordStart(lastNew, "smooth"), 0);
    showToast(parsed.length > 1 ? `${parsed.length}개 답변을 가져왔습니다.` : "답변을 가져왔습니다.");
  }

  async function probeMathJax() {
    try {
      await withTimeout(globalThis.MathJax.startup.promise, 5000, "MathJax startup");
      const probe = await withTimeout(globalThis.MathJax.tex2svgPromise("x^2+1", { display:false }), 5000, "MathJax test");
      if (!probe?.querySelector?.("svg")) throw new Error("No SVG");
      renderer.textContent = "MJ ✓";
    } catch (error) {
      renderer.textContent = "MJ ✕";
      renderer.title = String(error?.message || error);
    }
  }

  function clearHighlights() {
    for (const el of highlightedMath) el.classList.remove("selection-highlight", "drag-highlight");
    highlightedMath.clear();
  }

  function selectedBody(range) {
    const start = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest?.(".card-body");
    const end = (range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement)?.closest?.(".card-body");
    return start && start === end ? start : null;
  }

  function serializeSelection(range, body) {
    const chunks = [];
    for (const child of body.childNodes) {
      try { if (!range.intersectsNode(child)) continue; } catch { continue; }
      if (child.nodeType === Node.TEXT_NODE) {
        let a = 0, b = (child.textContent || "").length;
        if (range.startContainer === child) a = range.startOffset;
        if (range.endContainer === child) b = range.endOffset;
        chunks.push((child.textContent || "").slice(a, b));
      } else if (child.nodeType === Node.ELEMENT_NODE && child.dataset?.mathsidecarTex !== undefined) {
        const tex = child.dataset.mathsidecarTex;
        const display = child.dataset.mathsidecarDisplay === "1";
        chunks.push(display ? `\n\\[\n${tex}\n\\]\n` : `\\(${tex}\\)`);
      }
    }
    return chunks.join("").replace(/\n{3,}/g, "\n\n").trim();
  }

  function positionAsk(rect) {
    const w = askPopup.offsetWidth || 110, h = askPopup.offsetHeight || 38, m = 8;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(m, Math.min(left, innerWidth - w - m));
    let top = rect.bottom + 8;
    if (top + h > innerHeight - m) top = rect.top - h - 8;
    askPopup.style.left = `${Math.round(left)}px`;
    askPopup.style.top = `${Math.max(m, Math.round(top))}px`;
  }

  function updateSelection() {
    clearHighlights();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) { askPopup.hidden = true; pendingSelection = null; return; }
    const range = sel.getRangeAt(0), body = selectedBody(range);
    if (!body) { askPopup.hidden = true; pendingSelection = null; return; }
    for (const math of body.querySelectorAll(".display-math,.inline-math")) {
      try { if (range.intersectsNode(math)) { math.classList.add("selection-highlight"); highlightedMath.add(math); } } catch {}
    }
    const text = serializeSelection(range, body);
    if (!text) { askPopup.hidden = true; return; }
    const title = body.closest(".card")?.querySelector(".card-title")?.textContent?.trim() || "수학 풀이";
    pendingSelection = { text, title };
    askPopup.hidden = false;
    const rect = range.getBoundingClientRect();
    requestAnimationFrame(() => positionAsk(rect.width || rect.height ? rect : body.getBoundingClientRect()));
  }

  document.addEventListener("selectionchange", () => { clearTimeout(selectionTimer); selectionTimer = setTimeout(updateSelection, 100); });
  list.addEventListener("scroll", () => { askPopup.hidden = true; clearHighlights(); }, { passive:true });
  list.addEventListener("pointerdown", (event) => {
    const math = event.target.closest?.(".display-math,.inline-math");
    if (!math) { mathPointerStart = null; return; }
    clearHighlights();
    math.classList.add("drag-highlight");
    highlightedMath.add(math);
    mathPointerStart = { math, x:event.clientX, y:event.clientY };
  }, true);
  list.addEventListener("pointerup", (event) => {
    if (!mathPointerStart) return;
    const { math, x, y } = mathPointerStart;
    mathPointerStart = null;
    if (Math.hypot(event.clientX - x, event.clientY - y) < 4) { clearHighlights(); return; }
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        clearHighlights();
        math.classList.add("selection-highlight");
        highlightedMath.add(math);
        const tex = math.dataset.mathsidecarTex;
        const display = math.dataset.mathsidecarDisplay === "1";
        const text = display ? `\\[\n${tex}\n\\]` : `\\(${tex}\\)`;
        const title = math.closest(".card")?.querySelector(".card-title")?.textContent?.trim() || "수학 풀이";
        pendingSelection = { text, title };
        askPopup.hidden = false;
        positionAsk(math.getBoundingClientRect());
      }
    }, 0);
  }, true);

  document.getElementById("ask").addEventListener("pointerdown", (e) => e.preventDefault());
  document.getElementById("ask").addEventListener("click", async () => {
    if (!pendingSelection) return;
    const prompt = `「${pendingSelection.title}」에서 다음 부분을 설명해줘.\n\n${pendingSelection.text}`;
    askPopup.hidden = true;
    clearHighlights();
    await copyText(prompt, "질문을 복사했습니다. 채팅 탭에 붙여넣으세요.");
  });

  document.getElementById("start").addEventListener("click", () => copyText(START_PROMPT, "시작 프롬프트를 복사했습니다."));
  document.getElementById("latest").addEventListener("click", () => {
    const latest = records.get(order[order.length - 1]);
    if (latest) scrollRecordStart(latest, "smooth");
  });
  document.getElementById("collapse-all").addEventListener("click", async () => {
    const changed = [];
    for (const id of order) {
      const rec = records.get(id);
      if (rec && !rec.collapsed) {
        await setCollapsed(rec, true, false);
        changed.push(rec.data);
      }
    }
    if (changed.length) await dbPutMany(changed);
  });

  document.getElementById("import").addEventListener("click", () => {
    importText.value = "";
    importUrl.value = "";
    importDialog.showModal();
    setTimeout(() => importText.focus(), 50);
  });

  document.getElementById("paste").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { showToast("클립보드가 비어 있습니다."); return; }
      await addIncoming(text);
    } catch {
      importText.value = "";
      importUrl.value = "";
      importDialog.showModal();
      showToast("자동 붙여넣기가 막혀 있습니다. 직접 붙여넣으세요.", 2400);
    }
  });

  document.getElementById("import-form").addEventListener("submit", async (event) => {
    const submitter = event.submitter;
    if (submitter?.value === "cancel") return;
    event.preventDefault();
    const text = importText.value;
    if (!text.trim()) { showToast("가져올 텍스트를 입력하세요."); return; }
    await addIncoming(text, importUrl.value.trim());
    importDialog.close();
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    document.getElementById("install").hidden = false;
  });
  document.getElementById("install").addEventListener("click", async () => {
    if (!deferredInstallPrompt) { showToast("브라우저 메뉴에서 ‘홈 화면에 추가/앱 설치’를 선택하세요."); return; }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById("install").hidden = true;
  });

  async function receiveShareFromUrl() {
    const params = new URLSearchParams(location.search);
    const id = params.get("share");
    if (!id) return;
    try {
      const response = await fetch(`./__share__/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error("share not found");
      const payload = await response.json();
      await addIncoming(payload.text || payload.title || "", payload.url || "", payload.title || "");
      navigator.serviceWorker.controller?.postMessage({ type:"delete-share", id });
      history.replaceState(null, "", "./index.html");
    } catch {
      showToast("공유된 내용을 불러오지 못했습니다.");
    }
  }

  async function init() {
    probeMathJax();
    if ("serviceWorker" in navigator) {
      try { await navigator.serviceWorker.register("./sw.js", { scope:"./" }); } catch (error) { console.warn("Service worker registration failed", error); }
    }
    try { await navigator.storage?.persist?.(); } catch {}
    await loadCards();
    await receiveShareFromUrl();
  }

  init();
})();

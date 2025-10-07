// ===== Logging =====
function log(msg) {
  const el = document.getElementById("log");
  el.value += msg + "\n";
  el.scrollTop = el.scrollHeight;
}


// ===== Storage (JSON-first) =====
const STORAGE_KEY = "pplx_csv_runner_results_json";
async function loadResults() {
  const data = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
  return data;
}
async function saveResultJSON(entry) {
  const data = await loadResults();
  data.push(entry);
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}
async function clearResults() { await chrome.storage.local.set({ [STORAGE_KEY]: [] }); }
function toCSV(rows) {
  const esc = (s) => {
    const t = (s ?? "").toString();
    if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const header = ["question","answer","timestamp"];
  const lines = [header.join(",")];
  for (const r of rows) lines.push([esc(r.question), esc(r.answer), esc(r.timestamp)].join(","));
  return lines.join("\n");
}
function download(filename, content, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


// ===== Tab helpers =====
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function ensurePerplexity() {
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    const url = new URL(tab.url || "about:blank");
    if (!/(\.)?perplexity\.ai$/.test(url.hostname)) {
      await chrome.tabs.update(tab.id, { url: "https://www.perplexity.ai/" });
    }
  } catch {
    const t = await getActiveTab();
    if (t?.id) await chrome.tabs.update(t.id, { url: "https://www.perplexity.ai/" });
  }
}


// ===== Injected: robust DOM submit + wait-for-completion =====
function domSubmitAndWaitComplete(q, selectors) {
  const {
    inputCandidates,
    submitCandidates,
    formCandidates,
    messagesContainerSel,
    assistantMsgCandidates,
    streamingClass,
    finalizeDelayMs
  } = selectors;

  function visible(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }

  function queryAllDeep(selector) {
    const out = [];
    const walker = (root) => {
      const nodes = root.querySelectorAll(selector);
      nodes.forEach(n => out.push(n));
      const tree = root.querySelectorAll("*");
      tree.forEach(n => { if (n.shadowRoot) walker(n.shadowRoot); });
    };
    walker(document);
    return out;
  }

  function findFirstVisible(selectors) {
    for (const sel of selectors) {
      const list = queryAllDeep(sel);
      for (const el of list) if (visible(el)) return el;
    }
    for (const sel of selectors) {
      const list = queryAllDeep(sel);
      if (list.length) return list[0];
    }
    return null;
  }

  function getLastAssistantMessage() {
    const container = document.querySelector(messagesContainerSel) || document;
    for (const sel of assistantMsgCandidates) {
      const list = container.querySelectorAll(sel);
      if (list && list.length) return list[list.length - 1];
    }
    return null;
  }

  function waitForStreamingToFinish(timeoutMs = 120000) {
    return new Promise((resolve) => {
      const start = Date.now();
      let lastText = "";
      let stableTimer = null;
      const targetGetter = () => getLastAssistantMessage();

      const observer = new MutationObserver(() => {
        const el = targetGetter();
        if (!el) return;
        if (streamingClass && el.closest(`.${streamingClass}`)) return;
        const t = el.innerText || "";
        if (t !== lastText) {
          lastText = t;
          if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
          stableTimer = setTimeout(() => { observer.disconnect(); resolve(el); }, finalizeDelayMs || 1400);
        }
      });

      lastText = (targetGetter()?.innerText || "");
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

      const timer = setInterval(() => {
        if (Date.now() - start > timeoutMs) {
          observer.disconnect();
          if (stableTimer) clearTimeout(stableTimer);
          resolve(targetGetter());
          clearInterval(timer);
        }
      }, 600);
    });
  }

  function setInputValue(input, value) {
    if (!input) return;
    input.focus();
    if (input.scrollIntoView) input.scrollIntoView({ behavior: "smooth", block: "center" });

    const isCE = (input.tagName === "DIV" && input.getAttribute("contenteditable") === "true");
    if (isCE) {
      input.textContent = "";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward" }));
      input.textContent = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: value, inputType: "insertText" }));
      try { document.execCommand && document.execCommand("insertText", false, ""); } catch {}
    } else {
      const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, value); else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function tryClickSubmit() {
    const btn = findFirstVisible(submitCandidates);
    if (btn) { btn.click(); return true; }
    return false;
  }

  function trySubmitForm(input) {
    const form = input?.closest("form") || findFirstVisible(formCandidates);
    if (form) {
      if (typeof form.requestSubmit === "function") { form.requestSubmit(); return true; }
      if (typeof form.submit === "function") { form.submit(); return true; }
      const ok = form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return ok;
    }
    return false;
  }

  function sendKeys(input) {
    input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertParagraph" }));
    const variants = [
      { key: "Enter", code: "Enter", keyCode: 13, which: 13, ctrlKey: false, metaKey: false, shiftKey: false },
      { key: "Enter", code: "Enter", keyCode: 13, which: 13, ctrlKey: true, metaKey: false, shiftKey: false },
      { key: "Enter", code: "Enter", keyCode: 13, which: 13, ctrlKey: false, metaKey: true, shiftKey: false }
    ];
    for (const kv of variants) {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...kv }));
      input.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, ...kv }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, ...kv }));
    }
  }

  async function strongDomSubmit() {
    const input = findFirstVisible(inputCandidates);
    if (!input) return { ok: false, reason: "input_not_found" };
    setInputValue(input, q);

    if (tryClickSubmit()) return { ok: true, via: "button" };
    if (trySubmitForm(input)) return { ok: true, via: "form" };
    sendKeys(input);
    setTimeout(() => { tryClickSubmit(); }, 50);
    return { ok: true, via: "keyboard" };
  }

  return strongDomSubmit().then(async (res) => {
    if (!res.ok) return res;
    const el = await waitForStreamingToFinish(120000);
    const answerText = el?.innerText?.trim() || "";
    return { ok: true, answer: answerText };
  });
}


// ===== UI + CSV parsing =====
let rows = [];
let index = 0;
let stopped = false;

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(",");
    const obj = {};
    headers.forEach((h, i) => obj[h] = (cols[i] ?? "").trim());
    return obj;
  });
}

const fileEl = document.getElementById('csvFile');
fileEl.addEventListener('click', (e) => { e.target.value = null; });
fileEl.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    rows = parseCSV(text);
    log(`Loaded ${rows.length} rows.`);
  } catch (err) { log("Error reading file: " + String(err)); }
});

document.getElementById("openPPLX").addEventListener("click", async () => {
  await ensurePerplexity();
  log("Perplexity opened.");
});

document.getElementById("start").addEventListener("click", async () => {
  if (!rows.length) return log("No CSV loaded.");
  stopped = false;

  const delay = parseInt(document.getElementById("delay").value || "600", 10);
  const colInput = document.getElementById("column").value.trim();

  let getQ = (r) => r?.question ?? "";
  if (colInput) {
    const asIdx = parseInt(colInput, 10);
    if (!Number.isNaN(asIdx)) {
      getQ = (r) => { const arr = Object.values(r); return (arr[asIdx] ?? "").toString(); };
    } else {
      getQ = (r) => (r?.[colInput] ?? "").toString();
    }
  }

  await ensurePerplexity();

  const selectors = {
    inputCandidates: [
      "textarea[placeholder*='Ask']",
      "textarea[aria-label*='Ask']",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']",
      "form textarea",
      "form input[type='text']",
      "textarea",
      "input[type='text']"
    ],
    submitCandidates: [
      "button[data-testid='submit-button']",
      "button[type='submit']",
      "button[aria-label*='Search']",
      "button[aria-label*='Send']",
      "button[data-testid*='send']",
      "form button[type='submit']"
    ],
    formCandidates: [
      "form[action*='search']",
      "form"
    ],
    messagesContainerSel: "[data-testid*='conversation'], main, body",
    assistantMsgCandidates: [
      "[data-testid*='message'][data-role='assistant']",
      "[data-testid*='message']:not([data-role='user'])",
      "article",
      ".prose"
    ],
    streamingClass: "",
    finalizeDelayMs: 1500
  };

  for (; index < rows.length; index++) {
    if (stopped) break;
    const q = (getQ(rows[index]) || "").trim();
    if (!q) { log(`Row ${index + 1}: empty question, skipping.`); continue; }

    log(`Submitting (same session): ${q}`);
    const tab = await getActiveTab();
    if (!tab?.id) { log("No active tab."); break; }

    // Wait to let previous UI settle
    await new Promise(r => setTimeout(r, 2000));

    let result = null;
    try {
      const [{ result: res }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: domSubmitAndWaitComplete,
        args: [q, selectors]
      });
      result = res;
    } catch (e) {
      log(`Injection error: ${String(e)}`);
      result = { ok: false, reason: String(e) };
    }

    let answer = "";
    if (result?.ok) {
      answer = result.answer || "";
      const preview = answer.length > 160 ? answer.slice(0, 160) + "..." : answer;
      log(`Answer finalized (${answer.length} chars): ${preview}`);
    } else {
      log(`Answer capture failed: ${result?.reason || "unknown"}`);
    }

    await saveResultJSON({ question: q, answer, timestamp: new Date().toISOString() });

    // Pause before next iteration
    await new Promise(r => setTimeout(r, delay));
  }

  log("Done (same session).");
});

document.getElementById("stop").addEventListener("click", () => { stopped = true; log("Stopped."); });

document.getElementById("exportCSV").addEventListener("click", () => {
  loadResults().then(data => {
    download("perplexity_results.csv", toCSV(data), "text/csv");
  });
});

document.getElementById("exportJSON").addEventListener("click", () => {
  loadResults().then(data => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: "perplexity_results.json"
    });
  });
});

document.getElementById("clearResults").addEventListener("click", async () => {
  await clearResults();
  log("Results cleared.");
});

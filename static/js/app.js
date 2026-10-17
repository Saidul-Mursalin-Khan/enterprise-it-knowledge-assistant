/* ===== Config: edit this block to adapt the template ===== */
const CONFIG = {
  chat: "/api/chat",
  health: "/api/health",
  ingest: "/api/ingest",
  maxLen: 3000,
  prompts: [
    { t: "Connect to the VPN", q: "How do I connect to the company VPN from home?", n: "Answered from company documents" },
    { t: "MFA policy", q: "Can IT support ask me to share my MFA code?", n: "Company policy lookup" },
    { t: "Teams outage", q: "What is the latest Microsoft Teams outage guidance?", n: "Needs current public information" },
    { t: "Vague question", q: "My work communication app is acting strange after the new update. What should I do?", n: "Triggers a query rewrite and retry" },
  ],
};

const SOURCES = {
  kb: { label: "Company knowledge base" },
  web: { label: "Public web search", note: "This answer comes from the public web, not from company documents. Confirm with IT before acting on it." },
  direct: { label: "Direct reply" },
  none: { label: "Not enough evidence", note: "I couldn’t find a reliable answer. Try rephrasing, or contact the service desk." },
};

const $ = (s) => document.querySelector(s);
const el = { feed: $("#feed"), msgs: $("#msgs"), welcome: $("#welcome"), input: $("#input"), send: $("#send"), count: $("#count"), side: $("#side") };
let busy = false;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const srcKey = (s = "") => (/private|kb/i.test(s) ? "kb" : /web|tavily|external/i.test(s) ? "web" : /direct/i.test(s) ? "direct" : "none");

/* Small, safe markdown renderer (escapes HTML first) */
function md(src) {
  const blocks = [];
  let t = esc(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, l, c) => { blocks.push(`<pre><code>${c.trim()}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
       .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = []; let list = null;
  for (const line of t.split("\n")) {
    const ul = line.match(/^\s*[-*]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/), kind = ul ? "ul" : ol ? "ol" : null;
    if (kind) { if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; } out.push(`<li>${(ul || ol)[1]}</li>`); continue; }
    if (list) { out.push(`</${list}>`); list = null; }
    const h = line.match(/^#{1,4}\s+(.*)/);
    out.push(h ? `<h4>${h[1]}</h4>` : line.trim() ? `<p>${line}</p>` : "");
  }
  if (list) out.push(`</${list}>`);
  return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

function toast(text, bad) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : ""); t.textContent = text;
  $("#toasts").append(t); setTimeout(() => t.remove(), 4500);
}

const scrollDown = () => el.feed.scrollTo({ top: el.feed.scrollHeight, behavior: "smooth" });
const add = (html, cls) => { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; el.msgs.append(d); scrollDown(); return d; };

function addUser(q) { const d = add("", "m user"); d.textContent = q; scrollDown(); }

function addPending() {
  const steps = ["Routing your question", "Searching company documents", "Checking the evidence"];
  const d = add(`<div class="pending"><span class="pulse"><i></i><i></i><i></i></span><span class="st">${steps[0]}</span></div>`, "m bot none");
  let i = 0; const id = setInterval(() => { i = Math.min(i + 1, steps.length - 1); d.querySelector(".st").textContent = steps[i]; }, 1800);
  d.stop = () => { clearInterval(id); d.remove(); };
  return d;
}

function citeHTML(c) {
  if (typeof c === "string") return /^https?:/.test(c) ? `<a class="cite" href="${esc(c)}" target="_blank" rel="noopener noreferrer">${esc(c)}</a>` : `<span class="cite">${esc(c)}</span>`;
  const label = esc(c.title || c.source || c.url || "Source"), url = c.url || (/^https?:/.test(c.source || "") ? c.source : "");
  return url ? `<a class="cite" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<span class="cite">${label}</span>`;
}

function addBot(d, question) {
  const k = srcKey(d.source_used), s = SOURCES[k], trace = d.trace || [], cites = d.citations || [];
  const rewritten = d.rewritten_query && d.rewritten_query.trim() !== question.trim() ? d.rewritten_query : "";
  const steps = trace.map((t, i) => {
    const cls = /good/i.test(t) ? "good" : /weak/i.test(t) ? "weak" : "";
    return `<li class="${cls}">${esc(t)}</li>`;
  }).join("");
  const m = add(`
    <div class="bot-head"><span class="badge"><i class="dot" style="background:var(--c)"></i>${s.label}</span><button class="copy" type="button">Copy</button></div>
    <div class="body">${md(d.answer || "")}</div>
    ${s.note && k !== "none" || k === "none" && !d.answer ? `<div class="note">${s.note}</div>` : ""}
    ${rewritten ? `<p class="rewrite">I searched again using a clearer question: <em>${esc(rewritten)}</em></p>` : ""}
    ${cites.length ? `<div class="cites">${cites.map(citeHTML).join("")}</div>` : ""}
    ${trace.length ? `<details class="path" open><summary>Decision path (${trace.length} steps)</summary><ol class="route">${steps}</ol></details>` : ""}`,
    `m bot ${k}`);
  m.querySelector(".copy").onclick = (e) => { navigator.clipboard?.writeText(d.answer || ""); e.target.textContent = "Copied"; setTimeout(() => (e.target.textContent = "Copy"), 1500); };
}

function addError(msg, q) {
  const m = add(`<div class="badge"><i class="dot" style="background:var(--c)"></i>Something went wrong</div><div class="body"><p>${esc(msg)}</p></div><button class="retry" type="button">Try again</button>`, "m bot err");
  m.querySelector(".retry").onclick = () => { m.remove(); send(q, true); };
}

async function send(q, retry) {
  q = q.trim();
  if (q.length < 2 || busy) return;
  busy = true; el.welcome.hidden = true;
  if (!retry) addUser(q);
  el.input.value = ""; resize();
  const p = addPending();
  try {
    const r = await fetch(CONFIG.chat, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : `Request failed (${r.status})`);
    p.stop(); addBot(d, q);
  } catch (e) { p.stop(); addError(e.message, q); }
  finally { busy = false; resize(); el.input.focus(); }
}

/* Composer */
function resize() {
  el.input.style.height = "auto"; el.input.style.height = el.input.scrollHeight + "px";
  const n = el.input.value.trim().length;
  el.count.textContent = `${el.input.value.length}/${CONFIG.maxLen}`;
  el.send.disabled = n < 2 || busy;
}
el.input.addEventListener("input", resize);
el.input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(el.input.value); } });
$("#composer").addEventListener("submit", (e) => { e.preventDefault(); send(el.input.value); });

/* Suggested questions */
$("#asks").innerHTML = CONFIG.prompts.map((p, i) => `<button class="ask" type="button" data-i="${i}"><b>${esc(p.t)}</b><span>${esc(p.q)}</span><span>${esc(p.n)}</span></button>`).join("");
$("#asks").addEventListener("click", (e) => { const b = e.target.closest(".ask"); if (b) send(CONFIG.prompts[b.dataset.i].q); });

/* New chat, sidebar, theme */
$("#newChat").onclick = () => { if (busy) return; el.msgs.innerHTML = ""; el.welcome.hidden = false; el.side.classList.remove("open"); el.input.focus(); };
$("#menu").onclick = () => el.side.classList.add("open");
$("#backdrop").onclick = () => el.side.classList.remove("open");
const root = document.documentElement;
try { root.dataset.theme = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } catch {}
$("#theme").onclick = () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; try { localStorage.setItem("theme", root.dataset.theme); } catch {} };

/* Service health */
async function health() {
  const s = $("#status");
  try { const r = await fetch(CONFIG.health); if (!r.ok) throw 0; const d = await r.json(); s.className = "status ok"; $("#statusText").textContent = "Service online"; s.title = d.service || ""; }
  catch { s.className = "status down"; $("#statusText").textContent = "Service unreachable"; }
}
health(); setInterval(health, 30000);

/* Document upload */
const file = $("#file"), drop = $("#drop"), up = $("#upload");
const dropHTML = drop.querySelector("#dropText").innerHTML;
const pick = (f) => { if (!f) return; const dt = new DataTransfer(); dt.items.add(f); file.files = dt.files; $("#dropText").textContent = f.name; up.disabled = false; };
file.onchange = () => pick(file.files[0]);
["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => pick(e.dataTransfer.files[0]));
$("#ingestForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!file.files[0]) return;
  const key = $("#adminKey").value;
  if (!key) return toast("Enter the admin key to upload.", true);
  const fd = new FormData(); fd.append("file", file.files[0]);
  up.disabled = true; up.textContent = "Indexing…";
  try {
    const r = await fetch(CONFIG.ingest, { method: "POST", headers: { "X-Admin-Key": key }, body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? "The admin key is not valid." : typeof d.detail === "string" ? d.detail : `Upload failed (${r.status})`);
    toast(`${d.file} indexed: ${d.chunks} chunks added.`);
    file.value = ""; $("#dropText").innerHTML = dropHTML;
  } catch (err) { toast(err.message, true); up.disabled = false; }
  finally { up.textContent = "Upload and index"; if (!file.files[0]) up.disabled = true; }
});

resize();
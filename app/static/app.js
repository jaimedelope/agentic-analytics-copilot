const messagesEl = document.getElementById("messages");
const traceEl = document.getElementById("trace");
const citationsEl = document.getElementById("citations");
const statusEl = document.getElementById("status");
const form = document.getElementById("form");
const input = document.getElementById("input");
const examplesEl = document.getElementById("examples");

function addMessage(role, text, meta = "") {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `${meta ? `<span class="meta">${meta}</span>` : ""}${escapeHtml(text)}`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderTrace(payload) {
  const steps = payload.steps || [];
  if (!steps.length) {
    traceEl.className = "trace empty";
    traceEl.textContent = "No steps.";
    return;
  }
  traceEl.className = "trace";
  traceEl.innerHTML = steps
    .map((s) => {
      const sql = s.sql
        ? `<pre class="sql">${escapeHtml(s.sql)}</pre>`
        : s.rows_preview
          ? `<pre class="sql">${escapeHtml(JSON.stringify(s.rows_preview, null, 2))}</pre>`
          : "";
      return `<article class="step">
        <div class="who ${s.agent}">${s.agent} · ${s.action}</div>
        <div class="detail">${escapeHtml(s.detail)}</div>
        ${sql}
      </article>`;
    })
    .join("");

  const c = payload.critique || {};
  const cites = payload.citations || [];
  citationsEl.className = "citations";
  citationsEl.innerHTML = `
    <p><span class="pill ${c.confidence || "low"}">${c.confidence || "n/a"} confidence</span>
    · ${payload.latency_ms} ms · mode ${payload.mode}</p>
    <ul>${cites
      .map((x) => `<li><strong>${escapeHtml(x.label)}</strong><pre class="sql">${escapeHtml(x.sql || "")}</pre></li>`)
      .join("") || "<li>No citations</li>"}</ul>
  `;
}

async function ask(question) {
  addMessage("user", question);
  addMessage("assistant", "Running planner → SQL analyst → critic…", "copilot");
  const pending = messagesEl.lastChild;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    pending.remove();
    addMessage("assistant", data.answer, `copilot · ${data.mode}`);
    renderTrace(data);
  } catch (err) {
    pending.remove();
    addMessage("assistant", `Error: ${err.message}`);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  ask(q);
});

async function boot() {
  try {
    const health = await fetch("/api/health").then((r) => r.json());
    statusEl.textContent = health.status === "ok" ? "live · gold marts ready" : "degraded";
    statusEl.classList.toggle("live", health.status === "ok");
    const ex = await fetch("/api/examples").then((r) => r.json());
    examplesEl.innerHTML = (ex.examples || [])
      .map((q) => `<button type="button" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
      .join("");
    examplesEl.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => ask(btn.dataset.q));
    });
    addMessage(
      "assistant",
      "Ready. Ask about GMV, AOV, funnel conversion, LTV or revenue by country. Traces show every agent step."
    );
  } catch {
    statusEl.textContent = "offline";
  }
}

boot();

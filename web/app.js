/** Browser simulation of the multi-agent analytics copilot. */

const GOLD = {
  gmv: { gmv_eur: 48720.5, orders: 1184, aov_eur: 41.15 },
  conversion: {
    views: 9840,
    carts: 3210,
    checkouts: 1422,
    view_to_cart_pct: 32.6,
    view_to_checkout_pct: 14.5,
  },
  countries: [
    { country: "ES", revenue_eur: 11240, customers: 6, avg_ltv: 1873.3 },
    { country: "FR", revenue_eur: 9860, customers: 5, avg_ltv: 1972.0 },
    { country: "DE", revenue_eur: 8740, customers: 4, avg_ltv: 2185.0 },
    { country: "US", revenue_eur: 7120, customers: 4, avg_ltv: 1780.0 },
    { country: "GB", revenue_eur: 5340, customers: 3, avg_ltv: 1780.0 },
  ],
  customers: [
    { customer_id: "cus_a105", country: "IT", orders_count: 9, lifetime_revenue_eur: 1540 },
    { customer_id: "cus_a102", country: "DE", orders_count: 8, lifetime_revenue_eur: 1422 },
    { customer_id: "cus_a108", country: "ES", orders_count: 7, lifetime_revenue_eur: 1310 },
  ],
  trend: [
    { order_date: "2026-10-30", orders_count: 52, revenue_eur: 2140, avg_order_value: 41.15 },
    { order_date: "2026-10-31", orders_count: 58, revenue_eur: 2380, avg_order_value: 41.03 },
    { order_date: "2026-11-01", orders_count: 61, revenue_eur: 2510, avg_order_value: 41.15 },
    { order_date: "2026-11-02", orders_count: 64, revenue_eur: 2688, avg_order_value: 42.0 },
  ],
};

const TEMPLATES = {
  gmv: {
    label: "Gross merchandise value",
    sql: "select round(sum(revenue_eur),2) as gmv_eur, sum(orders_count) as orders, round(sum(revenue_eur)/sum(orders_count),2) as aov_eur from gold.revenue_daily",
    rows: [GOLD.gmv],
  },
  aov: {
    label: "Average order value",
    sql: "select round(sum(revenue_eur)/sum(orders_count),2) as aov_eur, sum(orders_count) as orders from gold.revenue_daily",
    rows: [{ aov_eur: GOLD.gmv.aov_eur, orders: GOLD.gmv.orders }],
  },
  conversion: {
    label: "Funnel conversion",
    sql: "select sum(views) views, sum(add_to_cart) carts, sum(checkouts) checkouts, round(100.0*sum(add_to_cart)/sum(views),1) view_to_cart_pct, round(100.0*sum(checkouts)/sum(views),1) view_to_checkout_pct from gold.funnel_daily",
    rows: [GOLD.conversion],
  },
  top_customers: {
    label: "Top customers by LTV",
    sql: "select customer_id, country, orders_count, lifetime_revenue_eur from gold.customer_ltv order by lifetime_revenue_eur desc limit 8",
    rows: GOLD.customers,
  },
  by_country: {
    label: "Revenue by country",
    sql: "select country, revenue_eur, customers, avg_ltv from gold.revenue_by_country order by revenue_eur desc",
    rows: GOLD.countries,
  },
  revenue_trend: {
    label: "Revenue trend (last 14 days)",
    sql: "select order_date, orders_count, revenue_eur, avg_order_value from gold.revenue_daily order by order_date desc limit 14",
    rows: [...GOLD.trend].reverse(),
  },
};

function matchIntent(question) {
  const q = question.toLowerCase();
  const rules = [
    ["gmv", ["gmv", "revenue", "sales", "ingresos", "factur"]],
    ["aov", ["aov", "average order", "ticket medio", "order value"]],
    ["revenue_trend", ["trend", "daily", "over time", "evolución", "evolucion"]],
    ["conversion", ["funnel", "conversion", "checkout", "cart", "conversión"]],
    ["top_customers", ["ltv", "customer", "cliente", "top", "lifetime"]],
    ["by_country", ["country", "país", "pais", "geo", "region"]],
  ];
  const hits = [];
  for (const [key, words] of rules) {
    if (words.some((w) => q.includes(w))) hits.push(key);
  }
  return hits.length ? [...new Set(hits)].slice(0, 3) : ["gmv", "conversion"];
}

function narrate(question, intents) {
  const bits = [];
  for (const intent of intents) {
    const rows = TEMPLATES[intent].rows;
    const row = rows[0];
    if (intent === "gmv") {
      bits.push(
        `**GMV** is €${row.gmv_eur.toLocaleString()} across ${row.orders.toLocaleString()} paid orders (AOV €${row.aov_eur}).`
      );
    } else if (intent === "aov") {
      bits.push(`**AOV** sits at €${row.aov_eur} over ${row.orders.toLocaleString()} orders.`);
    } else if (intent === "conversion") {
      bits.push(
        `Funnel: **${row.view_to_checkout_pct}%** view→checkout (${row.views.toLocaleString()} views → ${row.checkouts.toLocaleString()} checkouts; cart rate ${row.view_to_cart_pct}%).`
      );
    } else if (intent === "top_customers") {
      bits.push(
        `Top LTV customers: ${rows
          .slice(0, 3)
          .map((r) => `${r.customer_id} (${r.country}, €${r.lifetime_revenue_eur})`)
          .join(", ")}.`
      );
    } else if (intent === "by_country") {
      bits.push(
        `Revenue by country leaders: ${rows
          .slice(0, 3)
          .map((r) => `${r.country} €${r.revenue_eur.toLocaleString()}`)
          .join(", ")}.`
      );
    } else if (intent === "revenue_trend") {
      const latest = GOLD.trend[GOLD.trend.length - 1];
      bits.push(`Latest day **${latest.order_date}**: €${latest.revenue_eur} (${latest.orders_count} orders).`);
    }
  }
  return `Based on gold marts (read-only DuckDB tools):\n\n${bits.join("\n\n")}\n\n_Question:_ ${question}`;
}

function runCopilot(question) {
  const q = question.trim() || "What is our GMV and conversion?";
  const intents = matchIntent(q);
  const steps = [
    {
      agent: "planner",
      action: "route_intent",
      detail: `Matched intents: ${intents.join(", ")}`,
    },
  ];
  const citations = [];
  for (const intent of intents) {
    const t = TEMPLATES[intent];
    steps.push({ agent: "sql_analyst", action: "prepare_query", detail: t.label, sql: t.sql });
    steps.push({
      agent: "sql_analyst",
      action: "tool_result",
      detail: `${t.label}: ${t.rows.length} rows`,
      rows_preview: t.rows.slice(0, 4),
    });
    citations.push({ label: t.label, sql: t.sql });
  }
  steps.push({
    agent: "critic",
    action: "validate",
    detail: "confidence=high, passed=true",
  });
  steps.push({
    agent: "narrator",
    action: "compose_answer",
    detail: "Deterministic narration (demo mode)",
  });
  return {
    question: q,
    answer: narrate(q, intents),
    steps,
    critique: { confidence: "high", passed: true },
    citations,
    latency_ms: 180 + Math.round(Math.random() * 220),
    mode: "tools-only",
  };
}

const messagesEl = document.getElementById("messages");
const traceEl = document.getElementById("trace");
const citationsEl = document.getElementById("citations");
const form = document.getElementById("form");
const input = document.getElementById("input");
const examplesEl = document.getElementById("examples");

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function addMessage(role, text, meta = "") {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `${meta ? `<span class="meta">${meta}</span>` : ""}${escapeHtml(text)}`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderTrace(payload) {
  traceEl.className = "trace";
  traceEl.innerHTML = (payload.steps || [])
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
  citationsEl.className = "citations";
  citationsEl.innerHTML = `
    <p><span class="pill ${c.confidence || "low"}">${c.confidence || "n/a"} confidence</span>
    · ${payload.latency_ms} ms · mode ${payload.mode}</p>
    <ul>${(payload.citations || [])
      .map((x) => `<li><strong>${escapeHtml(x.label)}</strong><pre class="sql">${escapeHtml(x.sql || "")}</pre></li>`)
      .join("")}</ul>`;
}

async function ask(question) {
  addMessage("user", question);
  addMessage("assistant", "Running planner → SQL analyst → critic…", "copilot");
  const pending = messagesEl.lastChild;
  await new Promise((r) => setTimeout(r, 450 + Math.random() * 400));
  const data = runCopilot(question);
  pending.remove();
  addMessage("assistant", data.answer, `copilot · ${data.mode}`);
  renderTrace(data);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  ask(q);
});

const EXAMPLES = [
  "What is our GMV and AOV?",
  "How is the conversion funnel performing?",
  "Who are the top customers by LTV?",
  "Break down revenue by country",
  "Show revenue trend for recent days",
  "¿Cuál es el ticket medio y la conversión?",
];

examplesEl.innerHTML = EXAMPLES.map((q) => `<button type="button">${escapeHtml(q)}</button>`).join("");
examplesEl.querySelectorAll("button").forEach((btn, i) => {
  btn.addEventListener("click", () => ask(EXAMPLES[i]));
});

addMessage(
  "assistant",
  "Ready. Ask about GMV, AOV, funnel conversion, LTV or revenue by country. Traces show every agent step."
);

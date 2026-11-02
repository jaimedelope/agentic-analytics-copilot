/**
 * Live browser copilot: DuckDB-WASM gold marts + multi-agent tool loop.
 * No fake numbers — every answer comes from a real SELECT.
 */

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

const TEMPLATES = {
  gmv: {
    label: "Gross merchandise value",
    sql: `select round(sum(revenue_eur), 2) as gmv_eur,
                 sum(orders_count) as orders,
                 round(sum(revenue_eur) / nullif(sum(orders_count), 0), 2) as aov_eur
          from gold.revenue_daily`,
  },
  aov: {
    label: "Average order value",
    sql: `select round(sum(revenue_eur) / nullif(sum(orders_count), 0), 2) as aov_eur,
                 sum(orders_count) as orders
          from gold.revenue_daily`,
  },
  conversion: {
    label: "Funnel conversion",
    sql: `select sum(views) as views,
                 sum(add_to_cart) as carts,
                 sum(checkouts) as checkouts,
                 round(100.0 * sum(add_to_cart) / nullif(sum(views), 0), 1) as view_to_cart_pct,
                 round(100.0 * sum(checkouts) / nullif(sum(views), 0), 1) as view_to_checkout_pct
          from gold.funnel_daily`,
  },
  top_customers: {
    label: "Top customers by LTV",
    sql: `select customer_id, country, orders_count, lifetime_revenue_eur
          from gold.customer_ltv
          order by lifetime_revenue_eur desc
          limit 8`,
  },
  by_country: {
    label: "Revenue by country",
    sql: `select country, revenue_eur, customers, avg_ltv
          from gold.revenue_by_country
          order by revenue_eur desc`,
  },
  revenue_trend: {
    label: "Revenue trend (last 14 days)",
    sql: `select cast(order_date as varchar) as order_date, orders_count, revenue_eur, avg_order_value
          from gold.revenue_daily
          order by order_date desc
          limit 14`,
  },
};

const EXAMPLES = [
  "What is our GMV and AOV?",
  "How is the conversion funnel performing?",
  "Who are the top customers by LTV?",
  "Break down revenue by country",
  "Show revenue trend for recent days",
  "¿Cuál es el ticket medio y la conversión?",
];

let conn = null;

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function seedGold(connection) {
  await connection.query("create schema if not exists gold");
  await connection.query(`
    create table gold.revenue_daily (
      order_date date,
      orders_count integer,
      buyers integer,
      revenue_eur double,
      avg_order_value double
    )
  `);
  await connection.query(`
    create table gold.funnel_daily (
      event_date date,
      views integer,
      add_to_cart integer,
      checkouts integer,
      searches integer
    )
  `);
  await connection.query(`
    create table gold.customer_ltv (
      customer_id varchar,
      country varchar,
      orders_count integer,
      lifetime_revenue_eur double
    )
  `);

  const rng = mulberry32(42);
  const countries = ["ES", "FR", "DE", "US", "GB", "IT"];
  const today = new Date();
  const revenueRows = [];
  const funnelRows = [];

  for (let i = 0; i < 21; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - (20 - i));
    const day = isoDate(d);
    const orders = 40 + Math.floor(rng() * 36) + i;
    const revenue = Math.round((1800 + rng() * 3200 + i * 55) * 100) / 100;
    const buyers = Math.floor(orders * (0.62 + rng() * 0.2));
    const aov = Math.round((revenue / orders) * 100) / 100;
    revenueRows.push(`('${day}', ${orders}, ${buyers}, ${revenue}, ${aov})`);

    const views = 320 + Math.floor(rng() * 241);
    const carts = Math.floor(views * (0.28 + rng() * 0.1));
    const checkouts = Math.floor(carts * (0.36 + rng() * 0.2));
    const searches = 70 + Math.floor(rng() * 91);
    funnelRows.push(`('${day}', ${views}, ${carts}, ${checkouts}, ${searches})`);
  }

  await connection.query(
    `insert into gold.revenue_daily values ${revenueRows.join(",\n")}`
  );
  await connection.query(
    `insert into gold.funnel_daily values ${funnelRows.join(",\n")}`
  );

  const ltvRows = [];
  for (let i = 0; i < 24; i += 1) {
    const cid = `cus_${(0xa100 + i).toString(16)}`;
    const country = countries[i % countries.length];
    const orders = 1 + Math.floor(rng() * 11);
    const ltv = Math.round((80 + rng() * 1600 + orders * 40) * 100) / 100;
    ltvRows.push(`('${cid}', '${country}', ${orders}, ${ltv})`);
  }
  await connection.query(`insert into gold.customer_ltv values ${ltvRows.join(",\n")}`);

  await connection.query(`
    create table gold.revenue_by_country as
    select country,
           round(sum(lifetime_revenue_eur), 2) as revenue_eur,
           count(*)::integer as customers,
           round(avg(lifetime_revenue_eur), 2) as avg_ltv
    from gold.customer_ltv
    group by 1
    order by revenue_eur desc
  `);
}

async function initDuckDB() {
  const bundles = duckdb.getJsDelivrBundles();
  // Prefer MVP bundle so SharedArrayBuffer / COOP headers are not required on Vercel.
  const bundle = await duckdb.selectBundle({
    mvp: bundles.mvp,
    eh: bundles.eh,
  });
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();
  await seedGold(conn);
  return conn;
}

function coerceValue(v) {
  if (typeof v === "bigint") return Number(v);
  if (v == null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return v;
  // DuckDB-WASM / Arrow may wrap numerics as objects
  const n = Number(v);
  if (!Number.isNaN(n) && String(v).trim() !== "") return n;
  return String(v);
}

async function runSql(sql) {
  const cleaned = sql.trim().replace(/;$/, "");
  try {
    const result = await conn.query(cleaned);
    const rows = result.toArray().map((row) => {
      const obj = {};
      for (const key of Object.keys(row)) {
        obj[key] = coerceValue(row[key]);
      }
      return obj;
    });
    return { ok: true, sql: cleaned, rows, row_count: rows.length };
  } catch (err) {
    return { ok: false, sql: cleaned, error: String(err.message || err), rows: [], row_count: 0 };
  }
}

function matchIntent(question) {
  const q = question.toLowerCase();
  const rules = [
    ["gmv", ["gmv", "revenue", "sales", "ingresos", "factur", "merchandise"]],
    ["aov", ["aov", "average order", "ticket medio", "order value"]],
    ["revenue_trend", ["trend", "daily", "over time", "evolución", "evolucion", "últimos", "ultimos"]],
    ["conversion", ["funnel", "conversion", "checkout", "cart", "conversión"]],
    ["top_customers", ["ltv", "customer", "cliente", "top", "lifetime"]],
    ["by_country", ["country", "país", "pais", "geo", "region", "españa", "spain"]],
  ];
  const hits = [];
  for (const [key, words] of rules) {
    if (words.some((w) => q.includes(w))) hits.push(key);
  }
  return hits.length ? [...new Set(hits)].slice(0, 3) : ["gmv", "conversion"];
}

function narrate(question, findings) {
  const bits = [];
  for (const f of findings) {
    if (!f.ok || !f.rows?.length) continue;
    const row = f.rows[0];
    if (row.gmv_eur != null) {
      bits.push(
        `**GMV** is €${Number(row.gmv_eur).toLocaleString()} across ${Number(row.orders).toLocaleString()} paid orders (AOV €${Number(row.aov_eur).toLocaleString()}).`
      );
    } else if (row.aov_eur != null && row.view_to_checkout_pct == null) {
      bits.push(
        `**AOV** sits at €${Number(row.aov_eur).toLocaleString()} over ${Number(row.orders).toLocaleString()} orders.`
      );
    } else if (row.view_to_checkout_pct != null) {
      bits.push(
        `Funnel: **${row.view_to_checkout_pct}%** view->checkout (${Number(row.views).toLocaleString()} views → ${Number(row.checkouts).toLocaleString()} checkouts; cart rate ${row.view_to_cart_pct}%).`
      );
    } else if (row.lifetime_revenue_eur != null) {
      bits.push(
        `Top LTV customers: ${f.rows
          .slice(0, 3)
          .map((r) => `${r.customer_id} (${r.country}, €${Number(r.lifetime_revenue_eur).toLocaleString()})`)
          .join(", ")}.`
      );
    } else if (row.country != null && row.revenue_eur != null) {
      bits.push(
        `Revenue by country leaders: ${f.rows
          .slice(0, 3)
          .map((r) => `${r.country} €${Number(r.revenue_eur).toLocaleString()}`)
          .join(", ")}.`
      );
    } else if (row.order_date != null && row.revenue_eur != null) {
      bits.push(
        `Latest day **${row.order_date}**: €${Number(row.revenue_eur).toLocaleString()} (${row.orders_count} orders).`
      );
    }
  }
  if (!bits.length) {
    return "No reliable answer from gold marts. Try GMV, AOV, conversion, LTV or revenue by country.";
  }
  return `Based on live DuckDB-WASM gold marts:\n\n${bits.join("\n\n")}\n\n_Question:_ ${question}`;
}

function critic(findings) {
  const ok = findings.filter((f) => f.ok);
  const bad = findings.filter((f) => !f.ok);
  const issues = [];
  if (!ok.length) issues.push("No successful SQL tool calls.");
  for (const f of bad) issues.push(`Failed: ${f.error}`);
  for (const f of ok) if (!f.row_count) issues.push(`${f.label} returned 0 rows.`);
  const confidence = ok.length && !issues.length ? "high" : ok.length ? "medium" : "low";
  return { passed: ok.length > 0 && issues.length === 0, confidence, issues };
}

async function runCopilot(question) {
  const started = performance.now();
  const q = question.trim() || "What is our GMV and conversion?";
  const intents = matchIntent(q);
  const steps = [
    {
      agent: "planner",
      action: "route_intent",
      detail: `Matched intents: ${intents.join(", ")}`,
    },
  ];

  const findings = [];
  for (const intent of intents) {
    const tmpl = TEMPLATES[intent];
    steps.push({
      agent: "sql_analyst",
      action: "prepare_query",
      detail: tmpl.label,
      sql: tmpl.sql.replace(/\s+/g, " ").trim(),
    });
    const result = await runSql(tmpl.sql);
    const finding = { intent, label: tmpl.label, ...result };
    findings.push(finding);
    if (result.ok) {
      steps.push({
        agent: "sql_analyst",
        action: "tool_result",
        detail: `${tmpl.label}: ${result.row_count} rows (live DuckDB)`,
        rows_preview: result.rows.slice(0, 5),
      });
    } else {
      steps.push({
        agent: "sql_analyst",
        action: "tool_error",
        detail: result.error,
        sql: result.sql,
      });
    }
  }

  const critique = critic(findings);
  steps.push({
    agent: "critic",
    action: "validate",
    detail: `confidence=${critique.confidence}, passed=${critique.passed}`,
  });
  const answer = narrate(q, findings);
  steps.push({
    agent: "narrator",
    action: "compose_answer",
    detail: "Narrated from live query results",
  });

  return {
    question: q,
    answer,
    steps,
    critique,
    citations: findings
      .filter((f) => f.ok)
      .map((f) => ({ label: f.label, sql: f.sql })),
    latency_ms: Math.round(performance.now() - started),
    mode: "duckdb-wasm",
  };
}

/* ---------- UI ---------- */

const messagesEl = document.getElementById("messages");
const traceEl = document.getElementById("trace");
const citationsEl = document.getElementById("citations");
const statusEl = document.getElementById("status");
const form = document.getElementById("form");
const input = document.getElementById("input");
const askBtn = document.getElementById("askBtn");
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
  return div;
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
  if (!conn) return;
  input.disabled = true;
  askBtn.disabled = true;
  addMessage("user", question);
  const pending = addMessage("assistant", "Running planner → live SQL → critic…", "copilot");
  try {
    const data = await runCopilot(question);
    pending.remove();
    addMessage("assistant", data.answer, `copilot · ${data.mode}`);
    renderTrace(data);
  } catch (err) {
    pending.remove();
    addMessage("assistant", `Error: ${err.message || err}`);
  } finally {
    input.disabled = false;
    askBtn.disabled = false;
    input.focus();
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
    await initDuckDB();
    const count = await conn.query("select count(*)::int as n from gold.revenue_daily");
    const n = Number(count.toArray()[0].n);
    statusEl.textContent = `live · DuckDB-WASM · ${n} revenue days`;
    statusEl.classList.add("live");
    input.disabled = false;
    askBtn.disabled = false;

    examplesEl.innerHTML = EXAMPLES.map((q) => `<button type="button">${escapeHtml(q)}</button>`).join("");
    examplesEl.querySelectorAll("button").forEach((btn, i) => {
      btn.addEventListener("click", () => ask(EXAMPLES[i]));
    });

    addMessage(
      "assistant",
      "DuckDB is running in your browser. Gold marts are seeded and every answer executes real SQL — open the trace to see the queries and row results."
    );
  } catch (err) {
    statusEl.textContent = "DuckDB boot failed";
    addMessage("assistant", `Could not start DuckDB-WASM: ${err.message || err}`);
    console.error(err);
  }
}

boot();

"""Multi-agent analytics copilot: Planner → SQL Analyst → Critic → Narrator."""

from __future__ import annotations

import os
import time
from typing import Any

from .tools import TEMPLATES, describe_schema, list_tables, match_intent, run_sql


def _step(agent: str, action: str, detail: str, **extra: Any) -> dict[str, Any]:
    return {"agent": agent, "action": action, "detail": detail, **extra}


def _format_rows(rows: list[dict[str, Any]], max_rows: int = 6) -> str:
    if not rows:
        return "No rows returned."
    lines = []
    for r in rows[:max_rows]:
        parts = [f"{k}={v}" for k, v in r.items()]
        lines.append("· " + ", ".join(parts))
    if len(rows) > max_rows:
        lines.append(f"· … +{len(rows) - max_rows} more")
    return "\n".join(lines)


def _narrate(question: str, findings: list[dict[str, Any]]) -> str:
    bits = []
    for f in findings:
        if not f.get("ok"):
            continue
        label = f.get("label", "Query")
        rows = f.get("rows") or []
        if not rows:
            continue
        row = rows[0]
        if "gmv_eur" in row:
            bits.append(
                f"**GMV** is €{row['gmv_eur']:,.2f} across {int(row.get('orders') or 0):,} paid orders "
                f"(AOV €{float(row.get('aov_eur') or 0):,.2f})."
            )
        elif "aov_eur" in row and "gmv_eur" not in row:
            bits.append(f"**AOV** sits at €{float(row['aov_eur']):,.2f} over {int(row.get('orders') or 0):,} orders.")
        elif "view_to_checkout_pct" in row:
            bits.append(
                f"Funnel: **{row['view_to_checkout_pct']}%** view->checkout "
                f"({int(row['views']):,} views → {int(row['checkouts']):,} checkouts; "
                f"cart rate {row['view_to_cart_pct']}%)."
            )
        elif "lifetime_revenue_eur" in row:
            top = ", ".join(
                f"{r['customer_id']} ({r['country']}, €{r['lifetime_revenue_eur']:,.0f})" for r in rows[:3]
            )
            bits.append(f"Top LTV customers: {top}.")
        elif "country" in row and "revenue_eur" in row:
            top = ", ".join(f"{r['country']} €{r['revenue_eur']:,.0f}" for r in rows[:3])
            bits.append(f"Revenue by country leaders: {top}.")
        elif "order_date" in row and "revenue_eur" in row:
            latest = rows[0]
            bits.append(
                f"Latest day **{latest['order_date']}**: €{latest['revenue_eur']:,.2f} "
                f"({int(latest['orders_count'])} orders)."
            )
        else:
            bits.append(f"{label}: {_format_rows(rows, 3)}")

    if not bits:
        return (
            "I could not produce a reliable answer from gold marts. "
            "Try asking about GMV, AOV, conversion, LTV or revenue by country."
        )

    lead = "Based on gold marts (read-only DuckDB tools):\n\n"
    return lead + "\n\n".join(bits) + f"\n\n_Question:_ {question}"


def _critic(findings: list[dict[str, Any]]) -> dict[str, Any]:
    ok = [f for f in findings if f.get("ok")]
    bad = [f for f in findings if not f.get("ok")]
    issues = []
    if not ok:
        issues.append("No successful SQL tool calls.")
    for f in bad:
        issues.append(f"Failed: {f.get('error', 'unknown')}")
    for f in ok:
        if f.get("row_count", 0) == 0:
            issues.append(f"{f.get('label')} returned 0 rows.")
    confidence = "high" if ok and not issues else ("medium" if ok else "low")
    return {
        "passed": bool(ok) and len(issues) == 0,
        "confidence": confidence,
        "issues": issues,
        "successful_tools": len(ok),
        "failed_tools": len(bad),
    }


def _optional_llm_polish(question: str, answer: str, schema: str) -> str | None:
    """Optional OpenAI polish when OPENAI_API_KEY is set. Never required."""
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return None
    try:
        import json
        import urllib.request

        body = {
            "model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are an analytics narrator. Rewrite the draft answer in crisp executive English "
                        "(or Spanish if the question is in Spanish). Keep numbers exact. Do not invent metrics. "
                        f"Schema:\n{schema}"
                    ),
                },
                {"role": "user", "content": f"Question: {question}\n\nDraft:\n{answer}"},
            ],
            "temperature": 0.2,
        }
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode())
        return payload["choices"][0]["message"]["content"].strip()
    except Exception:  # noqa: BLE001
        return None


def run_copilot(question: str) -> dict[str, Any]:
    started = time.time()
    steps: list[dict[str, Any]] = []
    q = (question or "").strip() or "What is our GMV and conversion?"

    # 1) Planner
    intents = match_intent(q)
    schema = describe_schema()
    tables = list_tables()
    steps.append(
        _step(
            "planner",
            "route_intent",
            f"Matched intents: {', '.join(intents)}",
            intents=intents,
            tables=tables,
        )
    )

    # 2) SQL analyst
    findings: list[dict[str, Any]] = []
    for intent in intents:
        tmpl = TEMPLATES[intent]
        steps.append(_step("sql_analyst", "prepare_query", tmpl["label"], intent=intent, sql=tmpl["sql"].strip()))
        result = run_sql(tmpl["sql"])
        finding = {
            "intent": intent,
            "label": tmpl["label"],
            **result,
        }
        findings.append(finding)
        if result.get("ok"):
            steps.append(
                _step(
                    "sql_analyst",
                    "tool_result",
                    f"{tmpl['label']}: {result['row_count']} rows",
                    rows_preview=result.get("rows", [])[:5],
                    sql=result.get("sql"),
                )
            )
        else:
            steps.append(
                _step(
                    "sql_analyst",
                    "tool_error",
                    result.get("error", "query failed"),
                    sql=result.get("sql"),
                )
            )

    # 3) Critic
    critique = _critic(findings)
    steps.append(
        _step(
            "critic",
            "validate",
            f"confidence={critique['confidence']}, passed={critique['passed']}",
            critique=critique,
        )
    )

    # 4) Narrator
    draft = _narrate(q, findings)
    polished = _optional_llm_polish(q, draft, schema)
    answer = polished or draft
    steps.append(
        _step(
            "narrator",
            "compose_answer",
            "LLM polish applied" if polished else "Deterministic narration (no API key / fallback)",
            llm_used=bool(polished),
        )
    )

    citations = [
        {"mart": f"gold.{TEMPLATES[i]['label'].split()[0].lower()}", "intent": i, "label": TEMPLATES[i]["label"]}
        for i in intents
    ]
    # cleaner citations from actual SQL
    citations = [{"intent": f["intent"], "label": f["label"], "sql": f.get("sql")} for f in findings if f.get("ok")]

    return {
        "question": q,
        "answer": answer,
        "steps": steps,
        "critique": critique,
        "citations": citations,
        "schema": schema,
        "latency_ms": round((time.time() - started) * 1000, 1),
        "mode": "llm+tools" if polished else "tools-only",
    }

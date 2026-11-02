"""Safe read-only analytics tools over DuckDB gold marts."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import duckdb

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.getenv("DUCKDB_PATH", ROOT / "data" / "analytics.duckdb"))

ALLOWED_TABLES = {
    "gold.revenue_daily",
    "gold.funnel_daily",
    "gold.customer_ltv",
    "gold.revenue_by_country",
}

FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|attach|copy|export|pragma|create|replace|grant|revoke)\b",
    re.I,
)


def connect() -> duckdb.DuckDBPyConnection:
    if not DB_PATH.exists():
        raise FileNotFoundError(f"DuckDB not found at {DB_PATH}. Run seed/build_db.py first.")
    return duckdb.connect(str(DB_PATH), read_only=True)


def list_tables() -> list[dict[str, Any]]:
    con = connect()
    rows = con.execute(
        """
        select schema_name || '.' || table_name as name, estimated_size as rows
        from duckdb_tables()
        where schema_name = 'gold'
        order by name
        """
    ).fetchall()
    con.close()
    return [{"name": r[0], "approx_rows": r[1]} for r in rows]


def describe_schema() -> str:
    con = connect()
    parts = []
    for table in sorted(ALLOWED_TABLES):
        cols = con.execute(f"describe {table}").fetchall()
        col_txt = ", ".join(f"{c[0]}:{c[1]}" for c in cols)
        parts.append(f"{table} ({col_txt})")
    con.close()
    return "\n".join(parts)


def run_sql(sql: str, limit: int = 50) -> dict[str, Any]:
    cleaned = sql.strip().rstrip(";")
    if FORBIDDEN.search(cleaned):
        return {"ok": False, "error": "Only read-only SELECT queries are allowed.", "sql": cleaned}
    if not cleaned.lower().startswith("select") and not cleaned.lower().startswith("with"):
        return {"ok": False, "error": "Query must start with SELECT or WITH.", "sql": cleaned}

    # Soft allow-list: must reference at least one gold table
    lower = cleaned.lower()
    if not any(t.split(".", 1)[1] in lower for t in ALLOWED_TABLES):
        return {
            "ok": False,
            "error": "Query must reference a gold.* mart (revenue_daily, funnel_daily, customer_ltv, revenue_by_country).",
            "sql": cleaned,
        }

    wrapped = f"select * from ({cleaned}) as q limit {int(limit)}"
    try:
        con = connect()
        rel = con.execute(wrapped)
        cols = [d[0] for d in rel.description]
        rows = [dict(zip(cols, row)) for row in rel.fetchall()]
        con.close()
        return {"ok": True, "sql": cleaned, "columns": cols, "rows": rows, "row_count": len(rows)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "sql": cleaned}


# Intent → curated SQL templates (deterministic planner; works without LLM keys)
TEMPLATES: dict[str, dict[str, str]] = {
    "gmv": {
        "label": "Gross merchandise value",
        "sql": """
            select round(sum(revenue_eur), 2) as gmv_eur,
                   sum(orders_count) as orders,
                   round(sum(revenue_eur) / nullif(sum(orders_count), 0), 2) as aov_eur
            from gold.revenue_daily
        """,
    },
    "revenue_trend": {
        "label": "Revenue trend (last 14 days)",
        "sql": """
            select order_date, orders_count, revenue_eur, avg_order_value
            from gold.revenue_daily
            order by order_date desc
            limit 14
        """,
    },
    "aov": {
        "label": "Average order value",
        "sql": """
            select round(sum(revenue_eur) / nullif(sum(orders_count), 0), 2) as aov_eur,
                   sum(orders_count) as orders
            from gold.revenue_daily
        """,
    },
    "conversion": {
        "label": "Funnel conversion",
        "sql": """
            select sum(views) as views,
                   sum(add_to_cart) as carts,
                   sum(checkouts) as checkouts,
                   round(100.0 * sum(add_to_cart) / nullif(sum(views), 0), 1) as view_to_cart_pct,
                   round(100.0 * sum(checkouts) / nullif(sum(views), 0), 1) as view_to_checkout_pct
            from gold.funnel_daily
        """,
    },
    "top_customers": {
        "label": "Top customers by LTV",
        "sql": """
            select customer_id, country, orders_count, lifetime_revenue_eur
            from gold.customer_ltv
            order by lifetime_revenue_eur desc
            limit 8
        """,
    },
    "by_country": {
        "label": "Revenue by country",
        "sql": """
            select country, revenue_eur, customers, avg_ltv
            from gold.revenue_by_country
            order by revenue_eur desc
        """,
    },
}


def match_intent(question: str) -> list[str]:
    q = question.lower()
    hits: list[str] = []
    rules = [
        ("gmv", ["gmv", "revenue", "sales", "ingresos", "factur", "merchandise"]),
        ("aov", ["aov", "average order", "ticket medio", "order value"]),
        ("revenue_trend", ["trend", "daily", "over time", "evolución", "evolucion", "últimos", "ultimos"]),
        ("conversion", ["funnel", "conversion", "checkout", "cart", "conversión", "conversion"]),
        ("top_customers", ["ltv", "customer", "cliente", "top", "lifetime"]),
        ("by_country", ["country", "país", "pais", "geo", "region", "españa", "spain"]),
    ]
    for key, words in rules:
        if any(w in q for w in words):
            hits.append(key)
    if not hits:
        hits = ["gmv", "conversion"]
    # de-dupe preserve order
    seen = set()
    out = []
    for h in hits:
        if h not in seen:
            seen.add(h)
            out.append(h)
    return out[:3]

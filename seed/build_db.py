"""Seed DuckDB gold marts for the analytics copilot."""

from __future__ import annotations

import os
import random
from datetime import date, timedelta
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.getenv("DUCKDB_PATH", ROOT / "data" / "analytics.duckdb"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

COUNTRIES = ["ES", "FR", "DE", "US", "GB", "IT"]
rng = random.Random(42)


def main() -> None:
    if DB_PATH.exists():
        DB_PATH.unlink()
    con = duckdb.connect(str(DB_PATH))
    con.execute("create schema gold")

    con.execute(
        """
        create table gold.revenue_daily (
          order_date date,
          orders_count integer,
          buyers integer,
          revenue_eur double,
          avg_order_value double
        )
        """
    )
    con.execute(
        """
        create table gold.funnel_daily (
          event_date date,
          views integer,
          add_to_cart integer,
          checkouts integer,
          searches integer
        )
        """
    )
    con.execute(
        """
        create table gold.customer_ltv (
          customer_id varchar,
          country varchar,
          orders_count integer,
          lifetime_revenue_eur double
        )
        """
    )

    today = date.today()
    for i in range(21):
        d = today - timedelta(days=20 - i)
        orders = 40 + rng.randint(0, 35) + i
        revenue = round(1800 + rng.random() * 3200 + i * 55, 2)
        buyers = int(orders * (0.62 + rng.random() * 0.2))
        aov = round(revenue / orders, 2)
        con.execute(
            "insert into gold.revenue_daily values (?, ?, ?, ?, ?)",
            [d, orders, buyers, revenue, aov],
        )

        views = 320 + rng.randint(0, 240)
        carts = int(views * (0.28 + rng.random() * 0.1))
        checkouts = int(carts * (0.36 + rng.random() * 0.2))
        searches = 70 + rng.randint(0, 90)
        con.execute(
            "insert into gold.funnel_daily values (?, ?, ?, ?, ?)",
            [d, views, carts, checkouts, searches],
        )

    for i in range(24):
        cid = f"cus_{hex(0xa100 + i)[2:]}"
        country = COUNTRIES[i % len(COUNTRIES)]
        orders = 1 + rng.randint(0, 10)
        ltv = round(80 + rng.random() * 1600 + orders * 40, 2)
        con.execute(
            "insert into gold.customer_ltv values (?, ?, ?, ?)",
            [cid, country, orders, ltv],
        )

    con.execute(
        """
        create table gold.revenue_by_country as
        select country,
               round(sum(lifetime_revenue_eur), 2) as revenue_eur,
               count(*) as customers,
               round(avg(lifetime_revenue_eur), 2) as avg_ltv
        from gold.customer_ltv
        group by 1
        order by revenue_eur desc
        """
    )

    counts = con.execute(
        """
        select 'revenue_daily', count(*) from gold.revenue_daily
        union all select 'funnel_daily', count(*) from gold.funnel_daily
        union all select 'customer_ltv', count(*) from gold.customer_ltv
        union all select 'revenue_by_country', count(*) from gold.revenue_by_country
        """
    ).fetchall()
    con.close()
    print(f"Seeded {DB_PATH}")
    for name, n in counts:
        print(f"  gold.{name}: {n}")


if __name__ == "__main__":
    main()

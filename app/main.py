"""FastAPI surface for the Agentic Analytics Copilot."""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from agents.graph import run_copilot  # noqa: E402
from agents.tools import list_tables  # noqa: E402

static_dir = Path(__file__).parent / "static"
app = FastAPI(title="Agentic Analytics Copilot", version="1.0.0")
app.mount("/static", StaticFiles(directory=static_dir), name="static")


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=500)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(static_dir / "index.html")


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    return FileResponse(static_dir / "favicon.svg", media_type="image/svg+xml")


@app.get("/api/health")
def health() -> dict:
    try:
        tables = list_tables()
        return {"status": "ok", "tables": tables}
    except Exception as exc:  # noqa: BLE001
        return {"status": "degraded", "error": str(exc)}


@app.get("/api/examples")
def examples() -> dict:
    return {
        "examples": [
            "What is our GMV and AOV?",
            "How is the conversion funnel performing?",
            "Who are the top customers by LTV?",
            "Break down revenue by country",
            "Show revenue trend for recent days",
            "¿Cuál es el ticket medio y la conversión?",
        ]
    }


@app.post("/api/chat")
def chat(body: ChatRequest) -> dict:
    return run_copilot(body.question)

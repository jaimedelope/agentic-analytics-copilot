FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY seed ./seed
COPY agents ./agents
COPY app ./app

RUN python seed/build_db.py

ENV DUCKDB_PATH=/app/data/analytics.duckdb
EXPOSE 8092
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8092"]

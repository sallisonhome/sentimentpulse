FROM python:3.11-slim

WORKDIR /app

# Install system dependencies needed by lxml / psycopg2
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download NLTK data needed by VADER
RUN python -c "import nltk; nltk.download('vader_lexicon', quiet=True)"

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

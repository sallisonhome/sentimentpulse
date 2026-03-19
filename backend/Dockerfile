FROM python:3.11-slim

WORKDIR /app

# Install system dependencies needed by lxml / psycopg2 / hdbscan
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libc6-dev \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download NLTK data needed by VADER
RUN python -c "import nltk; nltk.download('vader_lexicon', quiet=True)"

COPY . .

# Make entrypoint executable
RUN chmod +x entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]

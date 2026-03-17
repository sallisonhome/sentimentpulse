#!/bin/sh
set -e

# Run database migrations before starting the server
echo "Running database migrations..."
alembic upgrade head

# Start the API server
echo "Starting server..."
exec uvicorn main:app --host 0.0.0.0 --port 8000

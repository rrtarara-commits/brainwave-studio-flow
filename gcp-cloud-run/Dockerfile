# TCV Video QC Analyzer - Cloud Run Container
# Python 3.11 + FFmpeg for video processing

FROM python:3.11-slim

# Install FFmpeg and other dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py .

# Set environment variables
ENV PORT=8080
ENV PYTHONUNBUFFERED=1

# Run the application
CMD ["python", "main.py"]

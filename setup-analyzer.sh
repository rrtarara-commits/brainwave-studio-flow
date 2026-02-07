#!/bin/bash
# TrueNAS Deep Video Analyzer - Setup Script

set -e

echo "🎬 TrueNAS Deep Video Analyzer Setup"
echo "===================================="
echo ""

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Check for required files
if [ ! -f "truenas-analyzer.py" ]; then
    echo "❌ truenas-analyzer.py not found. Make sure it's in the current directory."
    exit 1
fi

if [ ! -f "truenas-analyzer-Dockerfile" ]; then
    echo "❌ truenas-analyzer-Dockerfile not found. Make sure it's in the current directory."
    exit 1
fi

if [ ! -f "truenas-docker-compose.yml" ]; then
    echo "❌ truenas-docker-compose.yml not found. Make sure it's in the current directory."
    exit 1
fi

# Check for environment file
if [ ! -f ".env" ]; then
    echo "⚠️  .env file not found. Creating template..."
    cat > .env << 'EOF'
# Required secrets - Set these values
TRUENAS_CALLBACK_SECRET=your_truenas_secret_here
GEMINI_API_KEY=your_gemini_api_key_here
EOF
    echo "✅ Created .env template. Please edit it with your secrets."
    echo ""
    echo "To get your secrets:"
    echo "1. TRUENAS_CALLBACK_SECRET: Use the value from your Lovable Cloud secrets"
    echo "2. GEMINI_API_KEY: Get from https://aistudio.google.com/apikey"
    echo ""
    exit 0
fi

# Validate environment variables
if grep -q "your_truenas_secret_here" .env || grep -q "your_gemini_api_key_here" .env; then
    echo "❌ .env file has placeholder values. Please update them with actual secrets."
    exit 1
fi

echo "✅ Configuration valid"
echo ""

# Build image
echo "🔨 Building Docker image..."
docker-compose -f truenas-docker-compose.yml build

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start the service, run:"
echo "  docker-compose -f truenas-docker-compose.yml up -d"
echo ""
echo "To view logs:"
echo "  docker-compose -f truenas-docker-compose.yml logs -f"
echo ""
echo "To stop the service:"
echo "  docker-compose -f truenas-docker-compose.yml down"

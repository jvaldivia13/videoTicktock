#!/bin/bash
# Setup script for videoTicktock project

set -e

echo "🚀 Setting up videoTicktock..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install Node.js 18+"
    exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ required. Current: $(node --version)"
    exit 1
fi

echo "✅ Node.js $(node --version)"

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 not found"
    exit 1
fi

echo "✅ Python $(python3 --version)"

# Check FFMPEG
if ! command -v ffmpeg &> /dev/null; then
    echo "⚠️  FFMPEG not found. Installing..."
    if command -v apt &> /dev/null; then
        sudo apt update && sudo apt install -y ffmpeg
    elif command -v brew &> /dev/null; then
        brew install ffmpeg
    else
        echo "Please install FFMPEG manually"
        exit 1
    fi
fi

echo "✅ FFMPEG $(ffmpeg -version | head -1)"

# Install Node dependencies
echo "📦 Installing Node dependencies..."
npm install

# Create Python venv
echo "🐍 Creating Python virtual environment..."
python3 -m venv venv
source venv/bin/activate

# Install Python dependencies
echo "📦 Installing Python dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

# Create directories
echo "📁 Creating directories..."
mkdir -p data/{swarm-memory,videos,logs,output}
mkdir -p tmp

# Copy .env.example if .env doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env
    echo "⚠️  Created .env from .env.example - PLEASE EDIT with your API keys!"
fi

# Make scripts executable
chmod +x scripts/*.js scripts/*.sh 2>/dev/null || true

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env with your API keys (OpenClaw gateway, TikTok, etc.)"
echo "2. Start OpenClaw gateway: openclaw gateway start"
echo "3. Test swarm: npm run swarm -- --topic \"disciplina matutina\""
echo "4. Run full pipeline: npm run pipeline -- --topic \"disciplina matutina\" --publish"
echo "5. Setup daily cron: npm run daily -- --cron"
echo ""
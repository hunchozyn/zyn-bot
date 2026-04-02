#!/bin/bash
set -e

cat > /home/ubuntu/zyn-bot/.env << 'EOF'
DISCORD_TOKEN=your_discord_token_here
YOUTUBE_API_KEY=your_youtube_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
EOF

echo ".env file created at /home/ubuntu/zyn-bot/.env"
echo "Edit it now with: nano /home/ubuntu/zyn-bot/.env"

#!/bin/bash
set -e

echo "==> Updating apt..."
apt-get update -y && apt-get upgrade -y

echo "==> Installing dependencies..."
apt-get install -y curl git python3 ffmpeg

echo "==> Installing Node.js 18 via NodeSource..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

echo "==> Cloning zyn-bot..."
git clone https://github.com/hunchozyn/zyn-bot /home/ubuntu/zyn-bot

echo "==> Running npm install..."
cd /home/ubuntu/zyn-bot
npm install

echo "Setup complete"

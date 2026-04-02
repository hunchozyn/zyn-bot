#!/bin/bash
set -e

echo "==> Checking for PM2..."
if ! command -v pm2 &> /dev/null; then
  echo "==> Installing PM2 globally..."
  npm install -g pm2
else
  echo "==> PM2 already installed: $(pm2 --version)"
fi

echo "==> Starting zyn-bot via ecosystem.config.js..."
pm2 start /home/ubuntu/zyn-bot/ecosystem.config.js

echo "==> Configuring PM2 to start on boot..."
pm2 startup systemd -u ubuntu --hp /home/ubuntu

echo "==> Saving PM2 process list..."
pm2 save

echo "==> Done. Run 'pm2 status' to confirm zyn-bot is running."

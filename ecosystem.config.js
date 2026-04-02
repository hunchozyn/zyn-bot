module.exports = {
  apps: [
    {
      name: 'zyn-bot',
      script: '/home/ubuntu/zyn-bot/index.js',
      watch: false,
      autorestart: true,
      restart_delay: 3000,
    },
  ],
};

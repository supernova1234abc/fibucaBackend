/**
 * PM2 Ecosystem Configuration - Optimized for 500MB RAM
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 logs fibuca-backend
 *   pm2 restart fibuca-backend
 *   pm2 save && pm2 startup
 */

module.exports = {
  apps: [
    {
      name: 'fibuca-backend',
      script: './index.js',
      namespace: 'fibuca',
      instances: 1,  // Single instance for low-RAM
      exec_mode: 'fork',
      
      // Environment variables
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        NODE_OPTIONS: '--max-old-space-size=256'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        NODE_OPTIONS: '--max-old-space-size=256'
      },
      
      // Memory & CPU limits
      max_memory_restart: '200M',  // Restart if exceeds 200MB
      max_restarts: 10,
      min_uptime: '10s',
      
      // Logging
      output: './logs/out.log',
      error: './logs/err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      // Auto restart
      autorestart: true,
      max_consecutive_restarts: 3,
      
      // Graceful shutdown
      kill_timeout: 5000,
      shutdown_delay: 1000,
      listen_timeout: 10000,
      
      // Watch for file changes (dev only)
      watch: ['index.js', 'py-tools'],
      ignore_watch: ['node_modules', 'logs', '.prisma', 'uploads'],
      
      // Prevent duplicate spawning
      merge_logs: true
    }
  ],
  
  // Deployment configuration
  deploy: {
    production: {
      user: 'node',
      host: 'your-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:your-repo/fibuca-backend.git',
      path: '/home/node/fibuca-backend',
      'post-deploy': 'npm install && npm run migrate && pm2 restart fibuca-backend'
    },
    staging: {
      user: 'node',
      host: 'staging-server.com',
      ref: 'origin/develop',
      repo: 'git@github.com:your-repo/fibuca-backend.git',
      path: '/home/node/fibuca-backend-staging',
      'post-deploy': 'npm install && npm run migrate:dev && pm2 restart fibuca-backend'
    }
  }
};

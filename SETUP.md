# QuantEdge v2 — Setup Guide

## New Droplet Setup (Ubuntu 24 LTS)

```bash
# 1. Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt-get install -y nodejs nginx

# 2. Install PM2
npm install -g pm2

# 3. Clone your repo
git clone https://github.com/YOUR_USERNAME/quantedge-v2
cd quantedge-v2

# 4. Start server
pm2 start index.js --name qe2
pm2 save
pm2 startup

# 5. Nginx config
cat > /etc/nginx/sites-available/default << 'NGINX'
server {
    listen 80;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }
}
NGINX

nginx -t && systemctl reload nginx
```

## Upstox Access Token (daily)

1. Go to https://developer.upstox.com
2. Login → My Apps → Get Access Token
3. Copy the token
4. Paste into QuantEdge dashboard at 9:20 AM

## Whitelist Droplet IP

In Upstox Developer Console:
- Add your new droplet's static IP to the allowed IPs list

## Deploy Updates

```bash
cd ~/quantedge-v2 && git pull && pm2 restart qe2 && echo "✅ DONE"
```

## Verify Running

```bash
pm2 status
curl http://localhost:3000/state
```

## Daily Workflow

1. Open http://YOUR_IP in Firefox at 9:15 AM
2. Paste Upstox access token
3. Click CONNECT
4. Wait for NIFTY price to appear
5. Click START at 9:25 AM
6. Server runs all day — you can close browser
7. Check back at 3:15 PM for results

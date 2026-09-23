# vix-stream-resolver — zero-dependency Node service.
#
# Deploy anywhere vixsrc.to doesn't Cloudflare-block (Railway / Render /
# Fly.io all build this Dockerfile as-is):
#   1. New service from the tvtime-app/resolver-server/ directory.
#   2. No env vars required (PORT is injected; optional VIX_LANG, default en).
#   3. Health check path: /health
#   4. Copy the service's public root URL (NO trailing slash, NO path) into
#      the Vercel project's VIX_RESOLVER_URL and redeploy the frontend.
# Verify: curl <url>/health -> {"ok":true,...}
#         curl "<url>/stream?type=movie&id=27205" -> {"ok":true,"playlistUrl":"/media?..."}
FROM node:20-alpine
WORKDIR /srv
COPY package.json ./
# No runtime deps today; kept so `npm start` works everywhere.
RUN npm install --omit=dev --no-audit --no-fund || true
COPY server.js ./
EXPOSE 8080
CMD ["node", "server.js"]

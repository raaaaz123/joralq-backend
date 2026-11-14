#!/bin/sh
# Rebuild and restart the API on a Docker host behind Traefik (Coolify's proxy).
# Usage on the server: ./deploy.sh   (expects .env next to this script)
set -e
cd "$(dirname "$0")"
git pull --ff-only
DOMAIN="${DOMAIN:-joraiq-api.161.97.84.24.sslip.io}"
docker build -t joraiq-backend:latest .
docker rm -f joraiq-backend 2>/dev/null || true
docker run -d --name joraiq-backend --restart unless-stopped --network coolify --env-file .env \
  -l traefik.enable=true \
  -l "traefik.http.routers.joraiq-api-http.entryPoints=http" \
  -l "traefik.http.routers.joraiq-api-http.middlewares=redirect-to-https" \
  -l "traefik.http.routers.joraiq-api-http.rule=Host(\`$DOMAIN\`)" \
  -l "traefik.http.routers.joraiq-api.entryPoints=https" \
  -l "traefik.http.routers.joraiq-api.rule=Host(\`$DOMAIN\`)" \
  -l "traefik.http.routers.joraiq-api.tls=true" \
  -l "traefik.http.routers.joraiq-api.tls.certresolver=letsencrypt" \
  -l "traefik.http.services.joraiq-api.loadbalancer.server.port=4000" \
  joraiq-backend:latest
docker image prune -f >/dev/null
echo "Deployed: https://$DOMAIN/health"

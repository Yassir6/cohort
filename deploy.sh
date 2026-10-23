#!/bin/sh
# Rebuild and restart Cohort on this server. Traefik (from Dokploy) serves it at
# https://cohort.iyasir.com; settings come from .env, data stays in the cohort-data volume.
set -e
cd "$(dirname "$0")"
docker build -t cohort:latest .
docker rm -f cohort >/dev/null 2>&1 || true
docker run -d --name cohort --restart unless-stopped \
  --network dokploy-network \
  --env-file .env \
  -v cohort-data:/data \
  --label traefik.enable=true \
  --label 'traefik.http.routers.cohort.rule=Host(`cohort.iyasir.com`)' \
  --label traefik.http.routers.cohort.entrypoints=websecure \
  --label traefik.http.routers.cohort.tls=true \
  --label traefik.http.routers.cohort.tls.certresolver=letsencrypt \
  --label 'traefik.http.routers.cohort-http.rule=Host(`cohort.iyasir.com`)' \
  --label traefik.http.routers.cohort-http.entrypoints=web \
  --label traefik.http.routers.cohort-http.middlewares=redirect-to-https@file \
  --label traefik.http.services.cohort.loadbalancer.server.port=8090 \
  cohort:latest
echo "Cohort is running. Logs: docker logs -f cohort"

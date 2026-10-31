# All-in-one image bundling OpenWA Gateway (https://www.open-wa.org) + CarryBee WhatsApp Bridge.
# Works identically on Render (single Docker Web Service + Disk) and on a KVM VPS (docker compose up -d).
FROM ghcr.io/rmyndharis/openwa:latest

# Install CarryBee Bridge alongside OpenWA (/app stays untouched).
WORKDIR /opt/carrybee-bridge

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server.js openwa-gateway.js turso-store.js groups-config.json ./
RUN chown -R openwa:openwa /opt/carrybee-bridge

COPY docker/carrybee-start.sh /usr/local/bin/carrybee-start.sh
RUN sed -i 's/\r$//' /usr/local/bin/carrybee-start.sh && chmod +x /usr/local/bin/carrybee-start.sh

# Return to /app so OpenWA's docker-entrypoint.sh runs in its expected directory.
WORKDIR /app

EXPOSE 3000 2785

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null || exit 1

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/local/bin/carrybee-start.sh"]

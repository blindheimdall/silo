# SILO in a container: a headless server for a home server, a NAS or a VPS. Residents, workflows and keys live in the
# /data volume, the shared workspace in /workspace. The supervisor keeps SILO running inside the container.
# Build: docker build -t silo .    Run: docker compose up -d    The first start prints a setup address in the log.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    SILO_HOST=0.0.0.0 \
    PORT=3000 \
    SILO_DATA_DIR=/data \
    SILO_WORK_DIR=/workspace \
    SILO_CONTAINER=1

# Git, for environments through a Git repository (System, Environments and Git).
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
# SILO runs as the unprivileged node user, which owns only its data and workspace.
RUN mkdir -p /data /workspace && chown -R node:node /data /workspace

USER node
EXPOSE 3000
VOLUME ["/data", "/workspace"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "supervisor.mjs"]

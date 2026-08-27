FROM node:22-bookworm-slim

# better-sqlite3 native build deps + Claude Code CLI (needs git) + ca-certs
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public
COPY mcp-config.json ./mcp-config.json
# Tests ship in the image so they can be run where the app actually runs, against the real
# module graph and the real better-sqlite3 build:
#   docker exec maverick node /app/test/<name>.test.js
COPY test ./test

ENV NODE_ENV=production
ENV HOME=/home/node
ENV XDG_CONFIG_HOME=/home/node/.config

# Run as the unprivileged node user (uid 1000) to match host-mounted volumes
RUN mkdir -p /home/node/.config && chown -R node:node /home/node
USER node

EXPOSE 3000
CMD ["node", "server/index.js"]

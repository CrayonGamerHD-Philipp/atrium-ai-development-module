# Atrium aidev-Runner
#
# Build-Kontext ist die Repo-Wurzel (der Runner bündelt `modules/aidev/protocol.ts`):
#   docker build -f runner/Dockerfile -t atrium-aidev-runner .
#
# Versionen der Agent-CLIs per Build-Argument, z. B. --build-arg CODEX_VERSION=0.172.0

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------- Build: Bündel + Produktions-Abhängigkeiten
FROM ${NODE_IMAGE} AS build
WORKDIR /build
# node-pty wird unter Linux aus dem Quellcode gebaut
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*
COPY runner/package.json runner/package-lock.json runner/
RUN cd runner && npm ci --no-audit --no-fund
COPY modules/aidev/protocol.ts modules/aidev/protocol.ts
COPY runner/tsconfig.json runner/
COPY runner/scripts runner/scripts
COPY runner/src runner/src
RUN cd runner \
	&& npm run build \
	&& npm prune --omit=dev --no-audit --no-fund \
	&& node -e "require('node-pty')" \
	&& echo "node-pty ok"

# ---------------------------------------------------------------- Laufzeit
FROM ${NODE_IMAGE}
ARG CLAUDE_CODE_VERSION=2.1.331
ARG CODEX_VERSION=0.164.0
ARG GEMINI_CLI_VERSION=0.71.1

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl gnupg git openssh-client tini ripgrep less procps \
	&& install -d -m 0755 /etc/apt/keyrings \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund \
		"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
		"@openai/codex@${CODEX_VERSION}" \
		"@google/gemini-cli@${GEMINI_CLI_VERSION}" \
	&& npm cache clean --force

RUN groupadd --gid 10002 runner \
	&& useradd --uid 10002 --gid 10002 --create-home --home-dir /home/runner --shell /bin/bash runner \
	&& mkdir -p /work /app /accounts \
	&& chown runner:runner /work /home/runner /accounts

WORKDIR /app
COPY --from=build --chown=root:root /build/runner/package.json /app/package.json
COPY --from=build --chown=root:root /build/runner/node_modules /app/node_modules
COPY --from=build --chown=root:root /build/runner/dist /app/dist

ENV NODE_ENV=production \
	WORK_DIR=/work \
	HOME=/home/runner \
	SHELL=/bin/bash

USER runner
VOLUME ["/work", "/home/runner", "/accounts"]

# Lebenszeichen: der Hauptprozess (PID 2 unter tini) läuft
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
	CMD pgrep -f "/app/dist/main.js" > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/main.js"]
CMD ["start"]

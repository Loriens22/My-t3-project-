# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

# The optional CA mount is used only when validating in a proxied workspace.
RUN --mount=type=secret,id=proxy_ca \
    apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update \
    && apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca install -y --no-install-recommends \
       ca-certificates curl git libatomic1 openssh-client python3 tini \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --prefix /opt/t3 --no-audit --no-fund t3@0.0.45 opencode-ai@1.19.1 \
    && npm cache clean --force

ENV PATH="/opt/t3/node_modules/.bin:${PATH}" \
    T3_PHONE_ROOT="/data" \
    T3CODE_HOME="/data/t3" \
    OPENCODE_CONFIG="/data/opencode.json" \
    XDG_DATA_HOME="/data/data" \
    XDG_CONFIG_HOME="/data/config" \
    XDG_CACHE_HOME="/data/cache" \
    PORT="3773"

WORKDIR /app
COPY server/ /app/server/
EXPOSE 3773
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD curl --fail --silent "http://127.0.0.1:${PORT}/" >/dev/null || exit 1
ENTRYPOINT ["tini", "--", "bash", "/app/server/start.sh"]

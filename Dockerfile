FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git libatomic1 openssh-client python3 tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --prefix /opt/t3 --no-audit --no-fund t3@0.1.0 @opencode/cli@2.0.32 \
    && npm cache clean --force

ENV PATH="/opt/t3/node_modules/.bin:${PATH}" \
    T3_PHONE_ROOT="/data" \
    T3CODE_HOME="/data/t3" \
    OPENCODE_CONFIG="/data/opencode.json" \
    XDG_DATA_HOME="/data/data" \
    XDG_CONFIG_HOME="/data/config" \
    XDG_CACHE_HOME="/data/cache" \
    T3CODE_TRACE_MAX_BYTES="2097152" \
    T3CODE_TRACE_MAX_FILES="3" \
    PORT="3773"

WORKDIR /app
COPY server/ /app/server/
EXPOSE 3773
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD curl --fail --silent "http://127.0.0.1:${PORT}/.well-known/t3/environment" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(d.get("orchestrationProtocolVersion") != 2)'
ENTRYPOINT ["tini", "--", "bash", "/app/server/start.sh"]

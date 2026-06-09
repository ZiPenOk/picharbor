# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /media /config

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server

# Fix: if vite output placed index.html under dist/app/ instead of dist/ root,
# move it to the expected location so static file serving works.
RUN if [ -f dist/app/index.html ] && [ ! -f dist/index.html ]; then \
      mv dist/app/index.html dist/index.html; \
    fi

ENV PICHARBOR_HOST=0.0.0.0
ENV PICHARBOR_API_PORT=4177
ENV PICHARBOR_MEDIA_ROOT=/media
ENV PICHARBOR_CONFIG_ROOT=/config
ENV PICHARBOR_WEB_ROOT=/app/dist
ENV PICHARBOR_DEMO_DATA=false
ENV PICHARBOR_XCHINA_COOKIE_FILE=/config/cookies/xchina.txt
ENV PICHARBOR_PROXY_FILE=/config/proxy.txt
ENV PICHARBOR_FLARESOLVERR_FILE=/config/flaresolverr.txt
ENV PICHARBOR_XCHINA_USER_AGENT_FILE=/config/xchina-user-agent.txt

EXPOSE 4177
CMD ["npm", "start"]

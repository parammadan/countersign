# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS run
# LibreOffice converts Word agreements to PDF; fonts keep the layout close to Word's.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-writer-nogui fonts-liberation fonts-dejavu-core fonts-crosextra-carlito fonts-crosextra-caladea ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0 DATA_DIR=/data NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# pdfjs loads its worker module dynamically in Node; ship the whole package
COPY --from=build /app/node_modules/pdfjs-dist ./node_modules/pdfjs-dist
# pdfjs needs DOMMatrix in Node, polyfilled from its optional @napi-rs/canvas dependency
COPY --from=build /app/node_modules/@napi-rs ./node_modules/@napi-rs
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server.js"]

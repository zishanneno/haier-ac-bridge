FROM node:24-trixie-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json openapi.yaml compose.yaml compose.build.yaml ./
COPY src ./src
COPY web ./web
COPY test ./test
RUN pnpm check && pnpm test && pnpm build && pnpm prune --prod

FROM node:24-trixie-slim
LABEL org.opencontainers.image.source="https://github.com/zishanneno/haier-ac-bridge"
LABEL org.opencontainers.image.description="Local control for compatible Haier Haismart air conditioners"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data
WORKDIR /app
RUN groupadd --gid 10001 bridge && useradd --uid 10001 --gid bridge --no-create-home bridge && mkdir /app/data && chown bridge:bridge /app/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY package.json openapi.yaml LICENSE THIRD_PARTY_NOTICES.md ./
USER bridge
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

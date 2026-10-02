FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3300
ENV SUBGRAPH_URL=https://api.goldsky.com/api/public/project_cmupqw08z0f4301vmcyh60xs9/subgraphs/dogeos-pixel/prod/gn
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir .runtime && chown node:node .runtime
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/scripts/runtime.mjs /app/scripts/serve.mjs ./scripts/
COPY --from=build /app/src/generated ./src/generated
COPY --from=build /app/deployments/chikyu.json ./deployments/chikyu.json
COPY --from=build /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
USER node
EXPOSE 3300
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/DOGEOSxPIXEL/api/config');process.exit(r.ok?0:1)"
CMD ["npm", "start"]

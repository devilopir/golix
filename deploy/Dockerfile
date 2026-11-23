FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS client-build
ARG VITE_SERVER_URL
RUN pnpm --filter @golix/client build && pnpm --filter @golix/headless build:page

FROM nginx:1.29-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=client-build /app/packages/client/dist /usr/share/nginx/html
COPY --from=client-build /app/packages/headless/dist /usr/share/nginx/html/headless

FROM base AS server
ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "packages/server/src/main.ts"]

FROM base AS headless
CMD ["node", "--experimental-strip-types", "packages/headless/examples/admin-room.ts"]

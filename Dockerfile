FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
ARG VITE_POLLAR_PUBLISHABLE_KEY
ENV VITE_POLLAR_PUBLISHABLE_KEY=$VITE_POLLAR_PUBLISHABLE_KEY
RUN test -n "$VITE_POLLAR_PUBLISHABLE_KEY" && npm run typecheck && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["npm", "start"]

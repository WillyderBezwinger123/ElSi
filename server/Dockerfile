FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# @node-rs/argon2 ships a prebuilt musl binary: no compiler toolchain needed.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# FILES_DIR defaults to ./data/files; mount a volume at /app/data to keep uploads.
RUN mkdir -p /app/data/files && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]

FROM node:26-slim@sha256:14bf3eac4bf209d906d3c41256597d3ab1f926b2e93a79e9bdfe1efd32454239 AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@12.6.0 --ignore-scripts && pnpm install --prod --frozen-lockfile

FROM node:26-slim@sha256:14bf3eac4bf209d906d3c41256597d3ab1f926b2e93a79e9bdfe1efd32454239
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
USER node
EXPOSE 8080
CMD ["node", "node_modules/@tibia.sh/tibiawiki-mcp/dist/index.js", "serve", "--http", "--host", "0.0.0.0", "--port", "8080"]

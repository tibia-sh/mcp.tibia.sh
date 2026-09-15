FROM node:26-slim@sha256:14bf3eac4bf209d906d3c41256597d3ab1f926b2e93a79e9bdfe1efd32454239
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
USER node
EXPOSE 8080
CMD ["node", "node_modules/@tibia.sh/tibiawiki-mcp/dist/index.js", "serve", "--http", "--host", "0.0.0.0", "--port", "8080"]

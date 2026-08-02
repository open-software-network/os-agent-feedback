FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app/examples/node-mcp
COPY --chown=node:node examples/node-mcp/package.json examples/node-mcp/package-lock.json ./
COPY --chown=node:node backend/public/agent-feedback-node-0.3.1.tgz /app/backend/public/agent-feedback-node-0.3.1.tgz
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node examples/node-mcp/src ./src
ENV NODE_ENV=production
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node --eval "fetch('http://127.0.0.1:' + (process.env.PORT || 3002) + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["node", "src/index.js"]

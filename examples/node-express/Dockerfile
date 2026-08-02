FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app/examples/node-express
COPY --chown=node:node examples/node-express/package.json examples/node-express/package-lock.json ./
COPY --chown=node:node backend/public/agent-feedback-node-0.4.0.tgz /app/backend/public/agent-feedback-node-0.4.0.tgz
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node examples/node-express/src ./src
ENV NODE_ENV=production
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node --eval "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["node", "src/index.js"]

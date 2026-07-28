FROM node:22-alpine
WORKDIR /app
COPY sdk/node ./sdk/node
RUN cd sdk/node && npm ci && npm run build
COPY examples/node-fastify ./examples/node-fastify
RUN cd examples/node-fastify && npm install --omit=dev
WORKDIR /app/examples/node-fastify
ENV NODE_ENV=production
CMD ["npm", "start"]

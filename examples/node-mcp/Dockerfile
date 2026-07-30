FROM node:22-alpine
WORKDIR /app
COPY sdk/node ./sdk/node
RUN cd sdk/node && npm install && npm run build
COPY examples/node-mcp ./examples/node-mcp
RUN cd examples/node-mcp && npm install --omit=dev
WORKDIR /app/examples/node-mcp
ENV NODE_ENV=production
CMD ["npm", "start"]

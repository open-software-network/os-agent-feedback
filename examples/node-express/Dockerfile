FROM node:22-alpine
WORKDIR /app
COPY sdk/node ./sdk/node
RUN cd sdk/node && npm ci && npm run build
COPY examples/node-express ./examples/node-express
RUN cd examples/node-express && npm install --omit=dev
WORKDIR /app/examples/node-express
ENV NODE_ENV=production
CMD ["npm", "start"]

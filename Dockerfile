FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY server.js package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/me >/dev/null || exit 1
CMD ["node", "--no-warnings", "server.js"]

FROM node:22-alpine
ENV NODE_ENV=production PORT=8090 HOST=0.0.0.0 DATA_DIR=/data
WORKDIR /app
COPY package.json server.js admin.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --start-interval=2s CMD wget -qO- http://127.0.0.1:8090/api/config >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

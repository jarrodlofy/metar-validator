FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
RUN mkdir -p /app/data
ENV STORE_PATH=/app/data/metar_store.json
EXPOSE 3000
CMD ["node", "server.js"]

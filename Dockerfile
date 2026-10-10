# Always-on Vaani call server (server/vaani-ws.ts) for a host such as Fly.io, Render,
# Railway or Cloud Run. The dashboard and webhooks stay on Vercel.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx tsx scripts/build-knowledge.ts
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "server/main.ts"]

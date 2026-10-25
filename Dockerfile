# Stage 1: Build React Vite frontend
FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Production Server
FROM node:20-alpine
WORKDIR /app

# Install backend dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy backend source code
COPY backend ./backend

# Copy compiled frontend assets from client-builder
COPY --from=client-builder /app/client/dist ./client/dist

# Create persistent storage folder outside web root (Rule 8)
RUN mkdir -p /app/storage/documents

EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000

CMD ["node", "backend/src/server.js"]

# --- Stage 1: Build Frontend Assets ---
FROM node:18-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# --- Stage 2: Final Multi-Process Runner Container ---
FROM python:3.10-slim

# Install system dependencies, Node.js runtime, and build-essential for compiling wheels
RUN apt-get update && apt-get install -y curl gnupg libpq-dev gcc g++ make && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python requirements
COPY consumer/requirements.txt ./consumer-requirements.txt
RUN pip install --no-cache-dir -r consumer-requirements.txt

# Install Node dependencies for Express server
COPY api/package*.json ./api/
RUN cd api && npm install

# Copy application files
COPY . .

# Copy built frontend assets from builder stage
COPY --from=frontend-builder /app/frontend/dist ./api/public

# Ensure the XGBoost model exists in the consumer directory
RUN cp fraud/fraud_model.pkl consumer/fraud_model.pkl

EXPOSE 3001
ENV PORT=3001
ENV API_PORT=3001
ENV NODE_ENV=production
ENV MODEL_PATH=/app/consumer/fraud_model.pkl

CMD ["node", "api/server.js"]

FROM node:20-bookworm-slim

# Install system dependencies: Python 3, FFmpeg, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create Hugging Face Space user (UID 1000)
RUN useradd -m -u 1000 user

WORKDIR /app

# Setup Python virtual environment and install yt-dlp
RUN python3 -m venv /opt/venv
RUN /opt/venv/bin/pip install --no-cache-dir yt-dlp

# Copy package files and install production Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Setup downloads folder and ensure user 1000 has full permissions
RUN mkdir -p /app/downloads && chown -R 1000:1000 /app

# Switch to non-root user
USER 1000

ENV PATH="/opt/venv/bin:$PATH"
ENV NODE_ENV=production

CMD ["node", "server.js"]

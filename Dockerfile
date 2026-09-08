FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    xvfb \
    xauth \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Chromium + its system libraries (needed once per cookie refresh; runs under xvfb)
RUN npx playwright install chromium --with-deps || npx playwright install chromium

COPY . .

RUN mkdir -p /app/data

EXPOSE 4000

# Persist both state files DIRECTLY in the mounted volume (/app/data). A
# symlink bridge breaks: an atomic rename onto the cookie path does not follow
# symlinks and would write into the container layer instead, so cookies would
# be lost on every container recreation. Explicit env paths avoid symlinks.
ENV DB_PATH=/app/data/deeperseeker.db
ENV DEEPSEEKER_COOKIE_PATH=/app/data/aws_cookies_deepseek.json

ENV HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -sf http://localhost:4000/health || exit 1

CMD ["sh", "-c", "xvfb-run -a -s '-screen 0 1280x720x24' node server.js"]

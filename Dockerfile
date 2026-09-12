FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends dbus gnome-keyring libsecret-1-0 libusb-1.0-0 libudev1 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm install --global @ledgerhq/wallet-cli@2.1.0
COPY . .
RUN npm run build && mkdir -p /data /home/node/.local/share/keyrings /home/node/.local/state && chown -R node:node /data /home/node/.local
USER node
ENV RINGTREE_DATA_DIR=/data RINGTREE_LISTEN=0.0.0.0
EXPOSE 4318
CMD ["npm", "start"]

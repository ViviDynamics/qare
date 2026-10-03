# An app that sends mail, built from the tree: two files of node and nothing
# to install.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs smtp.mjs ./
USER node
CMD ["node", "server.mjs"]

# Build from the unpacked npm release. Run npm run build before a source-tree build.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS dependencies
WORKDIR /package
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund

FROM postgres:18.3@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db
LABEL org.opencontainers.image.title="Stepstone service"
LABEL org.opencontainers.image.source="https://github.com/max-miller1204/stepstone"
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/stepstone
COPY --from=dependencies /package/node_modules ./node_modules
COPY package.json ./
COPY dist ./dist
USER postgres
EXPOSE 4318
ENTRYPOINT ["node", "dist/server-cli.js"]
CMD ["help"]

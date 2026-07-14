FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

COPY homerail_node/src/runtime/plugin-runtime-runner.mjs /usr/local/bin/homerail-plugin-runtime
RUN chmod 0555 /usr/local/bin/homerail-plugin-runtime \
    && mkdir -p /opt/homerail/plugin \
    && chown 65532:65532 /opt/homerail/plugin

USER 65532:65532
ENTRYPOINT []
CMD ["/usr/local/bin/homerail-plugin-runtime", "--serve"]

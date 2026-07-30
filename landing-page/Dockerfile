FROM caddy:2.10.2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
# `COPY . /srv` so a newly added asset is served without editing this file.
# .dockerignore keeps the build/config files out of the context; Caddyfile has
# to stay in it for the COPY above, so strip it from the document root here.
COPY . /srv
RUN rm -f /srv/Caddyfile

EXPOSE 8080

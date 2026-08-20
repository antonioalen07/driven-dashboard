# Panel estático servido por Caddy. Imagen chica y sin build.
FROM caddy:2-alpine

COPY public/ /srv/
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 80

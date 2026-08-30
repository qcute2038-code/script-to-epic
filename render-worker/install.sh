#!/usr/bin/env bash
# Provisions the render worker on a bare Ubuntu box.
# Usage: sudo RENDER_TOKEN=xxx HOSTNAME_FQDN=54-226-77-248.sslip.io ./install.sh
set -euo pipefail

RENDER_TOKEN="${RENDER_TOKEN:?RENDER_TOKEN required}"
HOSTNAME_FQDN="${HOSTNAME_FQDN:?HOSTNAME_FQDN required}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ffmpeg curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https

# Node 22
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (automatic HTTPS via Let's Encrypt, no domain purchase needed - sslip.io)
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

mkdir -p /opt/scene-weaver /var/lib/scene-weaver/{out,work}
install -m 644 "$(dirname "$0")/server.mjs" /opt/scene-weaver/server.mjs

cat >/etc/systemd/system/scene-weaver.service <<EOF
[Unit]
Description=Scene Weaver render worker
After=network.target

[Service]
Environment=PORT=8787
Environment=RENDER_TOKEN=${RENDER_TOKEN}
Environment=RENDER_DIR=/var/lib/scene-weaver
ExecStart=/usr/bin/node /opt/scene-weaver/server.mjs
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/caddy/Caddyfile <<EOF
${HOSTNAME_FQDN} {
	reverse_proxy 127.0.0.1:8787 {
		transport http {
			read_timeout 0
			write_timeout 0
		}
	}
	request_body {
		max_size 100MB
	}
}
EOF

systemctl daemon-reload
systemctl enable --now scene-weaver
systemctl restart caddy
sleep 3
systemctl --no-pager --lines=5 status scene-weaver | tail -5
echo "worker: https://${HOSTNAME_FQDN}/health"

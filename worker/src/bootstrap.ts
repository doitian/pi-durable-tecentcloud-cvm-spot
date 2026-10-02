export interface BootstrapParams {
	hubUrl: string;
	agentToken: string;
	diskId: string;
	/** Only a disk the Hub just created may be formatted; anything else unreadable aborts the boot. */
	formatIfEmpty: boolean;
	nodeMajor: number;
	agentSudo: boolean;
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Cloud-init user data: mount the persistent disk at /data, install the toolchain, run the agent as `pi`. */
export function bootstrapScript(p: BootstrapParams): string {
	return `#!/bin/bash
set -euo pipefail
exec >>/var/log/pi-spot-bootstrap.log 2>&1
echo "== pi-spot bootstrap $(date -Is)"

HUB_URL=${quote(p.hubUrl)}
AGENT_TOKEN=${quote(p.agentToken)}
DISK_ID=${quote(p.diskId)}
FORMAT_IF_EMPTY=${p.formatIfEmpty ? 1 : 0}
NODE_MAJOR=${p.nodeMajor}
DATA=/data
META=http://metadata.tencentyun.com/latest/meta-data

INSTANCE_ID=$(curl -fsS --retry 20 --retry-delay 2 "$META/instance-id")

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git ripgrep jq curl ca-certificates xz-utils build-essential python3 tmux
if ! command -v gh >/dev/null; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -q
  apt-get install -y -q gh
fi

# The Hub attaches the data disk once this instance is RUNNING and the previous owner has released it.
ROOT_DISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" | head -1)
SERIAL="\${DISK_ID#disk-}"
DEV=""
for i in $(seq 1 1800); do
  for link in /dev/disk/by-id/virtio-*; do
    case "$link" in *"$SERIAL"*) DEV=$(readlink -f "$link"); break ;; esac
  done
  if [ -z "$DEV" ] && [ "$i" -gt 60 ]; then
    OTHERS=$(lsblk -dno NAME,TYPE | awk -v root="$ROOT_DISK" '$2 == "disk" && $1 != root { print $1 }')
    if [ "$(echo "$OTHERS" | grep -c .)" = 1 ]; then DEV="/dev/$OTHERS"; fi
  fi
  [ -n "$DEV" ] && break
  sleep 2
done
[ -n "$DEV" ] || { echo "data disk $DISK_ID never appeared"; exit 1; }
echo "data disk $DISK_ID is $DEV"

if ! blkid -p "$DEV" >/dev/null 2>&1; then
  if [ "$FORMAT_IF_EMPTY" = 1 ]; then
    mkfs.ext4 -q -L pidata "$DEV"
  else
    echo "refusing to format $DEV: it should already hold data"; exit 1
  fi
fi
mkdir -p "$DATA"
mountpoint -q "$DATA" || mount -o noatime "$DEV" "$DATA"
UUID=$(blkid -s UUID -o value "$DEV")
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $DATA ext4 noatime,nofail 0 2" >> /etc/fstab

getent group pi >/dev/null || groupadd -g 2000 pi
id pi >/dev/null 2>&1 || useradd -u 2000 -g 2000 -d "$DATA/home" -M -s /bin/bash pi
mkdir -p "$DATA/home" "$DATA/work" "$DATA/pi" "$DATA/cache"
chown pi:pi "$DATA/home" "$DATA/work" "$DATA/pi"
${p.agentSudo ? `echo 'pi ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/pi && chmod 440 /etc/sudoers.d/pi` : "# sudo disabled"}

# Node.js, cached on the data disk across instances.
NODE_VERSION=$(curl -fsSL https://nodejs.org/dist/index.json | jq -r --arg m "v$NODE_MAJOR." '[.[] | select(.version | startswith($m))][0].version')
NODE_DIR="$DATA/cache/node-$NODE_VERSION"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$DATA/cache"
  mv "$DATA/cache/node-$NODE_VERSION-linux-x64" "$NODE_DIR"
fi
for bin in node npm npx corepack; do ln -sf "$NODE_DIR/bin/$bin" "/usr/local/bin/$bin"; done

install -d -m 0755 /opt/pi-spot
curl -fsSL --retry 10 --retry-delay 3 "$HUB_URL/agent/agent.mjs" -o /opt/pi-spot/agent.mjs

umask 077
cat > /etc/pi-spot.env <<EOF
PI_HUB_URL=$HUB_URL
PI_INSTANCE_ID=$INSTANCE_ID
PI_AGENT_TOKEN=$AGENT_TOKEN
PI_DATA_DIR=$DATA
HOME=$DATA/home
PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin
EOF
umask 022

cat > /etc/systemd/system/pi-spot-agent.service <<EOF
[Unit]
Description=pi-spot agent
After=network-online.target data.mount
Wants=network-online.target

[Service]
User=pi
Group=pi
EnvironmentFile=/etc/pi-spot.env
WorkingDirectory=$DATA/home
ExecStart=/usr/local/bin/node /opt/pi-spot/agent.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now pi-spot-agent.service
echo "== bootstrap done $(date -Is)"
`;
}

export function encodeUserData(script: string): string {
	const bytes = new TextEncoder().encode(script);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

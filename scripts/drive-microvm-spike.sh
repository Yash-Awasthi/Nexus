#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Boots a Firecracker microVM with a 512 MB ext4 drive at /workspace and checks that
# writing 600 MB fails with ENOSPC. Needs /dev/kvm; on Docker Desktop (WSL2) run:
#
#   docker run --rm --privileged --pid=host alpine:3.20 nsenter -t 1 -m modprobe kvm_intel
#   docker run --rm --device /dev/kvm -v "$PWD/scripts:/spike:ro" alpine:3.20 sh /spike/drive-microvm-spike.sh
set -eu

FC_VERSION=v1.17.0
KERNEL_URL=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/x86_64/vmlinux-6.1.155
ALPINE_URL=https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.10-x86_64.tar.gz

[ -c /dev/kvm ] || { echo "FAIL: /dev/kvm missing"; exit 1; }
apk add --no-cache curl e2fsprogs >/dev/null
work=$(mktemp -d)
cd "$work"

curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-x86_64.tgz" | tar -xz
fc=$(find . -name "firecracker-$FC_VERSION-x86_64" -type f)
curl -fsSL -o vmlinux "$KERNEL_URL"

mkdir root
curl -fsSL "$ALPINE_URL" | tar -xz -C root
cat > root/init <<'EOF'
#!/bin/sh
mount -t proc proc /proc
mount -t devtmpfs dev /dev
mkdir -p /workspace
mount -t ext4 /dev/vdb /workspace
echo "SPIKE df: $(df -m /workspace | tail -1)"
if dd if=/dev/zero of=/workspace/big bs=1M count=600 2>/tmp/dd.err; then
  echo "SPIKE RESULT: dd succeeded"
else
  echo "SPIKE RESULT: dd failed: $(head -1 /tmp/dd.err)"
fi
echo "SPIKE written: $(du -m /workspace/big | cut -f1) MB"
sync
reboot -f
EOF
chmod +x root/init
mkfs.ext4 -q -d root rootfs.ext4 64M
mkfs.ext4 -q -m 0 workspace.ext4 512M

cat > vm.json <<EOF
{
  "boot-source": { "kernel_image_path": "vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1 init=/init" },
  "drives": [
    { "drive_id": "rootfs", "path_on_host": "rootfs.ext4", "is_root_device": true, "is_read_only": false },
    { "drive_id": "workspace", "path_on_host": "workspace.ext4", "is_root_device": false, "is_read_only": false }
  ],
  "machine-config": { "vcpu_count": 1, "mem_size_mib": 256 }
}
EOF

timeout 120 "$fc" --no-api --config-file vm.json > console.log 2>&1 || true
grep '^SPIKE' console.log || { tail -40 console.log; echo "FAIL: VM produced no result"; exit 1; }
grep -q 'SPIKE RESULT: dd failed: .*No space left on device' console.log || { echo "FAIL: quota not enforced"; exit 1; }
echo "PASS: 600 MB write hard-failed on the 512 MB workspace"

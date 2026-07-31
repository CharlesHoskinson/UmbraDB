#!/usr/bin/env bash
# Confirm a cgroup v2 memory cap actually constrains the page cache available to a bench process.
set -euo pipefail
cg=$(awk -F: '{print $3}' /proc/self/cgroup)
echo "cgroup: $cg"
echo "memory.max: $(cat /sys/fs/cgroup${cg}/memory.max)"
echo "memory.swap.max: $(cat /sys/fs/cgroup${cg}/memory.swap.max)"
# Read a 2 GiB file inside a 512 MiB cap; file cache cannot exceed the cap.
dd if=/dev/urandom of=/root/measure-proto/big.bin bs=1M count=2048 status=none
sync
cat /root/measure-proto/big.bin > /dev/null
echo "memory.current after reading 2GiB: $(cat /sys/fs/cgroup${cg}/memory.current)"
echo "file cache in cgroup: $(grep -E '^file ' /sys/fs/cgroup${cg}/memory.stat)"
rm -f /root/measure-proto/big.bin

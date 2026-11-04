#!/usr/bin/env python3
"""Times `du -sk` against Storagelyzer's scanner on the same folders.

    cargo build --release --example scan --manifest-path src-tauri/Cargo.toml
    python3 scripts/compare-du.py /System/Library /Applications /usr /Library

For each folder both tools run once to warm the file system cache, then `--runs`
times each, alternating. The table shows the median wall-clock time of the whole
process (start to exit) and whether both report the same total. Prints Markdown.

Storagelyzer never walks into another disk mounted inside a folder (an iOS simulator
image under /Library, for example); `--one-fs FOLDER` gives du `-x` for that folder so
both count the same files.
"""

import argparse
import datetime
import platform
import re
import statistics
import subprocess
import time

SCAN = "src-tauri/target/release/examples/scan"


def timed(cmd):
    start = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return time.perf_counter() - start, proc


def du_result(proc):
    kib = int(proc.stdout.split()[0])
    denied = sum("Permission denied" in line for line in proc.stderr.splitlines())
    return kib * 1024, denied


def scan_result(proc):
    m = re.search(r"on disk \((\d+) bytes\).*?(\d+) items \((\d+) files, (\d+) dirs\), (\d+) errors \((\d+) denied\)", proc.stdout)
    if not m:
        raise SystemExit(f"unexpected scanner output:\n{proc.stdout}\n{proc.stderr}")
    return int(m.group(1)), int(m.group(2)), int(m.group(6))


def sysctl(name):
    return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True).stdout.strip()


def human(b):
    for unit in ["B", "kB", "MB", "GB", "TB"]:
        if b < 1000:
            return f"{b:.1f} {unit}"
        b /= 1000
    return f"{b:.1f} PB"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folders", nargs="+")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--one-fs", metavar="FOLDER", action="append", default=[],
                    help="run du -skx on this folder (skip disks mounted inside it)")
    args = ap.parse_args()

    mem_gb = int(sysctl("hw.memsize")) / 2**30
    print(f"Measured {datetime.date.today().isoformat()} on {sysctl('machdep.cpu.brand_string')}, "
          f"{mem_gb:.0f} GB RAM, macOS {platform.mac_ver()[0]}; warm cache, median of {args.runs} runs.\n")
    print("| Folder | Items | Total on disk | du | Storagelyzer | Faster | Same total |")
    print("|---|---:|---:|---:|---:|---:|---|")
    raw = []
    for folder in args.folders:
        du_cmd = ["du", "-skx" if folder in args.one_fs else "-sk", folder]
        scan_cmd = [SCAN, folder]
        timed(du_cmd)
        timed(scan_cmd)
        du_times, scan_times = [], []
        for _ in range(args.runs):
            t, p = timed(du_cmd)
            du_times.append(t)
            du_bytes, du_denied = du_result(p)
            t, p = timed(scan_cmd)
            scan_times.append(t)
            scan_bytes, items, scan_denied = scan_result(p)
        du_med, scan_med = statistics.median(du_times), statistics.median(scan_times)
        same = "yes" if abs(du_bytes - scan_bytes) < 1024 else f"no ({human(abs(du_bytes - scan_bytes))} apart)"
        print(f"| `{folder}` | {items:,} | {human(scan_bytes)} | {du_med:.2f} s | {scan_med:.2f} s | "
              f"{du_med / scan_med:.1f}× | {same} |")
        raw.append((folder, " ".join(du_cmd), du_times, scan_times, du_bytes, scan_bytes, du_denied, scan_denied))

    print("\nAll runs, in seconds:\n")
    for folder, du_line, du_times, scan_times, du_bytes, scan_bytes, du_denied, scan_denied in raw:
        print(f"- `{folder}`: `{du_line}` {', '.join(f'{t:.2f}' for t in du_times)}; "
              f"Storagelyzer {', '.join(f'{t:.2f}' for t in scan_times)}. "
              f"Totals: du {du_bytes:,} B, Storagelyzer {scan_bytes:,} B; "
              f"unreadable folders: du {du_denied}, Storagelyzer {scan_denied}.")


if __name__ == "__main__":
    main()

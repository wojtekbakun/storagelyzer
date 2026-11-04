# Storagelyzer vs du

The measurements behind "Speed, measured" on the [website](https://wojtekbakun.github.io/storagelyzer/#compare). To repeat them:

```bash
cargo build --release --example scan --manifest-path src-tauri/Cargo.toml
python3 scripts/compare-du.py --runs 7 --one-fs /Library /System/Library /Applications /usr /Library
```

Measured 2026-11-04 on Apple M4 Max, 48 GB RAM, macOS 27.0.1; warm cache, median of 7 runs. Times are for the whole process, from start to exit.

| Folder | Items | Total on disk | du | Storagelyzer | Faster | Same total |
|---|---:|---:|---:|---:|---:|---|
| `/System/Library` | 464,611 | 29.6 GB | 5.83 s | 2.12 s | 2.7× | yes |
| `/Applications` | 410,348 | 38.3 GB | 3.80 s | 0.77 s | 4.9× | yes |
| `/usr` | 34,699 | 2.0 GB | 0.14 s | 0.05 s | 2.8× | yes |
| `/Library` | 141,555 | 6.7 GB | 0.78 s | 0.36 s | 2.2× | yes |

All runs, in seconds:

- `/System/Library`: `du -sk /System/Library` 5.06, 5.06, 5.99, 5.94, 5.65, 5.83, 6.08; Storagelyzer 2.18, 1.56, 2.18, 2.11, 1.95, 2.12, 2.18. Totals: du 29,574,684,672 B, Storagelyzer 29,574,684,672 B; unreadable folders: du 63, Storagelyzer 68.
- `/Applications`: `du -sk /Applications` 3.59, 3.97, 3.93, 3.93, 3.80, 3.30, 3.31; Storagelyzer 0.81, 0.77, 0.77, 0.81, 0.51, 0.85, 0.74. Totals: du 38,320,082,944 B, Storagelyzer 38,320,082,944 B; unreadable folders: du 0, Storagelyzer 0.
- `/usr`: `du -sk /usr` 0.14, 0.14, 0.14, 0.14, 0.14, 0.14, 0.14; Storagelyzer 0.05, 0.05, 0.06, 0.05, 0.05, 0.05, 0.05. Totals: du 1,969,618,944 B, Storagelyzer 1,969,618,944 B; unreadable folders: du 1, Storagelyzer 1.
- `/Library`: `du -skx /Library` 0.82, 0.75, 0.74, 0.78, 0.79, 0.79, 0.76; Storagelyzer 0.38, 0.24, 0.25, 0.36, 0.37, 0.34, 0.37. Totals: du 6,681,235,456 B, Storagelyzer 6,681,235,456 B; unreadable folders: du 10, Storagelyzer 16.

## Notes

- `/Library` gets `du -skx`. An iOS simulator runtime, a 17 GB disk image, is mounted at `/Library/Developer/CoreSimulator/Volumes/…`, and Storagelyzer never walks into other disks. Without `-x`, du counted 23.9 GB there against Storagelyzer's 6.7 GB.
- An earlier run the same day, five runs per folder, isn't used: the `/System/Library` times were still settling (du from 4.95 to 17.4 s), and `/Library` was compared without `-x`.
- A first scan with a cold cache is slower for both tools and isn't measured. The very first Storagelyzer scan of `/System/Library` that day took 15.8 s.
- The two tools count unreadable entries differently, so those numbers differ slightly. The size totals are what's compared.

## The Terminal output on the website

```
$ time du -sh /System/Library/* | sort -hr | head -12
 17G	/System/Library/AssetsV2
4.3G	/System/Library/PrivateFrameworks
954M	/System/Library/CoreServices
920M	/System/Library/Frameworks
812M	/System/Library/LinguisticData
811M	/System/Library/Templates
564M	/System/Library/Fonts
521M	/System/Library/Desktop Pictures
336M	/System/Library/Extensions
282M	/System/Library/ExtensionKit
260M	/System/Library/Assistant
179M	/System/Library/Components
real 5.66
```

The chart next to it is `docs/media/web/system-library.json`, the same folder scanned by `cargo run --release --example snapshot -- /System/Library docs/media/web/system-library.json 20000` (1.81 s, 464,611 items, the 19,924 biggest kept for the demo).

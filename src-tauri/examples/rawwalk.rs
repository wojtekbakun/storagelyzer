//! Lock-free parallel walk (no tree, no dedupe) to measure raw kernel
//! enumeration throughput vs. thread count:
//!
//!     STORAGELYZER_THREADS=4 cargo run --release --example rawwalk -- /System/Library

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Instant;
use storagelyzer_lib::scan::fs::{Dir, EntryType, Listing};

static ENTRIES: AtomicU64 = AtomicU64::new(0);

fn walk<'s>(s: &rayon::Scope<'s>, path: PathBuf) {
    let Ok(dir) = Dir::open(&path) else { return };
    let mut l = Listing::default();
    if dir.read(&path, &mut l).is_err() {
        return;
    }
    drop(dir);
    ENTRIES.fetch_add(l.entries.len() as u64, Relaxed);
    for e in &l.entries {
        if e.kind == EntryType::Dir && !e.mount_point {
            let p = path.join(OsStr::from_bytes(l.name(e)));
            s.spawn(move |s| walk(s, p));
        }
    }
}

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| ".".into()));
    let threads = storagelyzer_lib::scan::default_threads();
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
    let t = Instant::now();
    pool.install(|| rayon::scope(|s| walk(s, root.clone())));
    println!("{} entries, {:.2?}, threads={threads}", ENTRIES.load(Relaxed), t.elapsed());
}

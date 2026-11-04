//! Command-line benchmark of the scanner, handy to compare with `du`:
//!
//!     cargo run --release --example scan -- /Applications
//!     STORAGELYZER_THREADS=8 cargo run --release --example scan -- ~/Library

use parking_lot::RwLock;
use std::sync::Arc;
use std::time::Instant;
use storagelyzer_lib::scan::Scanner;
use storagelyzer_lib::tree::{SizeMode, Tree, ROOT};

fn human(b: u64) -> String {
    let units = ["B", "kB", "MB", "GB", "TB"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1000.0 && i < units.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    format!("{v:.2} {}", units[i])
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let root = std::fs::canonicalize(&arg).expect("path");
    let name = storagelyzer_lib::volumes::display_name(&root);
    let tree = Arc::new(RwLock::new(Tree::new(root.clone(), &name, 0)));
    let scanner = Scanner::new(tree.clone());
    let started = Instant::now();
    scanner.run(ROOT);
    let elapsed = started.elapsed();
    let t = tree.read();
    let r = t.node(ROOT);
    let s = scanner.stats.snapshot();
    println!(
        "{}: {} on disk ({} bytes), {} logical, {} items ({} files, {} dirs), {} errors ({} denied), {:.2?}, {} nodes, threads={}",
        root.display(),
        human(r.size),
        r.size,
        human(r.apparent),
        r.items,
        s.files,
        s.dirs,
        s.errors,
        s.denied,
        elapsed,
        t.len(),
        storagelyzer_lib::scan::default_threads()
    );
    for c in t.sorted_children(ROOT, SizeMode::Disk).into_iter().take(12) {
        let n = t.node(c);
        println!("  {:>10}  {}  flags={:#x}", human(n.size), t.name(c), n.flags);
    }
}

//! Scans one folder and writes it as JSON for the website's browser demo
//! (`docs/demo/?snapshot=<name>`): the real tree, pruned to its biggest items.
//!
//!     cargo run --release --example snapshot -- /System/Library docs/demo/snapshots/system-library.json 20000
//!
//! Each node is `[name, kind, disk, apparent, items, flags, mtime, children?]`, with
//! kind 0 = folder, 1 = file, 2 = anything else. A folder's numbers always cover
//! everything inside it; children too small to keep are left out, and the demo
//! draws their bytes as the grey "smaller items" slice, like the app does.

use parking_lot::RwLock;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use storagelyzer_lib::scan::Scanner;
use storagelyzer_lib::tree::{Kind, NodeId, SizeMode, Tree, ROOT};

const USAGE: &str = "usage: snapshot <folder> <out.json> [max nodes]";

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect(USAGE);
    let out = args.next().expect(USAGE);
    let max_nodes: usize = args.next().map(|s| s.parse().expect(USAGE)).unwrap_or(20_000);

    let root = std::fs::canonicalize(&path).expect("path");
    let name = storagelyzer_lib::volumes::display_name(&root);
    let tree = Arc::new(RwLock::new(Tree::new(root.clone(), &name, 0)));
    let scanner = Scanner::new(tree.clone());
    let started = Instant::now();
    scanner.run(ROOT);
    let elapsed = started.elapsed();
    let t = tree.read();
    let stats = scanner.stats.snapshot();

    // Keep the `max_nodes` biggest items. A folder is never smaller than anything
    // inside it, so everything above the cut forms one connected tree.
    let mut sizes = Vec::with_capacity(t.len());
    collect_sizes(&t, ROOT, &mut sizes);
    sizes.sort_unstable_by(|a, b| b.cmp(a));
    let cut = sizes.get(max_nodes).copied().unwrap_or(0);

    let mut kept = 0usize;
    let root_json = node_json(&t, ROOT, cut, &mut kept);
    let r = t.node(ROOT);
    let doc = json!({
        "meta": {
            "path": root.display().to_string(),
            "name": name,
            "scannedAt": SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            "elapsedMs": (elapsed.as_secs_f64() * 1000.0).round(),
            "disk": r.size,
            "apparent": r.apparent,
            "items": r.items,
            "files": stats.files,
            "dirs": stats.dirs,
            "errors": stats.errors,
            "denied": stats.denied,
            "threads": storagelyzer_lib::scan::default_threads(),
            "kept": kept,
            "minBytes": cut + 1,
        },
        "root": root_json,
    });
    let text = serde_json::to_string(&doc).expect("json");
    std::fs::write(&out, &text).expect("write");
    eprintln!(
        "{}: {} bytes on disk, {} items, scanned in {:.2?}; kept {} nodes over {} bytes -> {} ({} kB)",
        root.display(),
        r.size,
        r.items,
        elapsed,
        kept,
        cut,
        out,
        text.len() / 1000
    );
}

fn collect_sizes(t: &Tree, id: NodeId, out: &mut Vec<u64>) {
    for c in t.children(id) {
        out.push(t.node(c).size);
        collect_sizes(t, c, out);
    }
}

fn node_json(t: &Tree, id: NodeId, cut: u64, kept: &mut usize) -> Value {
    *kept += 1;
    let n = t.node(id);
    let kind = match n.kind {
        Kind::Dir => 0,
        Kind::File => 1,
        _ => 2,
    };
    let mut v = vec![
        json!(t.name(id).into_owned()),
        json!(kind),
        json!(n.size),
        json!(n.apparent),
        json!(n.items),
        json!(n.flags),
        json!(n.mtime),
    ];
    if n.kind == Kind::Dir {
        let kids: Vec<Value> = t
            .sorted_children(id, SizeMode::Disk)
            .into_iter()
            .filter(|&c| t.node(c).size > cut)
            .map(|c| node_json(t, c, cut, kept))
            .collect();
        if !kids.is_empty() {
            v.push(Value::Array(kids));
        }
    }
    Value::Array(v)
}

//! Prints what the clean-up assistant finds (protected places skipped):
//!
//!     cargo run --release --example cleanup

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
    let home = storagelyzer_lib::volumes::home_dir().expect("home");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let started = std::time::Instant::now();
    storagelyzer_lib::cleanup::analyze(&home, false, None, &mut |c| {
        println!(
            "{:<8} {:<20} {:>10}  action={:<12} entries={:<4} count={} denied={}  (+{:.1?})",
            c.group,
            c.id,
            human(c.size),
            c.action,
            c.entries.len(),
            c.count,
            c.denied,
            started.elapsed()
        );
        for e in c.entries.iter().take(5) {
            let mut tags = Vec::new();
            if e.locked {
                tags.push("locked".to_string());
            }
            if e.leftover {
                tags.push("leftover".to_string());
            }
            if e.paths.len() > 1 {
                tags.push(format!("{} paths", e.paths.len()));
            }
            if let Some(u) = e.used {
                tags.push(format!("used {} days ago", (now - u) / 86_400));
            }
            println!("           · {:>10}  {}  {}", human(e.size), e.name, tags.join(", "));
        }
    });
    println!("analysis took {:.2?}", started.elapsed());
}

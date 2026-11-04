//! Prints what `getattrlistbulk` reports for one directory (debug helper):
//!
//!     cargo run --example listdir -- /System/Volumes

use std::path::Path;
use storagelyzer_lib::scan::fs::{Dir, Listing};

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let path = Path::new(&arg);
    let dir = Dir::open(path).expect("open");
    let info = dir.info().expect("fstat");
    println!("{}: dev={} ino={}", path.display(), info.dev, info.ino);
    let mut listing = Listing::default();
    dir.read(path, &mut listing).expect("read");
    for e in &listing.entries {
        println!(
            "  {:<34} {:<8} dev={:<9} ino={:<20} mount={} trigger={} nlink={} size={} alloc={} flags={:#x} err={}",
            String::from_utf8_lossy(listing.name(e)),
            format!("{:?}", e.kind),
            e.dev,
            e.ino,
            e.mount_point as u8,
            e.trigger as u8,
            e.nlink,
            e.size,
            e.alloc,
            e.flags,
            e.error
        );
    }
}

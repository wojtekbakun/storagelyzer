//! What the App Sandbox lets the app see, without the UI. Put it in a minimal
//! .app (a sandboxed binary needs a bundle id), sign it like the App Store
//! build and run it:
//!
//!   cargo build --release --example sandbox_probe
//!   mkdir -p Probe.app/Contents/MacOS && cp target/release/examples/sandbox_probe Probe.app/Contents/MacOS/
//!   # Probe.app/Contents/Info.plist: CFBundleIdentifier, CFBundleExecutable = sandbox_probe
//!   codesign -f -s - --entitlements macos/Sandbox-local.entitlements Probe.app
//!   Probe.app/Contents/MacOS/sandbox_probe [--quicklook]

use std::path::Path;
use storagelyzer_lib::{macos, sandbox, volumes};

fn main() {
    println!("sandboxed: {}", sandbox::is_sandboxed());
    println!("$HOME: {:?}", std::env::var_os("HOME"));
    let home = volumes::home_dir().expect("home");
    println!("home_dir: {}", home.display());
    println!("root volume: {}", volumes::root_volume_name());
    for l in volumes::locations() {
        println!("location: {:7} {:30} granted={}", l.kind, l.path, l.granted);
    }
    println!("full disk access: {:?}", macos::has_full_disk_access());
    for p in [Path::new("/"), home.as_path(), Path::new("/Applications"), &home.join("Library/Caches")] {
        let listed = std::fs::read_dir(p).map(|rd| rd.count());
        println!(
            "{:40} read_dir={:?} bookmark={}",
            p.display(),
            listed.map_err(|e| e.kind()),
            sandbox::make_bookmark(p).is_some()
        );
    }
    if std::env::args().any(|a| a == "--quicklook") {
        // A file in the container is always accessible.
        let file = std::env::temp_dir().join("probe.txt");
        std::fs::write(&file, "Quick Look from the sandbox\n").unwrap();
        println!("quick look {}: {:?}", file.display(), macos::quick_look(&file));
        std::thread::sleep(std::time::Duration::from_secs(4));
    }
}

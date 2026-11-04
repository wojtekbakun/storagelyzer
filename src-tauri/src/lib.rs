pub mod apps;
pub mod cleanup;
pub mod commands;
pub mod macos;
pub mod scan;
pub mod tree;
pub mod volumes;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_locations,
            commands::start_scan,
            commands::rescan,
            commands::cancel_scan,
            commands::get_children,
            commands::get_rings,
            commands::get_size_gap,
            commands::get_ancestors,
            commands::get_node,
            commands::node_action,
            commands::trash_node,
            commands::get_denied,
            commands::open_full_disk_access,
            commands::initial_path,
            commands::frontend_log,
            commands::launch_flags,
            commands::analyze_cleanup,
            commands::cleanup_trash,
            commands::cleanup_action,
            commands::trash_info,
            commands::empty_trash,
            commands::reveal_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

//! 应用入口与组装。

mod annotations;
mod commands;
mod defect_images;
mod defects;
mod export;
mod pcs;
mod tiles_protocol;
mod vips;

use tauri::Emitter;

/// 打开 WebView 的开发者工具。
///
/// Tauri **不会**自动给 F12 / Ctrl+Shift+I 绑定快捷键 —— debug 构建里 devtools
/// 是编进去了,但得有人主动调 `open_devtools()`。前端按键后调这个命令。
///
/// release 构建没编 devtools,命令仍然注册着,返回一句明确的错误,
/// 而不是让前端拿到「命令不存在」这种看不出原因的消息。
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = window;
        Err("开发者工具只在 debug 构建里可用".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        // 更新逻辑全在前端(见 src/components/UpdatePrompt.vue),
        // Rust 侧只负责下载、验签和调起安装器
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(commands::SliceState::default())
        // 异步版:vips 瓦片是磁盘 IO,同步版在 macOS 上会跑在主线程并掉帧
        .register_asynchronous_uri_scheme_protocol(tiles_protocol::SCHEME, tiles_protocol::handle)
        .invoke_handler(tauri::generate_handler![
            commands::vips_info,
            commands::pick_image,
            commands::prepare_image,
            commands::cancel_slicing,
            commands::cache_stats,
            commands::clear_cache,
            annotations::load_annotations,
            annotations::save_annotations,
            pcs::load_pcs_layout,
            defects::load_defects,
            defect_images::fetch_defect_image,
            export::export_regions_csv,
            export::export_crops,
            open_devtools,
        ])
        .setup(|app| {
            // 启动就自检 vips,把结果推给前端。
            // 与其等用户打开图时才失败,不如一开始就说清楚缺什么。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let payload = match commands::vips_info(handle.clone()) {
                    Ok(info) => serde_json::json!({
                        "available": true,
                        "version": info.version,
                        "path": info.path,
                        "hasDzsave": info.has_dzsave,
                    }),
                    Err(message) => serde_json::json!({
                        "available": false,
                        "message": message,
                    }),
                };
                let _ = handle.emit("vips-status", payload);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

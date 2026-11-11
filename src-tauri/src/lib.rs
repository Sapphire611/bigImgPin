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
/// Tauri **不会**自动给 F12 / Ctrl+Shift+I 绑定快捷键,得有人主动调
/// `open_devtools()`。前端按键后调这个命令。
///
/// Cargo.toml 里给 tauri 开了 `devtools` 特性,所以 **release 构建也能打开** ——
/// 现场排查(比如别的电脑取不到 MinIO 图片、网络请求是什么样)时只有这一条路。
/// 默认的 release 构建会把这段能力裁掉,`open_devtools` 直接是空实现。
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) -> Result<(), String> {
    window.open_devtools();
    Ok(())
}

/// 装一个全局 rustls crypto provider。
///
/// 必须排在任何 reqwest Client 构建之前(包括插件初始化):tauri-plugin-updater
/// 把 reqwest 配成了 `rustls-no-provider`,没有全局 provider 时
/// `Client::builder().build()` 会 **panic**,不是返回错误。缺陷图请求走的正是
/// reqwest —— 少了这一步,前端会永远停在「正在读取缺陷图…」,而且看不到任何错误。
/// (2026-11-10 就是这个问题。)
///
/// ring 已经由 updater 编进依赖树,复用它,不再拉一份 aws-lc-rs。
fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_crypto_provider();

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

#[cfg(test)]
mod tests {
    /// 没装 provider 时这个 build 会 panic —— 回归测试守着「缺陷图又永远转圈」。
    #[test]
    fn reqwest_client_can_be_built() {
        super::install_crypto_provider();
        reqwest::Client::builder().build().unwrap();
    }
}

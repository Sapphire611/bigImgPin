//! 暴露给前端的命令。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::tiles_protocol;
use crate::vips::{self, SliceOptions, TileFormat};

/// 正在进行的切片任务,用于支持取消。
#[derive(Default)]
pub struct SliceState {
    pub current: Mutex<Option<u32>>,
}

/// 切片默认参数。数值来自真实 20.5 亿像素样图的实测对比。
///
/// 瓦片 1024 而不是 DZI 惯用的 256:瓦片越大,deflate/LZ77 在单张瓦片内
/// 能匹配到的重复图案越多,压缩率越高。实测 2048 比 512 省约 40% 体积,
/// 但 2048 瓦片解码后每张 16MB,OSD 缓存几张就是几百 MB,所以取中。
///
/// 格式用 WebP 无损:同等内容比 PNG 小约 35%,且实测与 PNG 逐像素相减
/// 最大差值为 0(真无损)。不用 JPEG —— 这张图是边缘锐利的版图类图像,
/// JPEG 会在每条边上产生振铃伪影,可能被误读成真实结构。
const DEFAULT_TILE_SIZE: u32 = 1024;
const DEFAULT_OVERLAP: u32 = 1;
/// 仅 JPEG 用得上
const DEFAULT_QUALITY: u32 = 90;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SliceParams {
    pub tile_size: Option<u32>,
    pub quality: Option<u32>,
    /// "jpg" 或 "png"。留空用默认。
    pub tile_format: Option<String>,
}

impl SliceParams {
    fn resolve(&self) -> SliceOptions {
        SliceOptions {
            tile_size: self.tile_size.unwrap_or(DEFAULT_TILE_SIZE),
            overlap: DEFAULT_OVERLAP,
            quality: self.quality.unwrap_or(DEFAULT_QUALITY),
            tile_format: match self.tile_format.as_deref() {
                Some("png") => TileFormat::Png,
                Some("jpg") | Some("jpeg") => TileFormat::Jpeg,
                _ => TileFormat::Webp,
            },
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VipsInfo {
    pub version: String,
    pub path: String,
    pub has_dzsave: bool,
    pub header_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreparedImage {
    pub id: String,
    pub source_path: String,
    pub width: u32,
    pub height: u32,
    pub tile_size: u32,
    pub tile_overlap: u32,
    /// OpenSeadragon 的 `fileFormat`(瓦片扩展名,不含点)
    pub file_format: String,
    /// 已含平台前缀、结尾带 `/`,可直接给 DziTileSource
    pub tiles_url: String,
    pub from_cache: bool,
    pub tile_count_estimate: u64,
    pub cache_bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TileProgress {
    pub id: String,
    pub percent: u32,
    pub tiles_done: u64,
    pub tiles_total: u64,
    pub phase: String,
}

/// 启动时自检,让前端能提前告诉用户 vips 是否可用。
#[tauri::command]
pub fn vips_info(app: AppHandle) -> Result<VipsInfo, String> {
    let vips = vips::resolve_vips(&app)?;

    let out = std::process::Command::new(&vips)
        .arg("--version")
        .output()
        .map_err(|e| format!("无法执行 {}: {e}", vips.display()))?;

    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let has_dzsave = vips::check_dzsave(&vips).is_ok();

    Ok(VipsInfo {
        version,
        path: vips.display().to_string(),
        has_dzsave,
        header_path: vips
            .parent()
            .map(|dir| dir.join("vipsheader").display().to_string()),
    })
}

/// 打开文件选择对话框。放在 Rust 侧可以直接拿到绝对路径。
#[tauri::command]
pub async fn pick_image(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .add_filter(
            "图片",
            &["jpg", "jpeg", "png", "tif", "tiff", "bmp", "webp", "vips"],
        )
        .blocking_pick_file();

    Ok(picked
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string()))
}

/// 核心命令:命中缓存则秒回,否则切片。
///
/// **必须是 async**:Tauri 的同步命令跑在主线程,一个几分钟的切片会把界面冻死。
/// 内部再用 `spawn_blocking` 包住阻塞的 `child.wait()`,避免占死异步运行时的工作线程。
#[tauri::command]
pub async fn prepare_image(
    app: AppHandle,
    path: String,
    params: Option<SliceParams>,
) -> Result<PreparedImage, String> {
    let opts = params.unwrap_or_default().resolve();

    let source = PathBuf::from(&path);
    let meta = std::fs::metadata(&source).map_err(|e| format!("无法读取文件 {path}: {e}"))?;

    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let id = cache_key(&path, meta.len(), modified, &opts);

    let cache_root = cache_root(&app)?;
    let final_dir = cache_root.join(&id);
    let dzi_path = final_dir.join("image.dzi");

    // ---- 命中缓存 ----
    // 必须同时确认 .dzi 和瓦片目录都在。只查 .dzi 会命中被中断留下的残缺缓存。
    if dzi_path.is_file() && final_dir.join("image_files").is_dir() {
        let image_meta = vips::probe_image(&vips::resolve_vips(&app)?, &source)?;
        return Ok(build_result(
            id, path, image_meta, opts,
            true,
            dir_size(&final_dir),
        ));
    }

    // ---- 未命中,开始切片 ----
    let vips_exe = vips::resolve_vips(&app)?;
    vips::check_dzsave(&vips_exe)?;
    let image_meta = vips::probe_image(&vips_exe, &source)?;

    let tiles_total = vips::expected_tile_count(image_meta.width, image_meta.height, opts.tile_size);

    std::fs::create_dir_all(&cache_root).map_err(|e| format!("无法创建缓存目录: {e}"))?;

    // 切到临时目录,成功后整体改名。中途崩溃不会留下被误判为「命中」的半成品。
    let tmp_dir = cache_root.join(format!(".tmp-{id}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("无法创建临时目录: {e}"))?;
    let out_base = tmp_dir.join("image");

    let app_for_task = app.clone();
    let id_for_task = id.clone();
    let tmp_for_task = tmp_dir.clone();
    let final_for_task = final_dir.clone();
    let source_for_task = source.clone();
    let progress_id = id.clone();

    let _ = app.emit(
        "tile-progress",
        TileProgress {
            id: progress_id.clone(),
            percent: 0,
            tiles_done: 0,
            tiles_total,
            phase: "slicing".into(),
        },
    );

    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut child = vips::spawn_dzsave(&vips_exe, &source_for_task, &out_base, opts)?;

        // 记录 pid 以便取消
        {
            let state = app_for_task.state::<SliceState>();
            *state.current.lock().unwrap() = Some(child.id());
        }

        // 真进度:vips 自己报的百分比
        {
            let app = app_for_task.clone();
            let id = id_for_task.clone();
            vips::forward_progress(&mut child, move |percent| {
                let _ = app.emit(
                    "tile-progress",
                    TileProgress {
                        id: id.clone(),
                        percent,
                        tiles_done: 0,
                        tiles_total,
                        phase: "slicing".into(),
                    },
                );
            });
        }

        // 兜底进度:数已经落盘的瓦片文件
        let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let app = app_for_task.clone();
            let id = id_for_task.clone();
            let files_dir = sibling_files_dir(&out_base);
            let stop = stop_flag.clone();
            std::thread::spawn(move || {
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    let done = vips::count_files(&files_dir);
                    if done == 0 {
                        continue;
                    }
                    let percent =
                        ((done as f64 / tiles_total.max(1) as f64) * 100.0) as u32;
                    let _ = app.emit(
                        "tile-progress",
                        TileProgress {
                            id: id.clone(),
                            percent: percent.min(99),
                            tiles_done: done,
                            tiles_total,
                            phase: "slicing".into(),
                        },
                    );
                }
            });
        }

        let status = child.wait().map_err(|e| format!("等待 vips 失败: {e}"))?;
        stop_flag.store(true, std::sync::atomic::Ordering::Relaxed);

        {
            let state = app_for_task.state::<SliceState>();
            *state.current.lock().unwrap() = None;
        }

        if !status.success() {
            let _ = std::fs::remove_dir_all(&tmp_for_task);
            return Err(format!(
                "vips dzsave 失败(退出码 {status})。请检查文件是否损坏或格式是否受支持。"
            ));
        }

        // 原子改名
        let _ = std::fs::remove_dir_all(&final_for_task);
        std::fs::rename(&tmp_for_task, &final_for_task)
            .map_err(|e| format!("落盘失败: {e}"))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("切片任务异常: {e}"))?;

    if let Err(e) = outcome {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }

    let _ = app.emit(
        "tile-progress",
        TileProgress {
            id: id.clone(),
            percent: 100,
            tiles_done: tiles_total,
            tiles_total,
            phase: "done".into(),
        },
    );

    Ok(build_result(
        id,
        path,
        image_meta,
        opts,
        false,
        dir_size(&final_dir),
    ))
}

/// 取消正在进行的切片。
#[tauri::command]
pub fn cancel_slicing(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SliceState>();
    let pid = state.current.lock().unwrap().take();
    if let Some(pid) = pid {
        kill_process(pid);
    }
    Ok(())
}

#[cfg(unix)]
fn kill_process(pid: u32) {
    // SIGKILL 而非 SIGTERM:vips 可能忽略 TERM 继续跑完,而用户要的是立刻停
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_process(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F", "/T"])
        .output();
}

/// 缓存占用与清理。
#[tauri::command]
pub fn cache_stats(app: AppHandle) -> Result<(u64, u32), String> {
    let root = cache_root(&app)?;
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok((0, 0));
    };
    let mut total = 0u64;
    let mut count = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // 跳过没切完的临时目录
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(".tmp-"))
        {
            continue;
        }
        total += dir_size(&path);
        count += 1;
    }
    Ok((total, count))
}

#[tauri::command]
pub fn clear_cache(app: AppHandle) -> Result<(), String> {
    let root = cache_root(&app)?;
    let _ = std::fs::remove_dir_all(&root);
    Ok(())
}

// ---------------------------------------------------------------- 辅助

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    // 用 app_local_data_dir 而非 app_data_dir:瓦片是可再生的缓存数据,
    // 不该占用会被漫游同步的数据配额。
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))?;
    Ok(base.join("tiles"))
}

fn build_result(
    id: String,
    source_path: String,
    meta: vips::ImageMeta,
    opts: SliceOptions,
    from_cache: bool,
    cache_bytes: u64,
) -> PreparedImage {
    PreparedImage {
        tiles_url: tiles_protocol::tiles_url(&id),
        tile_count_estimate: vips::expected_tile_count(meta.width, meta.height, opts.tile_size),
        id,
        source_path,
        width: meta.width,
        height: meta.height,
        tile_size: opts.tile_size,
        tile_overlap: opts.overlap,
        file_format: opts.tile_format.extension().to_string(),
        from_cache,
        cache_bytes,
    }
}

/// `<base>.dzi` 对应的 `<base>_files` 目录。
fn sibling_files_dir(out_base: &Path) -> PathBuf {
    let name = out_base
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    out_base.with_file_name(format!("{name}_files"))
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let p = entry.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                entry.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// 缓存键。
///
/// 包含切片参数 —— 否则改了瓦片尺寸或格式会命中旧缓存,拿到一批尺寸不符的瓦片,
/// 表现为图像错位。用 DefaultHasher 而非 sha256:这里只需要碰撞概率可忽略,
/// 不需要密码学强度,不值得为它引一个依赖。
fn cache_key(path: &str, len: u64, modified: u64, opts: &SliceOptions) -> String {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    len.hash(&mut hasher);
    modified.hash(&mut hasher);
    opts.tile_size.hash(&mut hasher);
    opts.overlap.hash(&mut hasher);
    opts.tile_format.extension().hash(&mut hasher);
    if opts.tile_format == TileFormat::Jpeg {
        opts.quality.hash(&mut hasher);
    }

    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg_opts(tile: u32, q: u32) -> SliceOptions {
        SliceOptions {
            tile_size: tile,
            overlap: 1,
            quality: q,
            tile_format: TileFormat::Jpeg,
        }
    }

    #[test]
    fn cache_key_is_stable_for_same_inputs() {
        let a = cache_key("/x/a.png", 100, 5, &jpeg_opts(512, 90));
        let b = cache_key("/x/a.png", 100, 5, &jpeg_opts(512, 90));
        assert_eq!(a, b);
    }

    #[test]
    fn cache_key_changes_with_content() {
        let base = cache_key("/x/a.png", 100, 5, &jpeg_opts(512, 90));
        assert_ne!(base, cache_key("/x/a.png", 101, 5, &jpeg_opts(512, 90)));
        assert_ne!(base, cache_key("/x/a.png", 100, 6, &jpeg_opts(512, 90)));
        assert_ne!(base, cache_key("/x/b.png", 100, 5, &jpeg_opts(512, 90)));
    }

    #[test]
    fn cache_key_changes_with_slice_params() {
        // 这条是防错位的关键:改了参数必须换目录
        let base = cache_key("/x/a.png", 100, 5, &jpeg_opts(512, 90));
        assert_ne!(base, cache_key("/x/a.png", 100, 5, &jpeg_opts(256, 90)));
        assert_ne!(base, cache_key("/x/a.png", 100, 5, &jpeg_opts(512, 80)));

        let png = SliceOptions {
            tile_format: TileFormat::Png,
            ..jpeg_opts(512, 90)
        };
        assert_ne!(base, cache_key("/x/a.png", 100, 5, &png));
    }

    #[test]
    fn png_quality_does_not_affect_key() {
        // PNG 是无损的,质量参数对它无意义,不该造成缓存分裂
        let png = SliceOptions {
            tile_format: TileFormat::Png,
            ..jpeg_opts(512, 90)
        };
        let png_other_q = SliceOptions {
            quality: 50,
            ..png
        };
        assert_eq!(
            cache_key("/x/a.png", 100, 5, &png),
            cache_key("/x/a.png", 100, 5, &png_other_q)
        );
    }

    #[test]
    fn sibling_files_dir_appends_suffix() {
        let d = sibling_files_dir(Path::new("/tmp/abc/image"));
        assert_eq!(d, PathBuf::from("/tmp/abc/image_files"));
    }
}

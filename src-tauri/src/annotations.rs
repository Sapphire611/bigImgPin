//! 标注(框 / 辅助线)的落盘与读回。
//!
//! 文件放源图旁边:`<图名>.bigimgpin.json`。图拷给别人时标注跟着走 —— 这是主要路径。
//! 同目录不可写(只读盘、网络盘、塞在 Program Files 里的样图)时退回应用数据目录:
//! 写不进去顶多是「标注带不走」,直接报错则是「压根存不了」,后者没法用。
//!
//! 为什么是外部文件而不是塞进瓦片缓存目录:瓦片是可再生的缓存,清缓存不该把标注一起清掉;
//! 而且标注是用户唯一的产出物,得放在用户看得见、能备份、能提交进版本库的地方。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 当前文件格式版本。读到更高的版本会拒绝加载,见 `load_annotations`。
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    /// 竖线,约束 x
    X,
    /// 横线,约束 y
    Y,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationRegion {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub color: String,
    /// 名字。界面上还没地方填(留到「标注编辑」那一块),但格式先占住 ——
    /// 加一个可选字段比事后提升版本号便宜得多。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationGuide {
    pub axis: Axis,
    pub pos: f64,
    pub color: String,
}

/// 记录这份标注是贴着哪张图存的。加载时拿它和当前文件对照,见 `mismatch_reason`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationSource {
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// 源文件字节数
    pub size: u64,
    /// 源文件修改时间(Unix 秒)。**只存不判** —— 见 `mismatch_reason`。
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDoc {
    pub version: u32,
    pub source: AnnotationSource,
    pub regions: Vec<AnnotationRegion>,
    pub guides: Vec<AnnotationGuide>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    /// 实际写到哪个文件了。源图旁边写不进去时是应用数据目录里的那份。
    pub file_path: String,
    /// true 表示没能写到源图旁边。界面据此提示「换台机器带不走」。
    pub fallback: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedAnnotations {
    /// 没有标注文件时为 None —— 第一次打开本来就没有,不是错误。
    pub doc: Option<AnnotationDoc>,
    pub file_path: Option<String>,
    /// 标注和当前图对不上时的说明,给用户看的。对不上不阻止加载,但要说清楚。
    pub mismatch: Option<String>,
    /// 文件在、但读不了(JSON 坏了 / 版本更高)。此时**前端必须停用自动保存**,
    /// 否则第一次改动就会把用户原文件覆盖掉。
    pub failure: Option<String>,
}

// ---------------------------------------------------------------- 命令

/// 读回标注。任何「读不到」的情况都走 Ok 里的 `failure` 字段而不是 Err ——
/// Err 在前端是「打开图片失败」的语义,不该被一份坏掉的标注文件触发。
#[tauri::command]
pub async fn load_annotations(app: AppHandle, path: String) -> Result<LoadedAnnotations, String> {
    tauri::async_runtime::spawn_blocking(move || load_sync(&app, &path))
        .await
        .map_err(|e| format!("读取标注任务失败: {e}"))
}

/// 保存标注。
///
/// 必须是 async(同步命令跑在主线程),内部再用 `spawn_blocking`:
/// 往网络盘写一个小文件也可能阻塞几百毫秒,不能占着异步运行时的工作线程。
#[tauri::command]
pub async fn save_annotations(
    app: AppHandle,
    path: String,
    width: u32,
    height: u32,
    regions: Vec<AnnotationRegion>,
    guides: Vec<AnnotationGuide>,
) -> Result<SaveOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_sync(&app, &path, width, height, regions, guides)
    })
    .await
    .map_err(|e| format!("保存标注任务失败: {e}"))?
}

// ---------------------------------------------------------------- 实现

fn load_sync(app: &AppHandle, path: &str) -> LoadedAnnotations {
    let image = PathBuf::from(path);

    // 源图旁边优先。存在就认它 —— 不去看兜底位置,免得同一次打开读回来两份不同的标注。
    let sidecar = sidecar_path(&image);
    let (file, from_fallback) = if sidecar.is_file() {
        (sidecar, false)
    } else {
        match fallback_path(app, &image) {
            Some(p) if p.is_file() => (p, true),
            _ => return LoadedAnnotations::empty(),
        }
    };

    let file_path = Some(file.display().to_string());

    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) => {
            return LoadedAnnotations::failed(file_path, format!("读取失败:{error}"))
        }
    };

    let doc: AnnotationDoc = match serde_json::from_str(&text) {
        Ok(doc) => doc,
        Err(error) => {
            return LoadedAnnotations::failed(file_path, format!("JSON 解析失败:{error}"))
        }
    };

    if doc.version > FORMAT_VERSION {
        return LoadedAnnotations::failed(
            file_path,
            format!(
                "文件版本是 {},本版只认到 {FORMAT_VERSION}",
                doc.version
            ),
        );
    }

    // 这里只查文件大小。图像尺寸(w/h)由前端核对 —— 它手上本来就有
    // PreparedImage 的宽高,而在 Rust 侧查一次要额外起一个 vipsheader 进程。
    let Ok(meta) = std::fs::metadata(&image) else {
        return LoadedAnnotations::failed(file_path, "读不到源图信息".into());
    };

    let mismatch = if from_fallback {
        Some("标注存在应用数据目录,不在源图旁边".to_string())
    } else {
        mismatch_reason(&doc.source, meta.len())
    };

    LoadedAnnotations {
        doc: Some(doc),
        file_path,
        mismatch,
        failure: None,
    }
}

impl LoadedAnnotations {
    fn empty() -> Self {
        Self {
            doc: None,
            file_path: None,
            mismatch: None,
            failure: None,
        }
    }

    fn failed(file_path: Option<String>, reason: String) -> Self {
        Self {
            doc: None,
            file_path,
            mismatch: None,
            failure: Some(reason),
        }
    }
}

fn save_sync(
    app: &AppHandle,
    path: &str,
    width: u32,
    height: u32,
    regions: Vec<AnnotationRegion>,
    guides: Vec<AnnotationGuide>,
) -> Result<SaveOutcome, String> {
    let image = PathBuf::from(path);
    let meta = std::fs::metadata(&image).map_err(|e| format!("读不到源图信息: {e}"))?;

    let doc = AnnotationDoc {
        version: FORMAT_VERSION,
        source: AnnotationSource {
            path: path.to_string(),
            width,
            height,
            size: meta.len(),
            mtime: mtime_secs(&meta),
        },
        regions,
        guides,
    };

    // pretty:这文件用户是能打开看的,也会进版本库,别输出成一行
    let text = serde_json::to_string_pretty(&doc).map_err(|e| format!("序列化失败: {e}"))?;

    let sidecar = sidecar_path(&image);
    match write_atomic(&sidecar, &text) {
        Ok(()) => Ok(SaveOutcome {
            file_path: sidecar.display().to_string(),
            fallback: false,
        }),
        Err(error) => {
            // 退回应用数据目录。把原始错误带上 —— 两个位置都失败时,
            // 光看兜底位置报的错会以为是应用数据目录的问题。
            let Some(fallback) = fallback_path(app, &image) else {
                return Err(format!("{} 写入失败:{error}", sidecar.display()));
            };
            if let Some(parent) = fallback.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
            }
            write_atomic(&fallback, &text).map_err(|second| {
                format!("源图目录写入失败({error});数据目录也写入失败({second})")
            })?;

            Ok(SaveOutcome {
                file_path: fallback.display().to_string(),
                fallback: true,
            })
        }
    }
}

/// 判断这份标注还能不能贴到当前这张图上。
///
/// 只看**文件大小**,不看 mtime:把图拷到另一台机器、从压缩包解出来,内容一模一样
/// 但 mtime 全变了。拿 mtime 报警只会制造假警报,而假警报喊几次之后,
/// 真的那条也会被一起无视。
///
/// 尺寸(w/h)不在这里判 —— 加载时前端手上就有当前尺寸,没必要绕一圈。
fn mismatch_reason(source: &AnnotationSource, current_size: u64) -> Option<String> {
    if source.size == current_size {
        return None;
    }
    Some(format!(
        "源文件大小已从 {} 字节变成 {} 字节,这张图很可能被换过了",
        source.size, current_size
    ))
}

/// 标注文件路径:`<图名>.bigimgpin.json`。
///
/// 是**追加**而不是替换扩展名 —— 同目录下 `a.tif` 和 `a.png` 是两张不同的图,
/// 替换扩展名会让它们共用一份标注。
fn sidecar_path(image: &Path) -> PathBuf {
    let mut name = image.file_name().unwrap_or_default().to_os_string();
    name.push(".bigimgpin.json");
    image.with_file_name(name)
}

/// 源图旁边写不进去时的兜底位置。
///
/// 用路径的 hash 当文件名,而不是把路径编码进文件名 ——
/// 深目录下的长路径编码出来很容易超 Windows 的路径长度上限。
fn fallback_path(app: &AppHandle, image: &Path) -> Option<PathBuf> {
    use std::hash::{Hash, Hasher};

    let base = app.path().app_local_data_dir().ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    // 不用 canonicalize:文件可能已经不在了,而这时恰恰最需要知道该往哪存
    image.to_string_lossy().hash(&mut hasher);
    Some(base.join("annotations").join(format!("{:016x}.json", hasher.finish())))
}

/// 先写临时文件再 rename。
///
/// 和瓦片落盘同一个理由:中途崩了不会留下半截 JSON,而半截 JSON 下次会被读成
/// 「有标注文件但解析失败」,然后用户就要面对一个既打不开也存不进去的僵局。
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, text)?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        // rename 失败(目标被占用、跨卷等)时把临时文件收拾掉,
        // 不能往用户的图片目录里留下垃圾
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(())
}

fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_appends_instead_of_replacing_extension() {
        // 这条是防止有人「顺手」改成 with_extension("bigimgpin.json"):
        // 那样 a.tif 和 a.png 会共用一份标注
        assert_eq!(
            sidecar_path(Path::new("/imgs/layout.tif")),
            PathBuf::from("/imgs/layout.tif.bigimgpin.json")
        );
        assert_eq!(
            sidecar_path(Path::new("/imgs/layout.png")),
            PathBuf::from("/imgs/layout.png.bigimgpin.json")
        );
        assert_ne!(
            sidecar_path(Path::new("/imgs/a.tif")),
            sidecar_path(Path::new("/imgs/a.png"))
        );
    }

    #[test]
    fn mismatches_on_size_change_only() {
        let source = AnnotationSource {
            path: "/imgs/a.tif".into(),
            width: 100,
            height: 200,
            size: 4096,
            mtime: 111,
        };

        assert!(mismatch_reason(&source, 4096).is_none());
        assert!(mismatch_reason(&source, 8192).is_some());
    }

    #[test]
    fn write_atomic_overwrites_and_leaves_no_tmp() {
        // 覆盖已存在的文件在 Windows 上不是白送的(文件被占用时 rename 会失败),
        // 而自动保存每次改动都要覆盖同一个路径 —— 这条得守住
        let dir = std::env::temp_dir().join(format!("bigimgpin-anno-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.tif.bigimgpin.json");

        write_atomic(&file, "first").unwrap();
        write_atomic(&file, "second").unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "second");

        // 临时文件不能留在源图目录里
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn doc_round_trips_through_json() {
        let doc = AnnotationDoc {
            version: FORMAT_VERSION,
            source: AnnotationSource {
                path: "/imgs/a.tif".into(),
                width: 100,
                height: 200,
                size: 4096,
                mtime: 111,
            },
            regions: vec![AnnotationRegion {
                id: "r1".into(),
                x: 1.5,
                y: 2.25,
                w: 10.0,
                h: 20.0,
                color: "#ff4d4f".into(),
                name: None,
            }],
            guides: vec![AnnotationGuide {
                axis: Axis::Y,
                pos: 12.5,
                color: "#ffd666".into(),
            }],
        };

        let text = serde_json::to_string(&doc).unwrap();
        let back: AnnotationDoc = serde_json::from_str(&text).unwrap();

        assert_eq!(back.version, FORMAT_VERSION);
        assert_eq!(back.regions.len(), 1);
        assert_eq!(back.regions[0].x, 1.5);
        assert_eq!(back.guides[0].axis, Axis::Y);
        // 前端读的是 camelCase,字段名必须真的长这样
        assert!(text.contains("\"color\""));
    }

    #[test]
    fn axis_uses_lowercase_in_json() {
        // 前端 types.ts 里是 'x' | 'y',不是 'X' | 'Y'
        assert_eq!(serde_json::to_string(&Axis::X).unwrap(), "\"x\"");
        assert_eq!(serde_json::from_str::<Axis>("\"y\"").unwrap(), Axis::Y);
    }

    #[test]
    fn older_docs_without_name_still_load() {
        // 以后加了字段的版本要能读现在写出来的文件,反过来也一样
        // r##..## 而不是 r#.."#:JSON 里的 "#fff" 会让 "#
        // 提前把原始字符串结束掉
        let json = r##"{
            "version": 1,
            "source": {"path":"/a.tif","width":1,"height":1,"size":1,"mtime":0},
            "regions": [{"id":"r1","x":0,"y":0,"w":1,"h":1,"color":"#fff"}],
            "guides": []
        }"##;

        let doc: AnnotationDoc = serde_json::from_str(json).unwrap();
        assert_eq!(doc.regions[0].name, None);
    }
}

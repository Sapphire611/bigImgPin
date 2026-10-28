//! 读取拖入的缺陷结果 JSON,把每条 `defect_roi` 换算成图像像素。
//!
//! 和 PCS 布局一样,缺陷坐标是 gerber 尺度的,乘 `panel_scale` 才落到图上。
//! 这个缩放系数**从当前已加载的 PCS 布局里传进来**,不从缺陷文件里猜:
//! 缺陷文件里的 `defect_scale` / `image_scale` 都是 1,和图像像素不是一回事。
//!
//! 两类缺陷分开来源,但输出成同一个列表:
//!
//! - `panel_info.defect_info`:面板级/全局点,不属于任何 PCS。`pcs_key` 记 0,
//!   前端据此显示「全局点」。
//! - `pcs_info[key].defect_info`:板内缺陷,`pcs_key` 就是 `pcs_info` 的 key,
//!   也是前端要附带的那条 PCS 信息。
//!
//! 只取顶层 `defect_roi`,不展开 `sub_defects_info`:后者一个缺陷动辄几百条,
//! 画在图上只会糊成一片,而列表里每条缺陷的 ROI 已经能定位到位置了。
//!
//! 顺便把每条的缺陷图路径(`defect_vrs_images` 等)带出来。图片本体不在这里读 ——
//! 文件里存的是相对面板目录的 key,要拼上 MinIO 地址才能取。面板 JSON 在 MinIO
//! 上的 key 前缀并不总等于 `local_describe_path`(导入工具会改前缀),所以这里
//! 同时给出几组候选前缀,由 `defect_images` 逐个试。

use serde::{Deserialize, Serialize};
use std::path::Path;

/// 面板级缺陷在输出里的 `pcs_key`。真实的 `pcs_info` key 从 1 开始,
/// 用 0 不会撞上,前端也只需要判断这一个值。
const GLOBAL_PCS_KEY: u32 = 0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Defect {
    /// 来源文件里的 Guid。缺失时用 `d<序号>` 兜底,保证列表 key 稳定。
    pub id: String,
    pub defect_index: i64,
    pub code: String,
    pub label: String,
    pub location: String,
    /// `pcs_info` 的 key;0 表示面板级全局点
    pub pcs_key: u32,
    /// 已乘过 `panel_scale` 的图像像素坐标
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 第一张缺陷图,相对面板目录的 key(绝对 URL 已去掉主机和 bucket)。
    /// 没有图片的缺陷是 None —— 列表里照常显示,只是点开没有图。
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefectSet {
    pub product_serial: String,
    pub side_index: String,
    pub panel_id: i64,
    pub defects: Vec<Defect>,
    /// 图片所在的 bucket。目前见到的都是 deepiresults,但 `minio://` 路径里写了什么就用什么。
    pub bucket: String,
    /// 拼图片 key 时依次尝试的目录前缀(相对 bucket)。真实前缀常常被导入工具改过,
    /// 见本文件顶部注释。
    pub key_prefixes: Vec<String>,
}

#[derive(Deserialize, Default)]
struct RawResult {
    #[serde(default)]
    product_serial: String,
    #[serde(default)]
    serial_number: String,
    #[serde(default)]
    side_index: String,
    #[serde(default)]
    panel_id: i64,
    #[serde(default)]
    local_describe_path: String,
    #[serde(default)]
    local_describe_dir: String,
    #[serde(default)]
    panel_info: Option<RawPanelInfo>,
    #[serde(default)]
    pcs_info: Option<std::collections::BTreeMap<String, RawPcsInfo>>,
}

#[derive(Deserialize, Default)]
struct RawPanelInfo {
    #[serde(default)]
    defect_info: Vec<RawDefect>,
}

#[derive(Deserialize, Default)]
struct RawPcsInfo {
    #[serde(default)]
    defect_info: Vec<RawDefect>,
}

#[derive(Deserialize)]
struct RawDefect {
    /// 字段名是 `Guid`(大写 G),不能用 rename_all 推导出来
    #[serde(rename = "Guid", default)]
    guid: String,
    #[serde(default)]
    defect_index: i64,
    #[serde(default)]
    defect_code: String,
    #[serde(default)]
    defect_label: String,
    #[serde(default)]
    defect_location: String,
    #[serde(default)]
    defect_roi: Option<RawRoi>,
    /// 缺陷图路径,三种历史写法都见过。VRS 原图排第一,和复判界面上显示的那张一致;
    /// `defect_images` 是快照里被前端加工时追加的字段,重复存了同一份。
    #[serde(default)]
    defect_vrs_images: Vec<String>,
    #[serde(default)]
    defect_origin_images: Vec<String>,
    #[serde(default)]
    defect_images: Vec<String>,
    #[serde(default)]
    defect_review_image: Option<String>,
}

#[derive(Deserialize)]
struct RawRoi {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

// ---------------------------------------------------------------- 图片 key

/// 统一成 `/` 分隔、无首尾斜杠的形式。Windows 拖进来的路径是反斜杠。
fn normalize_slashes(path: &str) -> String {
    path.replace('\\', "/")
        .trim()
        .trim_matches('/')
        .to_string()
}

/// `minio://<bucket>/<key>` 里的 bucket。不是这个写法就返回 None。
fn bucket_from_minio_path(path: &str) -> Option<String> {
    let rest = path.trim().strip_prefix("minio://")?;
    let bucket = rest.split('/').next().unwrap_or("");
    (!bucket.is_empty()).then(|| bucket.to_string())
}

/// 取路径里 `bucket` 段之后的内容。`from_file` 为 true 时去掉最后一段文件名。
fn after_bucket(path: &str, bucket: &str, from_file: bool) -> Option<String> {
    let normalized = normalize_slashes(path);
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    let position = segments.iter().rposition(|segment| *segment == bucket)?;
    let end = if from_file {
        segments.len().checked_sub(1)?
    } else {
        segments.len()
    };
    if position + 1 >= end {
        return None;
    }
    Some(segments[position + 1..end].join("/"))
}

/// 绝对 URL 只保留路径,并去掉 bucket 段:主机和端口由设置里的 MinIO 地址决定,
/// JSON 里写的旧 IP 不可信(导入到别的机器后就失效了)。
fn normalize_image_path(image: &str, bucket: &str) -> String {
    let mut path = image.trim().replace('\\', "/");
    if let Some((_scheme, rest)) = path.split_once("://") {
        path = match rest.find('/') {
            Some(index) => rest[index + 1..].to_string(),
            None => String::new(),
        };
    }
    // 绝对地址可能带 ?query;MinIO 的对象 key 里不会有问号
    if let Some(index) = path.find(['?', '#']) {
        path.truncate(index);
    }

    let path = path.trim_start_matches('/');
    path.strip_prefix(&format!("{bucket}/"))
        .unwrap_or(path)
        .to_string()
}

/// 一张缺陷图:优先 VRS 原图,其次机台原图,最后复判图。
fn first_image(defect: &RawDefect) -> Option<String> {
    defect
        .defect_vrs_images
        .iter()
        .chain(defect.defect_origin_images.iter())
        .chain(defect.defect_images.iter())
        .find(|path| !path.trim().is_empty())
        .cloned()
        .or_else(|| {
            defect
                .defect_review_image
                .clone()
                .filter(|path| !path.trim().is_empty())
        })
}

/// 候选目录前缀。顺序就是尝试顺序,靠前的更可能命中:
///
/// 1. 拖入文件自己的路径 —— 从数据包/images 目录拖进来时,包里的相对路径就是 key。
/// 2. `local_describe_*` 里 `deepiresults/` 之后的部分,以及逐级去掉日期/批次段后的变体。
/// 3. 旧 MinIO 上见过的 `<serial>/<side>/<时间戳>`、`<serial>/<最后两段>` 等写法。
///
/// 都不中时 `defect_images` 那边还会再试一次「图片路径原样作为 key」。
fn image_key_prefixes(
    source: &Path,
    local_dir: &str,
    local_path: &str,
    serial: &str,
    side: &str,
) -> Vec<String> {
    let bucket = "deepiresults";
    let mut prefixes: Vec<String> = Vec::new();
    let mut push = |prefix: String| {
        let prefix = normalize_slashes(&prefix);
        if !prefix.is_empty() && !prefixes.contains(&prefix) {
            prefixes.push(prefix);
        }
    };

    // 1. 拖入文件自己所在目录
    if let Some(dir) = after_bucket(&source.to_string_lossy(), bucket, true) {
        push(dir);
    }

    // 2. local_describe_dir / local_describe_path
    let (local, is_dir) = if !local_dir.trim().is_empty() {
        (local_dir, true)
    } else {
        (local_path, false)
    };
    if let Some(rest) = local.trim().strip_prefix("minio://") {
        // minio://<bucket>/<key...>;路径本身就是权威的 key
        let mut segments = rest.split('/');
        segments.next(); // bucket
        let dir = segments.collect::<Vec<_>>().join("/");
        let dir = if is_dir {
            dir
        } else {
            dir.rsplit_once('/').map(|(head, _)| head).unwrap_or("").to_string()
        };
        push(dir);
    } else if let Some(dir) = after_bucket(local, bucket, !is_dir) {
        push(dir.clone());
        let segments: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
        // 旧数据导入时常常把日期/批次/产线前缀改掉,逐级去掉再试
        if segments.len() > 1 {
            push(segments[1..].join("/"));
        }
        if segments.len() > 2 {
            push(segments[2..].join("/"));
        }

        let serial = serial.trim();
        let side = side.trim();
        if !serial.is_empty() {
            let last = segments.last().copied().unwrap_or("");
            if !side.is_empty() && !last.is_empty() {
                // 旧 MinIO 上最常见的 <SN>/<面>/<时间戳>
                push(format!("{serial}/{side}/{last}"));
            }
            if segments.len() >= 2 {
                push(format!("{serial}/{}", segments[segments.len() - 2..].join("/")));
            }
            if !last.is_empty() {
                push(format!("{serial}/{last}"));
            }
        }
    }

    // 3. 只靠 SN / 面也能拼出来的前缀
    let serial = serial.trim();
    let side = side.trim();
    if !serial.is_empty() && !side.is_empty() {
        push(format!("{serial}/{side}"));
        let other = if side.eq_ignore_ascii_case("A") { "B" } else { "A" };
        push(format!("{serial}/{other}"));
    }

    prefixes
}

/// 解析并缩放。拆成纯函数是为了能单测,也不依赖当前打开的图片。
fn parse_defects(text: &str, panel_scale: f64, source: &Path) -> Result<DefectSet, String> {
    if !panel_scale.is_finite() || panel_scale <= 0.0 {
        return Err(format!("panel_scale 不合法:{panel_scale}"));
    }

    let raw: RawResult =
        serde_json::from_str(text).map_err(|error| format!("缺陷 JSON 解析失败:{error}"))?;

    // 两个字段都不在,多半是拖错了文件(比如 PCS 布局 JSON 或标注文件)。
    // 直接报错,比返回 0 个缺陷让人以为「这次没有缺陷」要好。
    if raw.panel_info.is_none() && raw.pcs_info.is_none() {
        return Err("这个 JSON 里没有 panel_info / pcs_info,不是缺陷结果文件".into());
    }

    let bucket = bucket_from_minio_path(&raw.local_describe_path)
        .unwrap_or_else(|| "deepiresults".to_string());
    let key_prefixes = image_key_prefixes(
        source,
        &raw.local_describe_dir,
        &raw.local_describe_path,
        &raw.serial_number,
        &raw.side_index,
    );

    let k = panel_scale;
    let mut defects = Vec::new();
    let mut ordinal = 0usize;

    let mut convert = |raw_defect: RawDefect, pcs_key: u32| {
        ordinal += 1;
        // 先取图片路径:下面构造 Defect 时会把 raw_defect 的字段移走
        let image = first_image(&raw_defect).map(|path| normalize_image_path(&path, &bucket));

        let Some(roi) = raw_defect.defect_roi else {
            return;
        };
        // 宽高为 0 / 负数时画出来是个点或反向框,没法点击也没法看
        if !(roi.width > 0.0 && roi.height > 0.0) {
            return;
        }

        defects.push(Defect {
            id: if raw_defect.guid.is_empty() {
                format!("d{ordinal}")
            } else {
                raw_defect.guid
            },
            defect_index: raw_defect.defect_index,
            code: raw_defect.defect_code,
            label: raw_defect.defect_label,
            location: raw_defect.defect_location,
            pcs_key,
            x: roi.x * k,
            y: roi.y * k,
            w: roi.width * k,
            h: roi.height * k,
            image,
        });
    };

    if let Some(panel) = raw.panel_info {
        for defect in panel.defect_info {
            convert(defect, GLOBAL_PCS_KEY);
        }
    }

    if let Some(pcs_info) = raw.pcs_info {
        // BTreeMap 按字符串排序,会出现 1,10,11,...,2 的顺序 —— 按数字重排,
        // 列表里 PCS 1、2、3… 才是人期望的顺序
        let mut entries: Vec<_> = pcs_info.into_iter().collect();
        entries.sort_by_key(|(key, _)| key.parse::<u32>().unwrap_or(u32::MAX));

        for (key, pcs) in entries {
            // 非数字 key 不是这个文件该有的东西;跳过而不是硬塞成 0,
            // 否则会被前端误显示成「全局点」
            let Ok(pcs_key) = key.parse::<u32>() else {
                continue;
            };
            for defect in pcs.defect_info {
                convert(defect, pcs_key);
            }
        }
    }

    Ok(DefectSet {
        product_serial: raw.product_serial,
        side_index: raw.side_index,
        panel_id: raw.panel_id,
        defects,
        bucket,
        key_prefixes,
    })
}

/// 前端在文件拖入后调用。`panel_scale` 来自当前 PCS 布局,保证两套框同一尺度。
#[tauri::command]
pub async fn load_defects(path: String, panel_scale: f64) -> Result<DefectSet, String> {
    // 结果文件可能几 MB,解析走阻塞线程,别占异步运行时的工作线程
    tauri::async_runtime::spawn_blocking(move || {
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("读取 {path} 失败:{error}"))?;
        parse_defects(&text, panel_scale, Path::new(&path))
    })
    .await
    .map_err(|error| format!("读取缺陷文件的任务失败:{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "C:/data/deepiresults/20261027/lot1/A/panel-dir/panel.json";

    const SAMPLE: &str = r#"{
        "product_serial": "P1",
        "serial_number": "SN1",
        "side_index": "A",
        "panel_id": 1,
        "local_describe_path": "minio://deepiresults/20261027/lot1/A/panel-dir/panel.json",
        "local_describe_dir": "minio://deepiresults/20261027/lot1/A/panel-dir",
        "panel_info": {
            "defect_info": [
                {
                    "Guid": "global-1",
                    "defect_index": 0,
                    "defect_code": "Dark",
                    "defect_label": "NG",
                    "defect_location": "BasePanel",
                    "defect_roi": { "x": 100, "y": 200, "width": 50, "height": 60 },
                    "defect_vrs_images": ["img/global-vrs.jpg"],
                    "defect_origin_images": ["img/global-origin.jpg"]
                }
            ]
        },
        "pcs_info": {
            "7": {
                "defect_info": [
                    {
                        "Guid": "pcs-7-1",
                        "defect_index": 3,
                        "defect_code": "Light",
                        "defect_label": "NG",
                        "defect_location": "CircuitSM",
                        "defect_roi": { "x": 1000, "y": 2000, "width": 512, "height": 512 },
                        "defect_vrs_images": [
                            "http://10.0.0.9:9000/deepiresults/20261027/lot1/A/panel-dir/img/pcs.jpg"
                        ]
                    }
                ]
            }
        }
    }"#;

    fn parse(text: &str, scale: f64) -> Result<DefectSet, String> {
        parse_defects(text, scale, Path::new(SOURCE))
    }

    #[test]
    fn global_defects_get_key_zero_and_pcs_defects_keep_their_key() {
        let set = parse(SAMPLE, 0.1).unwrap();
        assert_eq!(set.defects.len(), 2);

        let global = &set.defects[0];
        assert_eq!(global.id, "global-1");
        assert_eq!(global.pcs_key, 0);
        assert!((global.x - 10.0).abs() < 1e-9);
        assert!((global.y - 20.0).abs() < 1e-9);
        assert!((global.w - 5.0).abs() < 1e-9);
        assert!((global.h - 6.0).abs() < 1e-9);
        // 有 VRS 图时优先 VRS,不取 origin
        assert_eq!(global.image.as_deref(), Some("img/global-vrs.jpg"));

        let pcs = &set.defects[1];
        assert_eq!(pcs.id, "pcs-7-1");
        assert_eq!(pcs.pcs_key, 7);
        assert_eq!(pcs.defect_index, 3);
        assert!((pcs.x - 100.0).abs() < 1e-9);
        assert!((pcs.y - 200.0).abs() < 1e-9);
        assert!((pcs.w - 51.2).abs() < 1e-9);
        assert_eq!(set.product_serial, "P1");
        assert_eq!(set.side_index, "A");
    }

    #[test]
    fn absolute_image_url_keeps_only_the_bucket_key() {
        let set = parse(SAMPLE, 0.1).unwrap();
        // 主机/旧端口被丢掉,由设置里的 MinIO 地址决定
        assert_eq!(
            set.defects[1].image.as_deref(),
            Some("20261027/lot1/A/panel-dir/img/pcs.jpg")
        );
        assert_eq!(set.bucket, "deepiresults");
    }

    #[test]
    fn key_prefixes_include_the_dragged_directory() {
        let set = parse(SAMPLE, 0.1).unwrap();
        assert_eq!(set.key_prefixes[0], "20261027/lot1/A/panel-dir");
        // 只靠 SN/面也能拼出来的候选
        assert!(set.key_prefixes.iter().any(|p| p == "SN1/A"));
        assert!(set.key_prefixes.iter().any(|p| p == "SN1/B"));
    }

    #[test]
    fn old_drive_path_gets_suffix_candidates() {
        // 旧 MinIO 的真实 key 常与 local_describe_path 对不上,
        // 这个例子里实际前缀是「SN + 最后两段」
        let text = r#"{
            "serial_number": "00027440060006",
            "side_index": "A",
            "local_describe_dir": "D:\\minio\\deepiresults\\20261019\\x00-1214\\A00027440060006\\00027440060006",
            "panel_info": { "defect_info": [] }
        }"#;
        let set = parse_defects(text, 1.0, Path::new("C:/tmp/panel.json")).unwrap();
        assert!(
            set.key_prefixes
                .iter()
                .any(|p| p == "00027440060006/A00027440060006/00027440060006"),
            "候选前缀里没有实际 key: {:?}",
            set.key_prefixes
        );
    }

    #[test]
    fn pcs_keys_are_sorted_numerically() {
        let text = r#"{
            "pcs_info": {
                "10": { "defect_info": [] },
                "2": {
                    "defect_info": [
                        { "defect_index": 1, "defect_roi": { "x": 0, "y": 0, "width": 1, "height": 1 } }
                    ]
                }
            }
        }"#;
        let set = parse(text, 1.0).unwrap();
        assert_eq!(set.defects.len(), 1);
        assert_eq!(set.defects[0].pcs_key, 2);
        assert_eq!(set.defects[0].image, None);
    }

    #[test]
    fn rejects_files_without_defect_sections() {
        let error = parse(r#"{ "product_serial": "P1" }"#, 0.1).unwrap_err();
        assert!(error.contains("panel_info"));
    }

    #[test]
    fn skips_defects_without_usable_roi() {
        let text = r#"{
            "pcs_info": {
                "1": {
                    "defect_info": [
                        { "defect_index": 0 },
                        { "defect_index": 1, "defect_roi": { "x": 0, "y": 0, "width": 0, "height": 10 } }
                    ]
                }
            }
        }"#;
        assert!(parse(text, 1.0).unwrap().defects.is_empty());
    }
}

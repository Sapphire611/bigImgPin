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

use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefectSet {
    pub product_serial: String,
    pub side_index: String,
    pub panel_id: i64,
    pub defects: Vec<Defect>,
}

#[derive(Deserialize, Default)]
struct RawResult {
    #[serde(default)]
    product_serial: String,
    #[serde(default)]
    side_index: String,
    #[serde(default)]
    panel_id: i64,
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
}

#[derive(Deserialize)]
struct RawRoi {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// 解析并缩放。拆成纯函数是为了能单测,也不依赖当前打开的图片。
fn parse_defects(text: &str, panel_scale: f64) -> Result<DefectSet, String> {
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

    let k = panel_scale;
    let mut defects = Vec::new();
    let mut ordinal = 0usize;

    let mut convert = |raw_defect: RawDefect, pcs_key: u32| {
        ordinal += 1;
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
    })
}

/// 前端在文件拖入后调用。`panel_scale` 来自当前 PCS 布局,保证两套框同一尺度。
#[tauri::command]
pub async fn load_defects(path: String, panel_scale: f64) -> Result<DefectSet, String> {
    // 结果文件可能几 MB,解析走阻塞线程,别占异步运行时的工作线程
    tauri::async_runtime::spawn_blocking(move || {
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("读取 {path} 失败:{error}"))?;
        parse_defects(&text, panel_scale)
    })
    .await
    .map_err(|error| format!("读取缺陷文件的任务失败:{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "product_serial": "P1",
        "side_index": "A",
        "panel_id": 1,
        "panel_info": {
            "defect_info": [
                {
                    "Guid": "global-1",
                    "defect_index": 0,
                    "defect_code": "Dark",
                    "defect_label": "NG",
                    "defect_location": "BasePanel",
                    "defect_roi": { "x": 100, "y": 200, "width": 50, "height": 60 }
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
                        "defect_roi": { "x": 1000, "y": 2000, "width": 512, "height": 512 }
                    }
                ]
            }
        }
    }"#;

    #[test]
    fn global_defects_get_key_zero_and_pcs_defects_keep_their_key() {
        let set = parse_defects(SAMPLE, 0.1).unwrap();
        assert_eq!(set.defects.len(), 2);

        let global = &set.defects[0];
        assert_eq!(global.id, "global-1");
        assert_eq!(global.pcs_key, 0);
        assert!((global.x - 10.0).abs() < 1e-9);
        assert!((global.y - 20.0).abs() < 1e-9);
        assert!((global.w - 5.0).abs() < 1e-9);
        assert!((global.h - 6.0).abs() < 1e-9);

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
        let set = parse_defects(text, 1.0).unwrap();
        assert_eq!(set.defects.len(), 1);
        assert_eq!(set.defects[0].pcs_key, 2);
    }

    #[test]
    fn rejects_files_without_defect_sections() {
        let error = parse_defects(r#"{ "product_serial": "P1" }"#, 0.1).unwrap_err();
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
        assert!(parse_defects(text, 1.0).unwrap().defects.is_empty());
    }
}

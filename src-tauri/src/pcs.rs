//! 从源图同级的 `<图名>.json` 读取 PCS 分布。
//!
//! 这类 JSON 是上游按产品型号产出的(与本应用自己的 `.bigimgpin.json` 标注文件
//! 不是一回事)。`panel_scale` 把 gerber 坐标压到图像像素上 —— 样例里正好是 0.1,
//! 但**必须读文件里的值**,不能写死:同一台机器上不同产品的缩放比不一定相同,
//! 写死只会在换产品时表现为「框整体缩小/放大到别处」。
//!
//! 只取 `position` 包围盒,不取 `contours`:界面上要的是每个料的 PCS 分布和编号,
//! 逐个画轮廓会把版图细节盖住,而且 48 条轮廓的顶点数量也远超实际需要。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 一个 PCS 的绘制信息,坐标已经乘过 `panel_scale`,单位是图像像素。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcsBox {
    /// `single_pcs_list[].id`,画在框中间的数字就是它。
    pub id: u32,
    /// 所属的料/拼板编号,前端按它配色。
    pub tid: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcsLayout {
    /// 实际使用的缩放系数,前端显示或排查时用得上。
    pub panel_scale: f64,
    pub pcs: Vec<PcsBox>,
}

#[derive(Deserialize)]
struct RawLayout {
    panel_scale: f64,
    #[serde(default)]
    single_pcs_list: Vec<RawPcs>,
}

#[derive(Deserialize)]
struct RawPcs {
    id: u32,
    #[serde(default)]
    tid: u32,
    position: RawPosition,
}

#[derive(Deserialize)]
struct RawPosition {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// 源图 `a.tif` → 同级 `a.json`。
///
/// 用 `with_extension` 而不是改字符串后缀:`a.tif` 和 `a.png` 是两个文件,
/// 但后缀替换要保证只动最后一个点后面的部分,自己拼字符串容易把 `a.b.png`
/// 变成 `a.json`。
fn sidecar_path(image: &Path) -> PathBuf {
    image.with_extension("json")
}

/// 解析 JSON 文本并把坐标缩放到图像像素。拆出来是为了能单测,不碰文件系统。
fn parse_layout(text: &str) -> Result<PcsLayout, String> {
    let raw: RawLayout =
        serde_json::from_str(text).map_err(|error| format!("PCS JSON 解析失败:{error}"))?;

    // 缩放系数是 0 / 负数 / NaN 时,画出来的框要么消失要么翻到另一侧,
    // 与其让用户盯着空白画布,不如直接说文件有问题。
    if !raw.panel_scale.is_finite() || raw.panel_scale <= 0.0 {
        return Err(format!("panel_scale 不合法:{}", raw.panel_scale));
    }

    let k = raw.panel_scale;
    let pcs = raw
        .single_pcs_list
        .into_iter()
        .map(|pcs| PcsBox {
            id: pcs.id,
            tid: pcs.tid,
            x: pcs.position.x * k,
            y: pcs.position.y * k,
            w: pcs.position.width * k,
            h: pcs.position.height * k,
        })
        .collect();

    Ok(PcsLayout {
        panel_scale: k,
        pcs,
    })
}

/// 没有同名 JSON 是正常情况(多数图没有),返回 `Ok(None)` 而不是报错。
fn load_sync(image: &str) -> Result<Option<PcsLayout>, String> {
    let sidecar = sidecar_path(Path::new(image));
    if !sidecar.is_file() {
        return Ok(None);
    }

    let text = std::fs::read_to_string(&sidecar)
        .map_err(|error| format!("读取 {} 失败:{error}", sidecar.display()))?;
    parse_layout(&text).map(Some)
}

/// 读源图同级的 PCS 布局。前端在打开图片后调用,没有数据时返回 null。
#[tauri::command]
pub async fn load_pcs_layout(path: String) -> Result<Option<PcsLayout>, String> {
    // 小文件也要走 spawn_blocking:同步命令跑在主线程,读盘再快也不该占着它
    tauri::async_runtime::spawn_blocking(move || load_sync(&path))
        .await
        .map_err(|error| format!("读取 PCS 布局的任务失败:{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "panel_scale": 0.1,
        "single_pcs_list": [
            {
                "id": 1,
                "tid": 2,
                "position": { "x": 2661, "y": 56130, "width": 23562, "height": 18281 }
            }
        ]
    }"#;

    #[test]
    fn sidecar_replaces_only_the_last_extension() {
        assert_eq!(sidecar_path(Path::new("a.b.png")), Path::new("a.b.json"));
    }

    #[test]
    fn scales_positions_by_panel_scale() {
        let layout = parse_layout(SAMPLE).unwrap();
        let pcs = &layout.pcs[0];
        assert!((layout.panel_scale - 0.1).abs() < 1e-12);
        assert!((pcs.x - 266.1).abs() < 1e-9);
        assert!((pcs.y - 5613.0).abs() < 1e-9);
        assert!((pcs.w - 2356.2).abs() < 1e-9);
        assert!((pcs.h - 1828.1).abs() < 1e-9);
        assert_eq!(pcs.id, 1);
        assert_eq!(pcs.tid, 2);
    }

    #[test]
    fn rejects_bad_panel_scale() {
        let text = SAMPLE.replace("\"panel_scale\": 0.1", "\"panel_scale\": 0");
        assert!(parse_layout(&text).is_err());
    }

    #[test]
    fn missing_sidecar_is_not_an_error() {
        // 不存在的路径必须当「没有 PCS 数据」处理,而不是让打开图片失败
        assert!(load_sync("C:/definitely/not/here/image.png").unwrap().is_none());
    }
}

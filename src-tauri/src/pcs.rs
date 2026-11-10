//! 从源图同级的 `<图名>.json` 读取 PCS 分布。
//!
//! 这类 JSON 是上游按产品型号产出的(与本应用自己的 `.bigimgpin.json` 标注文件
//! 不是一回事)。`panel_scale` 把 gerber 坐标压到图像像素上 —— 样例里正好是 0.1,
//! 但**必须读文件里的值**,不能写死:同一台机器上不同产品的缩放比不一定相同,
//! 写死只会在换产品时表现为「框整体缩小/放大到别处」。
//!
//! 只取 `position` 包围盒,不取 `contours`:界面上要的是每个料的 PCS 分布和编号,
//! 逐个画轮廓会把版图细节盖住,而且 48 条轮廓的顶点数量也远超实际需要。

use serde::{Deserialize, Deserializer, Serialize};
use std::path::{Path, PathBuf};

/// 一个 PCS 的绘制信息,坐标已经乘过 `panel_scale`,单位是图像像素。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcsBox {
    /// `single_pcs_list[].id`,列表序号,不在画布上显示。
    pub id: u32,
    /// 料号/拼板编号,前端按它配色并显示在框中央。上游有的产品写
    /// `"p_13"`/`"A30"`,有的写数字 `0`,统一成字符串交给前端。
    pub tid: String,
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
    /// 参考坐标画布尺寸(`gerber_size × panel_scale`),单位图像像素。
    /// 手动旋转参考层时要绕**这个画布**的中心转,不是图片中心 —— 有的产品
    /// 图片本身就是 gerber 转了 90°(宽高互换),两个中心根本不是同一个点。
    /// 文件里没有 `gerber_size` 时为 0,前端退回用图片尺寸。
    pub width: f64,
    pub height: f64,
    pub pcs: Vec<PcsBox>,
}

#[derive(Deserialize)]
struct RawLayout {
    panel_scale: f64,
    #[serde(default)]
    gerber_size: Option<RawSize>,
    #[serde(default)]
    single_pcs_list: Vec<RawPcs>,
}

#[derive(Deserialize)]
struct RawSize {
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
struct RawPcs {
    id: u32,
    #[serde(default, deserialize_with = "tid_as_string")]
    tid: String,
    position: RawPosition,
}

/// `tid` 是标识不是数值:实测 productSerial 下 11337 条是字符串、1296 条是数字。
/// 按一种类型解析会让整份 PCS 因这一个字段读不出来。用 untagged 枚举而不是先收成
/// `Value`:Value 会顺带接受对象/数组这类不该出现的形态,这里只放行字符串和数字。
fn tid_as_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Tid {
        Text(String),
        Number(u64),
    }

    Ok(match Tid::deserialize(deserializer)? {
        Tid::Text(text) => text,
        Tid::Number(number) => number.to_string(),
    })
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
    let (width, height) = raw
        .gerber_size
        .map(|size| (size.width * k, size.height * k))
        .unwrap_or((0.0, 0.0));
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
        width,
        height,
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
        "gerber_size": { "width": 1000, "height": 2000 },
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
        assert_eq!(pcs.tid, "2");
        // 参考画布也要按同一个 panel_scale 缩放,前端旋转时要拿它当中心
        assert!((layout.width - 100.0).abs() < 1e-9);
        assert!((layout.height - 200.0).abs() < 1e-9);
    }

    #[test]
    fn missing_gerber_size_leaves_canvas_empty() {
        // 老文件没有 gerber_size:不要瞎猜,交给前端退回图片尺寸
        let text = SAMPLE.replace("\"gerber_size\": { \"width\": 1000, \"height\": 2000 },", "");
        let layout = parse_layout(&text).unwrap();
        assert_eq!(layout.width, 0.0);
        assert_eq!(layout.height, 0.0);
        assert_eq!(layout.pcs.len(), 1);
    }

    #[test]
    fn accepts_string_and_numeric_tid() {
        // 同一个产品目录下的两种写法都得能读(见 tid_as_string 的注释)
        let text = SAMPLE.replace("\"tid\": 2", "\"tid\": \"p_13\"");
        assert_eq!(parse_layout(&text).unwrap().pcs[0].tid, "p_13");

        // 缺 tid 的历史文件也不能让整份布局失败
        let text = SAMPLE.replace("\"tid\": 2,", "");
        assert_eq!(parse_layout(&text).unwrap().pcs[0].tid, "");
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

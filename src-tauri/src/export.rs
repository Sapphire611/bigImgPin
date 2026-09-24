//! 导出:框坐标表格、框内图像裁剪。
//!
//! 只有 Rust 侧能写文件(前端没有挂 fs 插件),所以命令放在这里;
//! 但**坐标语义不在这里** —— 要不要套用「偏移 / 系数」的逆变换由前端决定,
//! 它才是持有那套参数的地方。这一层只管格式化、夹取和写盘。
//!
//! 裁剪为什么用 vips 而不是从已经切好的瓦片里拼:瓦片是 1024 一块死的,
//! 拼任意矩形要自己解码、对齐、缝合;而 `extract_area` 一条命令读源图就够,
//! 对金字塔 TIFF 还是随机访问。代价见 `vips::crop_image` 的注释。

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

use crate::vips;

/// 要导出的一个矩形。
///
/// 只认 x/y/w/h —— 前端把 Region 的 id、颜色剥掉再送过来,
/// 表格和裁剪都用不上它们。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 框的名字。裁剪用不上,只有表格会带上它。
    #[serde(default)]
    pub name: Option<String>,
}

/// 裁剪导出的结果。部分成功是常态(总有框压在图像边界上),所以要能如实汇报。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropOutcome {
    pub dir: String,
    /// 实际写出的文件数
    pub written: usize,
    /// 每个跳过或失败的框一条,直接给用户看
    pub problems: Vec<String>,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CropProgress {
    done: usize,
    total: usize,
}

// ---------------------------------------------------------------- 命令

/// 导出框坐标 CSV。返回实际写入的路径,用户取消对话框则返回 null。
///
/// `decimals` 只决定**打印几位**:数值已经由前端按同一精度收敛过。
/// 两边各舍入一次会用到两套舍入规则(JS 的 toFixed 和 Rust 的格式化在
/// 恰好 .5 上不一致),值就可能对不上。
#[tauri::command]
pub async fn export_regions_csv(
    app: AppHandle,
    source: String,
    rects: Vec<ExportRect>,
    decimals: u32,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(target) = pick_save_path(&app, &source)? else {
            return Ok(None);
        };

        // 不走 .tmp → rename 那套原子写:这是用户自己挑路径的一次性交付物,
        // 不存在「半截文件被误判成有效缓存」的问题,而悄悄改文件名反而更糟。
        std::fs::write(&target, build_csv(&rects, decimals))
            .map_err(|e| format!("写入 {target} 失败: {e}"))?;

        Ok(Some(target))
    })
    .await
    .map_err(|e| format!("导出任务失败: {e}"))?
}

/// 把每个框里的图像裁出来,放进用户选的一个目录。
///
/// 返回 None 表示用户取消了选目录。单个框失败不中断整体 —— 部分成功比全盘失败有用。
#[tauri::command]
pub async fn export_crops(
    app: AppHandle,
    source: String,
    rects: Vec<ExportRect>,
) -> Result<Option<CropOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dir) = pick_folder(&app, &source)? else {
            return Ok(None);
        };

        let vips_exe = vips::resolve_vips(&app)?;
        let src = Path::new(&source);
        let meta = vips::probe_image(&vips_exe, src)?;
        let extension = vips::crop_extension(&meta.format);

        let total = rects.len();
        let mut written = 0usize;
        let mut problems = Vec::new();

        for (index, rect) in rects.iter().enumerate() {
            let Some((left, top, w, h)) = normalize(rect, meta.width, meta.height) else {
                problems.push(format!("第 {} 个框在图像范围之外,已跳过", index + 1));
                emit_progress(&app, index + 1, total);
                continue;
            };

            // 序号补零是为了在文件管理器里按名字排序时顺序正确(否则 10 会排到 2 前面)
            let name = format!("{:03}_x{left}_y{top}_{w}x{h}.{extension}", index + 1);
            match vips::crop_image(&vips_exe, src, &dir.join(&name), left, top, w, h) {
                Ok(()) => written += 1,
                Err(error) => problems.push(format!("{name}:{error}")),
            }

            emit_progress(&app, index + 1, total);
        }

        Ok(Some(CropOutcome {
            dir: dir.display().to_string(),
            written,
            problems,
            extension: extension.to_string(),
        }))
    })
    .await
    .map_err(|e| format!("导出任务失败: {e}"))?
}

// ---------------------------------------------------------------- 实现

/// 表格文本。
fn build_csv(rects: &[ExportRect], decimals: u32) -> String {
    // 开头的 BOM 是必须的:没有它 Excel 会按本地代码页解,中文列名直接变乱码。
    // 换行用 CRLF,Excel 对这个最省心。
    let mut out = String::from("\u{feff}序号,x,y,w,h,名称\r\n");
    let prec = decimals as usize;
    for (index, rect) in rects.iter().enumerate() {
        out.push_str(&format!(
            "{},{:.prec$},{:.prec$},{:.prec$},{:.prec$},{}\r\n",
            index + 1,
            rect.x,
            rect.y,
            rect.w,
            rect.h,
            csv_field(rect.name.as_deref().unwrap_or("")),
            prec = prec
        ));
    }
    out
}

/// 一个 CSV 字段。
///
/// 坐标列全是数字,本来用不着转义;但**名称是用户随手打的** ——
/// 里面出现一个逗号就会让整行多出一列、后面全部错位,而且是打开表格才看得出来。
/// 引号要按 RFC 4180 写成两个,换行也必须包进引号里。
fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// 把浮点框收敛成整数像素区域,并夹到图像范围内。
///
/// 界面上是**故意**允许画越界的框的(见 RectPanel:「有时就是要生成越界的框来对照」),
/// 但 vips 遇到越界会直接 `bad extract area` 并且不产出文件,所以这里夹一次。
/// 完全落在图外的返回 None,由调用方记一条跳过。
fn normalize(rect: &ExportRect, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    // NaN 必须先挡掉。f64::max/min 的规则是「另一个操作数是 NaN 就返回它」,
    // 于是 NaN 会被静默换成 0 或图像边界,拼出一个看着合法、其实毫无意义的区域。
    if ![rect.x, rect.y, rect.w, rect.h].iter().all(|v| v.is_finite()) {
        return None;
    }

    // 两条边各自取整再相减,而不是先取整宽高:框覆盖到哪些像素,由两条边决定。
    let left = rect.x.round().max(0.0);
    let top = rect.y.round().max(0.0);
    let right = (rect.x + rect.w).round().min(width as f64);
    let bottom = (rect.y + rect.h).round().min(height as f64);

    // 比较留在 f64 里做:坐标可能是 1e20 这种值,先转 u32 会饱和成同一个数,
    // 相减反而变成「看起来合法」的区域。
    if right - left < 1.0 || bottom - top < 1.0 {
        return None;
    }

    Some((
        left as u32,
        top as u32,
        (right - left) as u32,
        (bottom - top) as u32,
    ))
}

fn emit_progress(app: &AppHandle, done: usize, total: usize) {
    let _ = app.emit("crop-progress", CropProgress { done, total });
}

/// 保存对话框。默认落在源图旁边、文件名跟着源图走 —— 导出物和它的来源一眼能对上。
fn pick_save_path(app: &AppHandle, source: &str) -> Result<Option<String>, String> {
    let src = Path::new(source);
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "regions".into());

    let picked = app
        .dialog()
        .file()
        .set_title("导出框坐标")
        .set_directory(src.parent().unwrap_or(Path::new(".")))
        .set_file_name(format!("{stem}_regions.csv"))
        .add_filter("CSV 表格", &["csv"])
        .blocking_save_file();

    Ok(picked
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string()))
}

/// 选目录。默认从源图所在目录开始,用户顺手能在旁边新建一个子目录。
fn pick_folder(app: &AppHandle, source: &str) -> Result<Option<std::path::PathBuf>, String> {
    let src = Path::new(source);
    let picked = app
        .dialog()
        .file()
        .set_title("选择裁剪图的存放目录")
        .set_directory(src.parent().unwrap_or(Path::new(".")))
        .blocking_pick_folder();

    Ok(picked.and_then(|f| f.into_path().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> ExportRect {
        ExportRect {
            x,
            y,
            w,
            h,
            name: None,
        }
    }

    fn named(x: f64, y: f64, w: f64, h: f64, name: &str) -> ExportRect {
        ExportRect {
            name: Some(name.to_string()),
            ..rect(x, y, w, h)
        }
    }

    #[test]
    fn csv_starts_with_bom_and_lists_every_box() {
        let text = build_csv(&[rect(1.5, 2.0, 10.0, 20.0), rect(0.0, 0.0, 1.0, 1.0)], 2);

        // 没有 BOM 的话 Excel 会把「序号」按本地代码页解成乱码
        assert!(text.starts_with('\u{feff}'));
        assert!(text.contains("序号,x,y,w,h,名称\r\n"));

        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3, "表头 + 两行数据");
        assert_eq!(lines[1], "1,1.50,2.00,10.00,20.00,");
        // 序号从 1 开始,且不跟着框的 id 走
        assert!(lines[2].starts_with("2,"));
    }

    #[test]
    fn csv_precision_follows_the_setting() {
        // 默认 0 位:整数不带小数点。前端已经收敛过,这里只负责打印位数。
        let text = build_csv(&[rect(1235.0, 5678.0, 10.0, 20.0)], 0);
        assert_eq!(text.lines().nth(1).unwrap(), "1,1235,5678,10,20,");

        let text = build_csv(&[rect(1234.5, 0.0, 10.0, 20.0)], 1);
        assert_eq!(text.lines().nth(1).unwrap(), "1,1234.5,0.0,10.0,20.0,");
    }

    #[test]
    fn csv_carries_names() {
        let text = build_csv(&[named(1.0, 2.0, 3.0, 4.0, "缺陷A")], 0);
        assert_eq!(text.lines().nth(1).unwrap(), "1,1,2,3,4,缺陷A");
    }

    #[test]
    fn csv_escapes_names_that_would_break_the_table() {
        // 名字里的一个逗号会让整行多出一列,后面全部错位 ——
        // 而错位是打开表格才看得出来的,所以必须在写的时候拦住
        assert_eq!(csv_field("普通名字"), "普通名字");
        assert_eq!(csv_field("带,逗号"), "\"带,逗号\"");
        assert_eq!(csv_field("带\"引号"), "\"带\"\"引号\"");
        assert_eq!(csv_field("带\n换行"), "\"带\n换行\"");

        let text = build_csv(&[named(1.0, 2.0, 3.0, 4.0, "a,b")], 0);
        assert_eq!(text.lines().nth(1).unwrap(), "1,1,2,3,4,\"a,b\"");
    }

    #[test]
    fn csv_of_nothing_is_just_the_header() {
        // 界面上按钮在这种情况下是禁用的,但函数自己也不能产出半个表
        assert_eq!(build_csv(&[], 0), "\u{feff}序号,x,y,w,h,名称\r\n");
    }

    #[test]
    fn normalize_rounds_edges_not_sizes() {
        // 0.4~10.4 覆盖到的像素是 0..10,宽 10
        assert_eq!(normalize(&rect(0.4, 0.4, 10.0, 10.0), 100, 100), Some((0, 0, 10, 10)));
        // 0.6 起算则从 1 开始,右边界 10.6 → 11,宽 10
        assert_eq!(normalize(&rect(0.6, 0.6, 10.0, 10.0), 100, 100), Some((1, 1, 10, 10)));
    }

    #[test]
    fn normalize_clamps_to_image() {
        // 右下角溢出:夹到图像的右下角
        assert_eq!(normalize(&rect(90.0, 90.0, 50.0, 50.0), 100, 100), Some((90, 90, 10, 10)));
        // 左上角溢出:夹到 0,0
        assert_eq!(normalize(&rect(-20.0, -20.0, 50.0, 50.0), 100, 100), Some((0, 0, 30, 30)));
    }

    #[test]
    fn normalize_skips_boxes_entirely_outside() {
        assert_eq!(normalize(&rect(-50.0, 10.0, 20.0, 20.0), 100, 100), None);
        assert_eq!(normalize(&rect(10.0, 200.0, 20.0, 20.0), 100, 100), None);
        // 退化成一像素以下
        assert_eq!(normalize(&rect(10.0, 10.0, 0.2, 20.0), 100, 100), None);
    }

    #[test]
    fn normalize_survives_absurd_coordinates() {
        // 1e20 转 u32 会饱和;如果在整数里相减就会得到一个「看起来合法」的区域
        assert_eq!(normalize(&rect(1e20, 1e20, 10.0, 10.0), 100, 100), None);
        // NaN 不能传播成某个诡异的合法区域
        assert_eq!(normalize(&rect(f64::NAN, 10.0, 10.0, 10.0), 100, 100), None);
    }
}

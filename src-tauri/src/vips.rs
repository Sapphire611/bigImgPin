//! libvips 定位、探测与切片。
//!
//! 设计要点:vips 是一个**外部二进制**,不是链接进来的库。这样 macOS 和 Windows
//! 可以各自用最合适的形态(macOS 走 brew,Windows 随包捆绑),而不必让 Rust 侧
//! 处理两套构建系统。代价是要自己解析它的输出。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Windows 上隐藏控制台窗口。vips.exe 是 console 程序,从 GUI 进程启动会闪黑框。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

/// 给 Command 加上平台相关的修饰。所有启动 vips 的地方都要走这里。
fn vips_command(exe: &Path) -> Command {
    let mut cmd = Command::new(exe);
    // 让 vips 把 "NN% complete" 打到 stdout。dzsave 是长任务,没有进度用户会以为卡死。
    cmd.env("VIPS_PROGRESS", "1");
    hide_console(&mut cmd);
    cmd
}

/// 定位 vips 可执行文件。
///
/// 顺序很重要:先找随包捆绑的(Windows 安装包里的那份),再找开发时的覆盖变量,
/// 再找 macOS 上 brew 的固定位置,最后才查 PATH。
///
/// 第 3 步不是冗余的:macOS 上从 Finder 双击启动的 .app **不继承 shell 的 PATH**,
/// 所以 brew 装的 vips 在 PATH 里根本查不到,必须硬编码路径兜底。
pub fn resolve_vips(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;

    let exe_name = if cfg!(windows) { "vips.exe" } else { "vips" };

    // 1) 随包捆绑
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("vips-win64").join("bin").join(exe_name);
        if p.is_file() {
            return Ok(p);
        }
    }

    // 2) 显式覆盖(调试用,也能救急)
    if let Ok(p) = std::env::var("BIGIMGPIN_VIPS") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
    }

    // 3) macOS:brew 的两个可能位置(Apple Silicon / Intel)
    #[cfg(target_os = "macos")]
    for candidate in ["/opt/homebrew/bin/vips", "/usr/local/bin/vips"] {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return Ok(p);
        }
    }

    // 4) PATH
    if let Some(p) = which(exe_name) {
        return Ok(p);
    }

    Err(format!(
        "找不到 vips 可执行文件。\n\
         \n\
         macOS:    brew install vips\n\
         Windows:  请确认安装目录下 vips-win64/bin/{exe_name} 存在\n\
         其他:     可设环境变量 BIGIMGPIN_VIPS 指向可执行文件"
    ))
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

/// vipsheader 与 vips 同目录分发,所以从 vips 的位置推导它,而不是单独查 PATH。
///
/// 是 `pub(crate)` 而不只是私有:谁要报这个路径都得从这里拿,自己拼会在 Windows
/// 上漏掉 `.exe`(调用处曾经就是这么错的)。
pub(crate) fn vipsheader_path(vips: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        "vipsheader.exe"
    } else {
        "vipsheader"
    };
    vips.with_file_name(name)
}

/// 图像基本信息。
#[derive(serde::Serialize, Clone, Debug)]
pub struct ImageMeta {
    pub width: u32,
    pub height: u32,
    pub bands: u32,
    /// 波段格式,vips 的命名(uchar / ushort / float / int …)。
    /// 裁剪导出靠它选输出容器 —— 见 `crop_extension`。
    pub format: String,
}

/// 只读文件头拿尺寸 —— **不解码图像**,几十毫秒返回。
///
/// 用 `vipsheader -a` 一次拿全部字段再解析,比多次 `-f` 调用稳(字段名明确,
/// 输出顺序不敏感)。
pub fn probe_image(vips: &Path, input: &Path) -> Result<ImageMeta, String> {
    let header = vipsheader_path(vips);

    let mut cmd = Command::new(&header);
    cmd.arg("-a").arg(input);
    hide_console(&mut cmd);

    let out = cmd
        .output()
        .map_err(|e| format!("无法执行 {}: {e}", header.display()))?;

    if !out.status.success() {
        return Err(format!(
            "vipsheader 读取失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let text = String::from_utf8_lossy(&out.stdout);
    // 按 `key: value` 取字段。`-a` 的第一行是 `<路径>: 200x100 ushort, 3 bands…`,
    // 路径里完全可能含 "width" 之类的字样,所以要求行**以** key 开头,不能只是包含。
    let field = |key: &str| -> Option<String> {
        text.lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix(':'))
            .map(|v| v.trim().to_string())
    };

    Ok(ImageMeta {
        width: field("width")
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| format!("无法解析 width:\n{text}"))?,
        height: field("height")
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| format!("无法解析 height:\n{text}"))?,
        bands: field("bands").and_then(|v| v.parse().ok()).unwrap_or(3),
        format: field("format").unwrap_or_else(|| "uchar".into()),
    })
}

/// 裁剪导出用哪种容器。
///
/// 实测(vips 8.18.6):uchar → 8 位 PNG,ushort → 16 位 PNG(位深保留),
/// 而 **float → 8 位 PNG,静默丢精度**。所以浮点/整数类源图改用 TIFF,
/// 那个容器存得下任意格式。
///
/// 静默压位深比报错更危险:导出的裁剪图看着好好的,数值已经被截断了。
pub fn crop_extension(format: &str) -> &'static str {
    match format {
        "uchar" | "ushort" => "png",
        _ => "tif",
    }
}

/// 裁一块矩形区域另存。
///
/// `extract_area` 对金字塔 TIFF 是真随机访问,很快。代价是它对**条带式**压缩的源图
/// (非金字塔 TIFF、大 JPEG/PNG)会退化成从头解码 —— 取靠右下角的区域可能很慢。
/// 没有为此做「从缓存瓦片拼接」,那条路要自己解码、对齐、缝合,不值得。
pub fn crop_image(
    vips: &Path,
    input: &Path,
    output: &Path,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let out = vips_command(vips)
        .arg("extract_area")
        .arg(input)
        .arg(output)
        .arg(left.to_string())
        .arg(top.to_string())
        .arg(width.to_string())
        .arg(height.to_string())
        .output()
        .map_err(|e| format!("启动 vips extract_area 失败: {e}"))?;

    if !out.status.success() {
        // 实测越界时是 `extract_area: bad extract area`,不会产出文件。
        // 调用方应当先把区域夹到图内 —— 走到这里说明夹取有问题。
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// 校验这个 vips 构建是否带 dzsave。
///
/// dzsave 依赖 libarchive。某些精简构建(或缺少依赖的发行版)没有编进去,
/// 此时症状是运行时才报 "no such operation",错误信息很难懂 —— 不如提前查清。
pub fn check_dzsave(vips: &Path) -> Result<(), String> {
    let mut cmd = vips_command(vips);
    cmd.arg("dzsave");
    let out = cmd
        .output()
        .map_err(|e| format!("无法执行 vips: {e}"))?;

    // 无参数调用会打印 usage 并以非零码退出,这是预期行为
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    if text.contains("deepzoom") {
        Ok(())
    } else {
        Err("此 vips 构建不含 dzsave(通常因为缺 libarchive)。\
             请换用 libvips 官方的 vips-dev-x64-all 包。"
            .into())
    }
}

/// 金字塔里的瓦片总数,用于在 vips 自带进度不可用时估算百分比。
///
/// DZI 每一级的尺寸是上一级的一半(向上取整),直到 1×1。
pub fn expected_tile_count(width: u32, height: u32, tile_size: u32) -> u64 {
    let tile = tile_size as u64;
    let (mut w, mut h) = (width as u64, height as u64);
    let mut total = 0u64;

    loop {
        total += w.div_ceil(tile) * h.div_ceil(tile);
        if w <= 1 && h <= 1 {
            break;
        }
        w = w.div_ceil(2);
        h = h.div_ceil(2);
    }
    total
}

/// 切片参数。
#[derive(Clone, Copy, Debug)]
pub struct SliceOptions {
    pub tile_size: u32,
    pub overlap: u32,
    /// JPEG 质量。仅当 `suffix` 是 jpg 时有意义。
    pub quality: u32,
    /// 瓦片格式:`jpg` 或 `png`。
    pub tile_format: TileFormat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileFormat {
    /// 有损。对边缘锐利的图形类图像会在每条边产生振铃伪影,可能误导判读。
    Jpeg,
    Png,
    /// 无损,且对这种少量颜色 + 大片平坦区域的图,体积明显小于 PNG。
    /// 已实测验证像素完全一致(与 PNG 逐像素相减,最大差值 0)。
    Webp,
}

impl TileFormat {
    /// 传给 `--suffix` 的值。方括号里是保存选项。
    pub fn suffix_arg(self, quality: u32) -> String {
        match self {
            TileFormat::Jpeg => format!(".jpg[Q={quality}]"),
            // PNG 用默认压缩档。实测 compression=9 只省 8%,却慢数倍,
            // 而这个项目一次性切片的耗时已经够长了,不划算。
            TileFormat::Png => ".png".to_string(),
            TileFormat::Webp => ".webp[lossless]".to_string(),
        }
    }

    /// 瓦片扩展名。DZI 描述符的 Format 字段和 OpenSeadragon 的 fileFormat 都用它。
    ///
    /// 注意 vips 只会把格式名写进描述符,不会把方括号里的选项写进去 ——
    /// 已经实测确认过这一点,否则前端会拼出 `.webp[lossless]` 这种不存在的文件名。
    pub fn extension(self) -> &'static str {
        match self {
            TileFormat::Jpeg => "jpg",
            TileFormat::Png => "png",
            TileFormat::Webp => "webp",
        }
    }
}

/// 启动 dzsave 子进程。
///
/// `out_base` **不含扩展名**;vips 会生成 `<out_base>.dzi` 和 `<out_base>_files/`。
pub fn spawn_dzsave(
    vips: &Path,
    input: &Path,
    out_base: &Path,
    opts: SliceOptions,
) -> Result<Child, String> {
    let mut cmd = vips_command(vips);

    cmd.arg("dzsave")
        .arg(input)
        .arg(out_base)
        .arg("--layout")
        .arg("dz")
        .arg("--tile-size")
        .arg(opts.tile_size.to_string())
        .arg("--overlap")
        .arg(opts.overlap.to_string())
        // onepixel: 金字塔一路降到 1×1。缩到最小时仍有东西可显示。
        .arg("--depth")
        .arg("onepixel")
        .arg("--suffix")
        .arg(opts.tile_format.suffix_arg(opts.quality))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    cmd.spawn().map_err(|e| format!("启动 vips dzsave 失败: {e}"))
}

/// 从 vips 的进度输出里提取百分比。
///
/// 实际格式是 `vips temp-3: 45% complete` —— 注意前缀是**临时图像名**(如 `temp-3`),
/// 不是操作名 `dzsave`,而且这个名字会变。所以这里刻意不匹配任何前缀,
/// 只从 `%` 往前读数字,免得依赖一个不稳定的字符串。
pub fn parse_percent(text: &str) -> Option<u32> {
    let pct_at = text.find('%')?;
    let digits: String = text[..pct_at]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse().ok()
}

/// 把子进程的 stdout 接到一个回调上,用于转出进度。
/// 单独开线程跑,绝不阻塞调用方。
pub fn forward_progress<F>(child: &mut Child, on_percent: F)
where
    F: Fn(u32) + Send + 'static,
{
    let Some(stdout) = child.stdout.take() else {
        return;
    };

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        // 进度用 \r 刷新同一行,所以要按 \r 切而不是按 \n
        for chunk in reader.split(b'\r').flatten() {
            let text = String::from_utf8_lossy(&chunk);
            if let Some(pct) = parse_percent(&text) {
                on_percent(pct);
            }
        }
    });
}

/// 递归统计目录下的文件数,作为进度兜底。
///
/// vips 的进度输出在多线程下可能不平滑,所以并行跑一个「数瓦片文件」的估算,
/// 前端取两者较大值。
pub fn count_files(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| {
            let path = e.path();
            if path.is_dir() {
                count_files(&path)
            } else {
                1
            }
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_count_matches_known_dzi() {
        // 1×1 的图在 tile=256 时只有 1 张瓦片(金字塔就一级)
        assert_eq!(expected_tile_count(1, 1, 256), 1);
        // 256×256 正好一张,再加下半程的 128、64... 各级
        assert_eq!(expected_tile_count(256, 256, 256), 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1);
        // 512×512 → 一级 4 张,之后每级递减
        assert_eq!(expected_tile_count(512, 512, 256), 4 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1);
    }

    #[test]
    fn parses_vips_progress_output() {
        // 实测捕获的真实格式:前缀是临时图像名,不是操作名。
        // 用 temp-3 而不是 dzsave,防止以后有人「修正」成匹配 dzsave。
        assert_eq!(parse_percent("vips temp-3: 45% complete"), Some(45));
        assert_eq!(parse_percent("vips temp-12: 100% complete"), Some(100));
        assert_eq!(parse_percent("vips temp-3: 0% complete"), Some(0));
        assert_eq!(parse_percent("no percent here"), None);
        // 干扰行:开头那行也带数字,但没百分号,不该被误读成进度
        assert_eq!(
            parse_percent("vips temp-3: 6000 x 6000 pixels, 4 threads, 6000 x 16 tiles"),
            None
        );
    }

    // 下面两条要跑真的 vips 二进制 —— 这是本项目里唯一依赖外部程序的地方。
    // 找不到就**跳过**而不是失败:开发机上没装 vips 不该让人以为代码坏了。

    fn find_vips() -> Option<PathBuf> {
        let bundled = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("vips-win64")
            .join("bin")
            .join("vips.exe");
        if bundled.is_file() {
            return Some(bundled);
        }
        which(if cfg!(windows) { "vips.exe" } else { "vips" })
    }

    /// 造一张「每个像素的值就是它自己的坐标」的图。
    ///
    /// 除了它,没法验证裁剪取到的是**哪一块** —— 参数顺序写错(left/top 和
    /// width/height 调个个)时尺寸照样对,只有读像素值才抓得住。
    fn setup_ramp(tag: &str) -> Option<(PathBuf, PathBuf, PathBuf)> {
        // 测试是并行跑的,同一个进程 pid 相同,所以目录名必须带上用例名
        let dir = std::env::temp_dir().join(format!("bigimgpin-vips-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let vips = find_vips()?;
        let ramp = dir.join("ramp.tif");
        let status = vips_command(&vips)
            .arg("xyz")
            .arg(&ramp)
            .args(["200", "100", "--csize", "3"])
            .output()
            .ok()?;
        assert!(status.status.success(), "造测试图失败");

        Some((vips, dir, ramp))
    }

    fn getpoint(vips: &Path, image: &Path, x: u32, y: u32) -> String {
        // 刻意**不走** vips_command:它会给每个调用加上 VIPS_PROGRESS=1,
        // 进度信息混进 stdout,而这里要读的正是 stdout 上的像素值。
        let mut cmd = Command::new(vips);
        hide_console(&mut cmd);
        let out = cmd
            .arg("getpoint")
            .arg(image)
            .args([x.to_string(), y.to_string()])
            .output()
            .expect("执行 vips getpoint 失败");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn crop_image_extracts_the_requested_region() {
        let Some((vips, dir, ramp)) = setup_ramp("region") else {
            eprintln!("跳过:没找到 vips 二进制");
            return;
        };
        let out = dir.join("crop.tif");

        crop_image(&vips, &ramp, &out, 10, 20, 50, 40).unwrap();

        // 裁出来的 (0,0) 应当是原图的 (10,20)
        assert!(
            getpoint(&vips, &out, 0, 0).starts_with("10 20"),
            "裁剪起点错了:{}",
            getpoint(&vips, &out, 0, 0)
        );
        // 右下角:10+49, 20+39
        assert!(
            getpoint(&vips, &out, 49, 39).starts_with("59 59"),
            "裁剪终点错了:{}",
            getpoint(&vips, &out, 49, 39)
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn crop_image_rejects_out_of_bounds() {
        let Some((vips, dir, ramp)) = setup_ramp("oob") else {
            eprintln!("跳过:没找到 vips 二进制");
            return;
        };
        let out = dir.join("oob.tif");

        // 实测 vips 报 `bad extract area` 并以非零码退出,不产出文件。
        // 调用方(export::normalize)负责在此之前夹取到图内。
        assert!(crop_image(&vips, &ramp, &out, 180, 90, 50, 40).is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn crop_container_follows_bit_depth() {
        // 8 / 16 位留给 PNG(哪都能打开),其余走 TIFF 保住精度
        assert_eq!(crop_extension("uchar"), "png");
        assert_eq!(crop_extension("ushort"), "png");
        // float 最关键:实测 vips 会把它**静默**压成 8 位 PNG
        assert_eq!(crop_extension("float"), "tif");
        assert_eq!(crop_extension("int"), "tif");
        assert_eq!(crop_extension("double"), "tif");
    }

    #[test]
    fn parses_header_fields_by_exact_key_prefix() {
        // 真实输出形态:第一行是 `<路径>: 200x100 ushort, 3 bands, rgb16, tiffload`
        let text = "C:/imgs/width_probe.tif: 200x100 ushort, 3 bands, rgb16, tiffload\n\
                    width: 200\n\
                    height: 100\n\
                    bands: 3\n\
                    format: ushort\n";
        let field = |key: &str| -> Option<String> {
            text.lines()
                .find_map(|line| line.strip_prefix(key)?.strip_prefix(':'))
                .map(|v| v.trim().to_string())
        };

        // 路径里带 width 也不能被当成字段行 —— 第一行不以 "width" 开头
        assert_eq!(field("width").as_deref(), Some("200"));
        assert_eq!(field("format").as_deref(), Some("ushort"));
    }

    #[test]
    fn suffix_args_are_well_formed() {
        assert_eq!(TileFormat::Jpeg.suffix_arg(90), ".jpg[Q=90]");
        assert_eq!(TileFormat::Png.suffix_arg(90), ".png");
        assert_eq!(TileFormat::Webp.suffix_arg(90), ".webp[lossless]");
    }

    #[test]
    fn extensions_have_no_option_brackets() {
        // 关键:扩展名会进 DZI 描述符,再被前端拼成瓦片 URL。
        // 带上方括号就会变成 .webp[lossless] 这种不存在的文件名。
        for format in [TileFormat::Jpeg, TileFormat::Png, TileFormat::Webp] {
            assert!(!format.extension().contains('['));
            assert!(!format.extension().contains('.'));
        }
    }

}

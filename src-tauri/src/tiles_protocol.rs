//! 把切片缓存目录通过自定义协议暴露给 webview。
//!
//! 为什么不用 Tauri 内置的 asset 协议:asset 协议需要配 glob scope,而各平台的
//! 缓存目录形态不一(macOS 在 `~/Library/...`,Linux 在带点的 `~/.local/share/...`,
//! 后者会踩 `requireLiteralLeadingDot` 的坑)。自己实现协议可以**只暴露缓存根目录**,
//! 而且 MIME、缓存头、404 语义全在自己手里 —— 出问题时前端看到的是明确的 HTTP 状态码,
//! 而不是一块没有解释的白。

use std::path::{Component, PathBuf};

use tauri::http::{self, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

/// 协议名。前端拼 URL 时必须用这个。
pub const SCHEME: &str = "bigimage";

/// URL 前缀的**唯一收敛点**。
///
/// Windows/Android 上自定义协议被映射成 `http://<scheme>.localhost`,
/// 其他平台是 `<scheme>://localhost`。两处不一致会导致其中一个平台静默白屏,
/// 所以整个代码库里只允许这一个地方做这个判断。
pub fn protocol_origin() -> &'static str {
    if cfg!(windows) {
        "http://bigimage.localhost"
    } else {
        "bigimage://localhost"
    }
}

/// 一次切片产物的瓦片根 URL(给 OpenSeadragon 的 `tilesUrl`,结尾必须带 `/`)。
pub fn tiles_url(id: &str) -> String {
    format!("{}/tiles/{}/image_files/", protocol_origin(), id)
}

/// 协议处理器。注册时必须用**异步版**(`register_asynchronous_uri_scheme_protocol`):
/// 同步版在 macOS 上跑在主线程,一次慢磁盘 IO 就掉帧。
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    use tauri::Manager;

    let app_dir = match ctx.app_handle().path().app_local_data_dir() {
        Ok(dir) => dir,
        Err(e) => return respond_text(responder, StatusCode::INTERNAL_SERVER_ERROR, &format!("无法定位数据目录: {e}")),
    };

    // URL 形如 /tiles/<id>/image_files/8/1_2.jpg
    let raw_path = request.uri().path().to_string();
    let decoded = percent_decode(raw_path.trim_start_matches('/'));

    let Some(relative) = safe_relative_path(&decoded) else {
        return respond_text(responder, StatusCode::FORBIDDEN, "路径非法");
    };

    let absolute = app_dir.join(&relative);

    // 二次确认:即使前面的逐段校验有疏漏,也不能跑出数据目录
    if !absolute.starts_with(&app_dir) {
        return respond_text(responder, StatusCode::FORBIDDEN, "路径越界");
    }

    let content_type = content_type_for(&absolute);

    // 文件 IO 放到独立线程 —— 绝不占用主线程或异步运行时的工作线程
    std::thread::spawn(move || match std::fs::read(&absolute) {
        Ok(bytes) => {
            let response = http::Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, content_type)
                // 缓存内容由内容哈希寻址,永不改变,可以放心长缓存
                .header(
                    http::header::CACHE_CONTROL,
                    "public, max-age=31536000, immutable",
                )
                .body(bytes)
                .expect("构造响应失败");
            responder.respond(response);
        }
        Err(e) => {
            let status = if e.kind() == std::io::ErrorKind::NotFound {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            respond_text(responder, status, &format!("{absolute:?}: {e}"));
        }
    });
}

/// 逐段白名单校验。
///
/// 只允许字母数字和 `._-`,于是 `..`、绝对路径、盘符、URL 编码的斜杠全部被拒。
/// 比「拼完再检查前缀」更严格 —— 前者是黑名单,这里是白名单。
fn safe_relative_path(path: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();

    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        if !segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return None;
        }
        out.push(segment);
    }

    // 必须落在 tiles/ 下,防止协议被当成任意文件读取器
    if out.components().next() != Some(Component::Normal("tiles".as_ref())) {
        return None;
    }

    Some(out)
}

fn content_type_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("dzi") => "application/xml",
        _ => "application/octet-stream",
    }
}

/// 最小化的 percent-decode,避免为这一个函数引入依赖。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

fn respond_text(responder: UriSchemeResponder, status: StatusCode, message: &str) {
    let response = http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("构造响应失败");
    responder.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_real_tile_paths() {
        let p = safe_relative_path("tiles/abc123/image_files/8/1_2.jpg").unwrap();
        assert_eq!(p, PathBuf::from("tiles/abc123/image_files/8/1_2.jpg"));
    }

    #[test]
    fn rejects_traversal() {
        assert!(safe_relative_path("tiles/../../etc/passwd").is_none());
        assert!(safe_relative_path("tiles/abc/../../../secret").is_none());
        assert!(safe_relative_path("tiles/..%2f..%2fsecret").is_none());
    }

    #[test]
    fn rejects_paths_outside_tiles() {
        // 协议不能变成任意文件读取器
        assert!(safe_relative_path("passwd").is_none());
        assert!(safe_relative_path("image_files/8/1_2.jpg").is_none());
        assert!(safe_relative_path("").is_none());
    }

    #[test]
    fn rejects_absolute_and_odd_segments() {
        assert!(safe_relative_path("tiles//x").is_none());
        assert!(safe_relative_path("tiles/./x").is_none());
        assert!(safe_relative_path("tiles/C:/windows").is_none());
        assert!(safe_relative_path("tiles/a b").is_none());
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn origin_matches_platform() {
        let origin = protocol_origin();
        if cfg!(windows) {
            assert_eq!(origin, "http://bigimage.localhost");
        } else {
            assert_eq!(origin, "bigimage://localhost");
        }
    }
}

//! 从 MinIO 取缺陷图并转成 data URL 交给前端。
//!
//! 为什么不在前端直接 `<img src="http://...">`:
//!
//! - 群策等厂的数据把图片打进 zip 里,必须带 `x-minio-extract: true` 请求头才能
//!   读到包内文件,`<img>` 标签设不了请求头;
//! - 走 Rust 也顺带绕开 WebView 的 CORS/CSP 差异,换平台不会突然取不到图。
//!
//! 面板 JSON 里存的是相对面板目录的 key,而面板在 MinIO 上的真实前缀经常和
//! `local_describe_path` 对不上(导入工具会改前缀),所以前端会传一组候选前缀,
//! 这里按顺序逐个试,命中后把 `base` / `prefix` 返回给前端缓存。
//!
//! 旧数据在旧 MinIO(9102),新数据在新 MinIO(9104),所以 `bases` 也可能有多套;
//! 候选前缀在外层、地址在内层:先用最可能的前缀把两套地址都试一遍,再换下一个前缀。

use std::collections::HashSet;
use std::time::Duration;

use base64::Engine;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};

/// 单张缺陷图的体积上限。缺陷小图通常几十 KB,超过这个数多半是配置错了
/// (比如把 JSON 当图片取回来了),不必把整个响应读进内存。
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// 和 `encodeURIComponent` 对齐:保留 `-_.!~*'()` 和字母数字,其余按 UTF-8 编码。
/// 不能整个用 NON_ALPHANUMERIC —— 那样连 `.` 都会被编码成 `%2E`。
const PATH_SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefectImage {
    /// `data:image/jpeg;base64,...`,前端直接塞给 `<img>`
    pub data_url: String,
    /// 实际命中的完整 URL。排查「为什么取不到」时唯一能对得上的东西。
    pub url: String,
    /// 命中的 MinIO 地址(不含 bucket/key),前端据此跳过后续探测
    pub base: String,
    /// 命中的 key 前缀(不含 bucket)。图片路径原样命中时是空串。
    pub prefix: String,
}

fn encode_key(key: &str) -> String {
    key.split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| utf8_percent_encode(segment, PATH_SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// 拼出 `<base>/<bucket>/<key>`。key 已经带 bucket 前缀时不再重复加。
fn join_url(base: &str, bucket: &str, key: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let bucket = bucket.trim().trim_matches('/');
    let key = key.trim().trim_start_matches('/');
    let full = if bucket.is_empty() || key.starts_with(&format!("{bucket}/")) {
        key.to_string()
    } else {
        format!("{bucket}/{key}")
    };
    format!("{base}/{}", encode_key(&full))
}

fn build_candidates(
    image: &str,
    bucket: &str,
    prefixes: &[String],
    bases: &[String],
) -> Vec<(String, String, String)> {
    let image = image.trim().trim_start_matches('/');
    if image.is_empty() {
        return Vec::new();
    }

    let prefixes: Vec<String> = if prefixes.is_empty() {
        vec![String::new()]
    } else {
        prefixes
            .iter()
            .map(|prefix| prefix.trim().trim_matches('/').to_string())
            .collect()
    };

    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    // 前缀在外层:同一份前缀先把新旧两套地址都试掉,避免旧数据在新 MinIO 上
    // 把每个前缀都白试一遍。
    for prefix in &prefixes {
        let key = if prefix.is_empty()
            || image == prefix
            || image.starts_with(&format!("{prefix}/"))
        {
            image.to_string()
        } else {
            format!("{prefix}/{image}")
        };

        for base in bases {
            let base = base.trim();
            if !(base.starts_with("http://") || base.starts_with("https://")) {
                continue;
            }
            let base = base.trim_end_matches('/').to_string();
            let url = join_url(&base, bucket, &key);
            if seen.insert(url.clone()) {
                candidates.push((url, base, prefix.clone()));
            }
        }
    }

    // 最后再试一次「图片路径原样当 key」:有些数据里的 origin_images 已经带了面板目录
    if !prefixes.iter().any(|prefix| prefix.is_empty()) {
        for base in bases {
            let base = base.trim();
            if !(base.starts_with("http://") || base.starts_with("https://")) {
                continue;
            }
            let base = base.trim_end_matches('/').to_string();
            let url = join_url(&base, bucket, image);
            if seen.insert(url.clone()) {
                candidates.push((url, base, String::new()));
            }
        }
    }

    candidates
}

fn is_zip_path(key: &str) -> bool {
    key.to_ascii_lowercase().contains(".zip")
}

/// 有的 MinIO 对图片也会回 `application/octet-stream`,按魔数兜底。
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        Some("image/png")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn image_mime(bytes: &[u8], header: Option<&str>) -> Option<String> {
    if let Some(value) = header {
        let value = value.split(';').next().unwrap_or("").trim();
        if value.starts_with("image/") {
            return Some(value.to_string());
        }
    }
    sniff_mime(bytes).map(str::to_string)
}

async fn request_once(
    client: &reqwest::Client,
    url: &str,
    extract_zip: bool,
) -> Result<(Vec<u8>, String), String> {
    let mut request = client.get(url);
    if extract_zip {
        request = request.header("x-minio-extract", "true");
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let header = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("图片太大({} 字节)", bytes.len()));
    }

    let mime = image_mime(&bytes, header.as_deref())
        .ok_or_else(|| format!("返回的不是图片(content-type={})", header.unwrap_or_default()))?;
    Ok((bytes.to_vec(), mime))
}

/// 取一张缺陷图。`image` 是面板 JSON 里的相对 key(或已归一化的绝对 URL 路径)。
#[tauri::command]
pub async fn fetch_defect_image(
    image: String,
    bucket: String,
    prefixes: Vec<String>,
    bases: Vec<String>,
) -> Result<DefectImage, String> {
    let bucket = if bucket.trim().is_empty() {
        "deepiresults".to_string()
    } else {
        bucket.trim().trim_matches('/').to_string()
    };
    let candidates = build_candidates(&image, &bucket, &prefixes, &bases);
    if candidates.is_empty() {
        return Err("没有可用的 MinIO 地址,请先在设置里填写 IP 和端口".into());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败:{error}"))?;

    let zip_like = is_zip_path(&image);
    let total = candidates.len();
    let mut failures: Vec<String> = Vec::new();

    for (url, base, prefix) in candidates {
        // zip 内图片要带头;本地展开式存储的 key 里也可能带 .zip 段,带头会 404,
        // 所以带头失败后再去掉头试一次。非 zip 路径直接不带。
        let result = if zip_like {
            match request_once(&client, &url, true).await {
                Ok(value) => Ok(value),
                Err(_) => request_once(&client, &url, false).await,
            }
        } else {
            request_once(&client, &url, false).await
        };

        match result {
            Ok((bytes, mime)) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                return Ok(DefectImage {
                    data_url: format!("data:{mime};base64,{encoded}"),
                    url,
                    base,
                    prefix,
                });
            }
            Err(error) => {
                if failures.len() < 4 {
                    failures.push(format!("{url} → {error}"));
                }
            }
        }
    }

    let more = if total > failures.len() {
        format!("\n(共试了 {total} 个地址,只列出前 {} 个)", failures.len())
    } else {
        String::new()
    };
    Err(format!(
        "缺陷图片没能加载:\n{}{}",
        failures.join("\n"),
        more
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_key_encodes_spaces_but_keeps_slashes_and_dots() {
        assert_eq!(
            encode_key("circuit discolor/a-b_c.d.jpg"),
            "circuit%20discolor/a-b_c.d.jpg"
        );
        assert_eq!(encode_key("中文/图.jpg"), "%E4%B8%AD%E6%96%87/%E5%9B%BE.jpg");
    }

    #[test]
    fn join_url_does_not_duplicate_bucket() {
        assert_eq!(
            join_url("http://127.0.0.1:9104/", "deepiresults", "a/b.jpg"),
            "http://127.0.0.1:9104/deepiresults/a/b.jpg"
        );
        assert_eq!(
            join_url("http://127.0.0.1:9104", "deepiresults", "deepiresults/a b.jpg"),
            "http://127.0.0.1:9104/deepiresults/a%20b.jpg"
        );
    }

    #[test]
    fn candidates_try_every_base_for_one_prefix_before_moving_on() {
        let candidates = build_candidates(
            "panel/img.jpg",
            "deepiresults",
            &["p".to_string(), "q".to_string()],
            &[
                "http://127.0.0.1:9104".to_string(),
                "http://127.0.0.1:9102".to_string(),
            ],
        );
        let urls: Vec<&str> = candidates.iter().map(|(url, _, _)| url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://127.0.0.1:9104/deepiresults/p/panel/img.jpg",
                "http://127.0.0.1:9102/deepiresults/p/panel/img.jpg",
                "http://127.0.0.1:9104/deepiresults/q/panel/img.jpg",
                "http://127.0.0.1:9102/deepiresults/q/panel/img.jpg",
                // 最后还会试一次「图片路径原样当 key」
                "http://127.0.0.1:9104/deepiresults/panel/img.jpg",
                "http://127.0.0.1:9102/deepiresults/panel/img.jpg",
            ]
        );
    }

    #[test]
    fn candidates_keep_the_image_path_itself_as_the_last_resort() {
        let candidates = build_candidates(
            "20261027/a/panel/img.jpg",
            "deepiresults",
            &["20261027/a/panel".to_string()],
            &["http://127.0.0.1:9104".to_string()],
        );
        // 图片路径本身就带了面板目录时,不能再拼一遍前缀
        assert!(candidates
            .iter()
            .any(|(url, _, _)| url.ends_with("/deepiresults/20261027/a/panel/img.jpg")));
    }

    #[test]
    fn candidates_skip_invalid_bases() {
        let candidates = build_candidates(
            "x.jpg",
            "deepiresults",
            &[],
            &["".to_string(), "127.0.0.1:9104".to_string()],
        );
        assert!(candidates.is_empty());
    }

    #[test]
    fn zip_paths_are_detected_case_insensitively() {
        assert!(is_zip_path("a/defect_package.ZIP/x.jpg"));
        assert!(!is_zip_path("a/defect_package/x.jpg"));
    }
}

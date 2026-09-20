fn main() {
    // tauri-build 自己的 rerun-if-changed 不覆盖 icons/,换图标不会重新生成
    // resource.lib,exe 会一直链着旧图标(dev 也用的是 exe 里的资源,不走 png)。
    // 少了这行就只能靠 cargo clean 才能换图标。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}

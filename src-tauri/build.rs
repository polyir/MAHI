fn main() {
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    cc::Build::new()
        .file("native/window_vision_bridge.m")
        .file("native/microphone_bridge.m")
        .flag("-fobjc-arc")
        .flag("-fblocks")
        .flag("-mmacosx-version-min=12.3")
        .warnings(true)
        .compile("mahi_window_vision");

    println!("cargo:rustc-link-arg=-mmacosx-version-min=12.3");

    for framework in [
        "AppKit",
        "AVFoundation",
        "AudioToolbox",
        "CoreGraphics",
        "CoreImage",
        "CoreMedia",
        "CoreVideo",
        "Foundation",
        "ScreenCaptureKit",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }

    println!("cargo:rerun-if-changed=native/window_vision_bridge.h");
    println!("cargo:rerun-if-changed=native/window_vision_bridge.m");
    println!("cargo:rerun-if-changed=native/microphone_bridge.h");
    println!("cargo:rerun-if-changed=native/microphone_bridge.m");
}

mod health;
mod upstream;

use std::fs;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const EXTERNAL_HOSTS: [&str; 3] = ["github.com", "pay.ldxp.cn", "chatgpt.com"];

fn allowed_external_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| EXTERNAL_HOSTS.contains(&host))
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !allowed_external_url(&url) {
        return Err("仅允许打开已审核的 HTTPS 外部链接".to_string());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("无法调用系统默认浏览器：{error}"))
}

#[tauri::command]
async fn save_output_file(
    app: tauri::AppHandle,
    suggested_name: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err("输出文件超过 64 MiB 安全上限".to_string());
    }

    let file_name = Path::new(&suggested_name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("session-converter-output.json")
        .to_string();
    let extension = Path::new(&file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| value == "json" || value == "zip")
        .unwrap_or_else(|| "json".to_string());
    let filter_name = if extension == "zip" {
        "ZIP 压缩包"
    } else {
        "JSON 文件"
    };
    let selected = app
        .dialog()
        .file()
        .set_title("保存转换结果")
        .set_file_name(file_name)
        .add_filter(filter_name, &[extension.as_str()])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let destination = selected
        .into_path()
        .map_err(|_| "当前平台返回了不支持的保存路径".to_string())?;

    fs::write(&destination, bytes).map_err(|error| format!("无法保存文件：{error}"))?;
    Ok(Some(destination.to_string_lossy().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_output_file,
            open_external_url,
            health::probe_chatgpt_workspace,
            upstream::check_upstream_updates
        ])
        .run(tauri::generate_context!())
        .expect("error while running Session Converter");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_limit_is_bounded() {
        assert_eq!(MAX_OUTPUT_BYTES, 67_108_864);
    }

    #[test]
    fn external_links_are_https_and_host_allowlisted() {
        assert!(allowed_external_url(
            "https://github.com/rw0104/session-converter-desktop"
        ));
        assert!(allowed_external_url("https://pay.ldxp.cn/shop/13QL6FLR"));
        assert!(allowed_external_url("https://chatgpt.com/api/auth/session"));
        assert!(!allowed_external_url(
            "http://github.com/rw0104/session-converter-desktop"
        ));
        assert!(!allowed_external_url("https://github.com.example.invalid/"));
    }
}

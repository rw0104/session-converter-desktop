use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheck {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<AppUpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    let update = app
        .updater()
        .map_err(|error| format!("无法初始化软件更新器：{error}"))?
        .check()
        .await
        .map_err(|error| format!("无法检查软件更新：{error}"))?;

    Ok(match update {
        Some(update) => AppUpdateCheck {
            available: true,
            current_version,
            version: Some(update.version),
            date: update.date.map(|value| value.to_string()),
            body: update.body,
        },
        None => AppUpdateCheck {
            available: false,
            current_version,
            version: None,
            date: None,
            body: None,
        },
    })
}

#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| format!("无法初始化软件更新器：{error}"))?
        .check()
        .await
        .map_err(|error| format!("无法检查软件更新：{error}"))?
        .ok_or_else(|| "当前已是最新正式版本".to_string())?;

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("软件更新安装失败：{error}"))?;

    app.restart();
}

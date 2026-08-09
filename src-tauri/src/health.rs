use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

const CHATGPT_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const CODEX_CLIENT_VERSION: &str = "0.146.0";
const CODEX_ORIGINATOR: &str = "codex-tui";
const CODEX_USER_AGENT: &str = "codex-tui/0.146.0 (Ubuntu 22.4.0; x86_64) xterm-256color";
const MAX_PROBE_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub status: u16,
    pub available: Option<bool>,
    pub stage: &'static str,
    pub code: String,
    pub model: Option<String>,
    pub available_models: Vec<String>,
}

impl ProbeResult {
    fn local_error(code: &str) -> Self {
        Self {
            status: 400,
            available: Some(false),
            stage: "local",
            code: code.to_string(),
            model: None,
            available_models: Vec::new(),
        }
    }

    fn network(code: &str) -> Self {
        Self {
            status: 0,
            available: None,
            stage: "network",
            code: code.to_string(),
            model: None,
            available_models: Vec::new(),
        }
    }
}

fn valid_access_token(value: &str) -> bool {
    let token = value.trim();
    (16..=16_384).contains(&token.len()) && !token.chars().any(|character| character.is_control())
}

fn valid_account_id(value: &str) -> bool {
    let account_id = value.trim();
    (1..=128).contains(&account_id.len())
        && account_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_model_slug(value: &str) -> bool {
    let model = value.trim();
    (1..=128).contains(&model.len())
        && model.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

fn visible_model_slugs(models: &[Value]) -> Vec<String> {
    let mut slugs = Vec::new();
    for model in models {
        if model.get("visibility").and_then(Value::as_str) != Some("list") {
            continue;
        }
        let Some(slug) = model.get("slug").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if valid_model_slug(slug) && !slugs.iter().any(|existing| existing == slug) {
            slugs.push(slug.to_string());
        }
    }
    if slugs.is_empty() {
        for model in models {
            let Some(slug) = model.get("slug").and_then(Value::as_str).map(str::trim) else {
                continue;
            };
            if valid_model_slug(slug) && !slugs.iter().any(|existing| existing == slug) {
                slugs.push(slug.to_string());
            }
        }
    }
    slugs
}

fn select_requested_model(available: &[String], requested: &str) -> Option<String> {
    if requested == "auto" {
        available.first().cloned()
    } else {
        available
            .iter()
            .find(|model| model.as_str() == requested)
            .cloned()
    }
}

fn availability(status: u16) -> Option<bool> {
    if (200..300).contains(&status) {
        Some(true)
    } else if [401, 402, 403].contains(&status) {
        Some(false)
    } else {
        None
    }
}

fn availability_with_code(status: u16, code: &str) -> Option<bool> {
    if status == 403
        && matches!(
            code,
            "model_not_available" | "model_not_found" | "unsupported_model"
        )
    {
        return None;
    }
    if !(200..300).contains(&status) {
        return availability(status);
    }
    if code.is_empty() {
        return Some(true);
    }
    match code {
        "account_deactivated"
        | "authentication_error"
        | "billing_hard_limit_reached"
        | "deactivated_workspace"
        | "invalid_api_key"
        | "subscription_inactive"
        | "workspace_deactivated" => Some(false),
        _ => None,
    }
}

fn upstream_code(value: &Value) -> String {
    value
        .pointer("/detail/code")
        .or_else(|| value.pointer("/error/code"))
        .or_else(|| value.pointer("/response/error/code"))
        .or_else(|| value.pointer("/error/type"))
        .or_else(|| value.pointer("/response/error/type"))
        .or_else(|| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(128)
        .collect()
}

fn request_headers(access_token: &str, account_id: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(CODEX_USER_AGENT));
    headers.insert("originator", HeaderValue::from_static(CODEX_ORIGINATOR));
    headers.insert("version", HeaderValue::from_static(CODEX_CLIENT_VERSION));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}"))
            .map_err(|_| "access token 包含无效请求头字符".to_string())?,
    );
    if !account_id.is_empty() {
        headers.insert(
            "chatgpt-account-id",
            HeaderValue::from_str(account_id)
                .map_err(|_| "账号空间 ID 包含无效请求头字符".to_string())?,
        );
    }
    Ok(headers)
}

fn streamed_error_code(body: &[u8]) -> String {
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        let code = upstream_code(&value);
        if !code.is_empty() {
            return code;
        }
    }
    for line in String::from_utf8_lossy(body).lines() {
        let Some(payload) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        let code = upstream_code(&value);
        if !code.is_empty() {
            return code;
        }
        if matches!(
            value.get("type").and_then(Value::as_str),
            Some("error" | "response.failed")
        ) {
            return "response_failed".to_string();
        }
    }
    String::new()
}

async fn error_code(mut response: reqwest::Response) -> String {
    let mut body = Vec::new();
    loop {
        let Ok(chunk) = response.chunk().await else {
            break;
        };
        let Some(chunk) = chunk else {
            break;
        };
        let remaining = MAX_PROBE_RESPONSE_BYTES.saturating_sub(body.len());
        if remaining == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() >= MAX_PROBE_RESPONSE_BYTES {
            break;
        }
    }
    streamed_error_code(&body)
}

#[tauri::command]
pub async fn probe_chatgpt_workspace(
    access_token: String,
    account_id: String,
    requested_model: String,
) -> ProbeResult {
    let access_token = access_token.trim().to_string();
    let account_id = account_id.trim().to_string();
    let requested_model = requested_model.trim().to_string();
    if !valid_access_token(&access_token) {
        return ProbeResult::local_error("invalid_access_token");
    }
    if !account_id.is_empty() && !valid_account_id(&account_id) {
        return ProbeResult::local_error("invalid_account_id");
    }
    if requested_model != "auto" && !valid_model_slug(&requested_model) {
        return ProbeResult::local_error("invalid_requested_model");
    }

    let headers = match request_headers(&access_token, &account_id) {
        Ok(headers) => headers,
        Err(_) => return ProbeResult::local_error("invalid_headers"),
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => return ProbeResult::network("client_error"),
    };

    let models_url =
        format!("{CHATGPT_CODEX_BASE_URL}/models?client_version={CODEX_CLIENT_VERSION}");
    let models_response = match client.get(models_url).headers(headers.clone()).send().await {
        Ok(response) => response,
        Err(error) => {
            return ProbeResult::network(if error.is_timeout() {
                "timeout"
            } else {
                "network_error"
            })
        }
    };
    let models_status = models_response.status().as_u16();
    if !models_response.status().is_success() {
        return ProbeResult {
            status: models_status,
            available: availability(models_status),
            stage: "models",
            code: error_code(models_response).await,
            model: None,
            available_models: Vec::new(),
        };
    }

    let models_payload = models_response.json::<Value>().await.unwrap_or(Value::Null);
    let models = models_payload
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let available_models = visible_model_slugs(&models);
    let Some(model) = select_requested_model(&available_models, &requested_model) else {
        return ProbeResult {
            status: 200,
            available: None,
            stage: "models",
            code: if available_models.is_empty() {
                "no_available_model".to_string()
            } else {
                "requested_model_unavailable".to_string()
            },
            model: if requested_model == "auto" {
                None
            } else {
                Some(requested_model)
            },
            available_models,
        };
    };

    let body = json!({
        "model": model,
        "instructions": "",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": "Reply OK." }]
        }],
        "tools": [],
        "tool_choice": "auto",
        "reasoning": Value::Null,
        "store": false,
        "stream": true,
        "include": []
    });
    let mut response_headers = headers;
    response_headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    response_headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response_headers.insert(
        "openai-beta",
        HeaderValue::from_static("responses=experimental"),
    );
    if let Ok(session_id) = HeaderValue::from_str(&Uuid::new_v4().to_string()) {
        response_headers.insert("session_id", session_id);
    }

    let model_response = match client
        .post(format!("{CHATGPT_CODEX_BASE_URL}/responses"))
        .headers(response_headers)
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return ProbeResult::network(if error.is_timeout() {
                "timeout"
            } else {
                "network_error"
            })
        }
    };
    let response_status = model_response.status().as_u16();
    let code = error_code(model_response).await;

    ProbeResult {
        status: response_status,
        available: availability_with_code(response_status, &code),
        stage: "response",
        code,
        model: Some(model),
        available_models,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_probe_credentials_without_network() {
        assert!(valid_access_token("1234567890abcdef"));
        assert!(!valid_access_token("short"));
        assert!(!valid_access_token("1234567890abc\ndef"));
        assert!(valid_account_id("account_123-ABC"));
        assert!(!valid_account_id("account/123"));
        assert!(valid_model_slug("sol"));
        assert!(valid_model_slug("gpt-5.1-codex-mini"));
        assert!(!valid_model_slug("model name"));
    }

    #[test]
    fn classifies_only_confirmed_auth_failures_as_unavailable() {
        assert_eq!(availability(200), Some(true));
        assert_eq!(availability(401), Some(false));
        assert_eq!(availability(402), Some(false));
        assert_eq!(availability(403), Some(false));
        assert_eq!(availability(429), None);
        assert_eq!(availability(503), None);
        assert_eq!(availability_with_code(200, ""), Some(true));
        assert_eq!(
            availability_with_code(200, "deactivated_workspace"),
            Some(false)
        );
        assert_eq!(availability_with_code(200, "server_is_overloaded"), None);
    }

    #[test]
    fn extracts_bounded_upstream_error_codes() {
        let payload = json!({ "detail": { "code": "deactivated_workspace" } });
        assert_eq!(upstream_code(&payload), "deactivated_workspace");
        let sse = b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"server_is_overloaded\"}}}\n\n";
        assert_eq!(streamed_error_code(sse), "server_is_overloaded");
    }

    #[test]
    fn selects_requested_models_without_misclassifying_free_accounts() {
        let models = vec![
            json!({ "slug": "gpt-free-model", "visibility": "list" }),
            json!({ "slug": "sol", "visibility": "hide" }),
        ];
        let slugs = visible_model_slugs(&models);
        assert_eq!(slugs, vec!["gpt-free-model"]);
        assert_eq!(select_requested_model(&slugs, "sol"), None);
        assert_eq!(
            select_requested_model(&slugs, "auto").as_deref(),
            Some("gpt-free-model")
        );
        assert_eq!(select_requested_model(&slugs, "not-entitled"), None);
    }
}

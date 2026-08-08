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
}

impl ProbeResult {
    fn local_error(code: &str) -> Self {
        Self {
            status: 400,
            available: Some(false),
            stage: "local",
            code: code.to_string(),
            model: None,
        }
    }

    fn network(code: &str) -> Self {
        Self {
            status: 0,
            available: None,
            stage: "network",
            code: code.to_string(),
            model: None,
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
pub async fn probe_chatgpt_workspace(access_token: String, account_id: String) -> ProbeResult {
    let access_token = access_token.trim().to_string();
    let account_id = account_id.trim().to_string();
    if !valid_access_token(&access_token) {
        return ProbeResult::local_error("invalid_access_token");
    }
    if !account_id.is_empty() && !valid_account_id(&account_id) {
        return ProbeResult::local_error("invalid_account_id");
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
        };
    }

    let models_payload = models_response.json::<Value>().await.unwrap_or(Value::Null);
    let models = models_payload
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let selected = models
        .iter()
        .find(|model| {
            model.get("visibility").and_then(Value::as_str) == Some("list")
                && model.get("slug").and_then(Value::as_str).is_some()
        })
        .or_else(|| {
            models
                .iter()
                .find(|model| model.get("slug").and_then(Value::as_str).is_some())
        });
    let model = selected
        .and_then(|item| item.get("slug"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if model.is_empty() {
        return ProbeResult {
            status: 502,
            available: None,
            stage: "models",
            code: "no_available_model".to_string(),
            model: None,
        };
    }

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
}

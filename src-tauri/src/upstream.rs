use reqwest::header::{ACCEPT, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const GITHUB_API_BASE: &str = "https://api.github.com/repos";

#[derive(Debug, Clone, Copy)]
struct UpstreamSpec {
    id: &'static str,
    label: &'static str,
    repository: &'static str,
    branch: &'static str,
    pinned_sha: &'static str,
}

const UPSTREAMS: [UpstreamSpec; 2] = [
    UpstreamSpec {
        id: "cliproxyapi",
        label: "CLIProxyAPI",
        repository: "router-for-me/CLIProxyAPI",
        branch: "main",
        pinned_sha: "197f520426374e514218ed155933ac546c98d345",
    },
    UpstreamSpec {
        id: "sub2api",
        label: "sub2api",
        repository: "Wei-Shaw/sub2api",
        branch: "main",
        pinned_sha: "cc67b1aca1d3b590609abef2fcd3a6ca31c5c651",
    },
];

#[derive(Debug, Deserialize)]
struct GitHubCommit {
    sha: String,
    html_url: String,
    commit: GitCommitDetails,
}

#[derive(Debug, Deserialize)]
struct GitCommitDetails {
    committer: GitCommitter,
}

#[derive(Debug, Deserialize)]
struct GitCommitter {
    date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub repository: &'static str,
    pub branch: &'static str,
    pub pinned_sha: &'static str,
    pub latest_sha: Option<String>,
    pub latest_date: Option<String>,
    pub latest_url: Option<String>,
    pub status: &'static str,
    pub error: Option<String>,
}

impl UpstreamCheck {
    fn unknown(spec: UpstreamSpec, error: impl Into<String>) -> Self {
        Self {
            id: spec.id,
            label: spec.label,
            repository: spec.repository,
            branch: spec.branch,
            pinned_sha: spec.pinned_sha,
            latest_sha: None,
            latest_date: None,
            latest_url: None,
            status: "unknown",
            error: Some(error.into()),
        }
    }
}

fn from_commit(spec: UpstreamSpec, commit: GitHubCommit) -> UpstreamCheck {
    let status = if commit.sha.eq_ignore_ascii_case(spec.pinned_sha) {
        "current"
    } else {
        "update_available"
    };
    UpstreamCheck {
        id: spec.id,
        label: spec.label,
        repository: spec.repository,
        branch: spec.branch,
        pinned_sha: spec.pinned_sha,
        latest_sha: Some(commit.sha),
        latest_date: Some(commit.commit.committer.date),
        latest_url: Some(commit.html_url),
        status,
        error: None,
    }
}

#[tauri::command]
pub async fn check_upstream_updates() -> Vec<UpstreamCheck> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return UPSTREAMS
                .into_iter()
                .map(|spec| UpstreamCheck::unknown(spec, "client_error"))
                .collect()
        }
    };

    let mut results = Vec::with_capacity(UPSTREAMS.len());
    for spec in UPSTREAMS {
        let url = format!(
            "{GITHUB_API_BASE}/{}/commits/{}",
            spec.repository, spec.branch
        );
        let response = match client
            .get(url)
            .header(ACCEPT, "application/vnd.github+json")
            .header(USER_AGENT, "session-converter-desktop/0.1.3")
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                results.push(UpstreamCheck::unknown(
                    spec,
                    if error.is_timeout() {
                        "timeout"
                    } else {
                        "network_error"
                    },
                ));
                continue;
            }
        };
        let status = response.status();
        if !status.is_success() {
            results.push(UpstreamCheck::unknown(
                spec,
                format!("http_{}", status.as_u16()),
            ));
            continue;
        }
        match response.json::<GitHubCommit>().await {
            Ok(commit)
                if commit.sha.len() == 40 && commit.html_url.starts_with("https://github.com/") =>
            {
                results.push(from_commit(spec, commit));
            }
            _ => results.push(UpstreamCheck::unknown(spec, "invalid_response")),
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_commit(sha: &str) -> GitHubCommit {
        serde_json::from_value(serde_json::json!({
            "sha": sha,
            "html_url": format!("https://github.com/router-for-me/CLIProxyAPI/commit/{sha}"),
            "commit": { "committer": { "date": "2026-08-08T15:25:11Z" } }
        }))
        .expect("valid fixture")
    }

    #[test]
    fn compares_latest_commit_to_the_audited_pin() {
        let spec = UPSTREAMS[0];
        assert_eq!(
            from_commit(spec, sample_commit(spec.pinned_sha)).status,
            "current"
        );
        assert_eq!(
            from_commit(
                spec,
                sample_commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            )
            .status,
            "update_available"
        );
    }

    #[test]
    fn endpoints_are_fixed_public_github_repositories() {
        assert_eq!(UPSTREAMS.len(), 2);
        assert!(UPSTREAMS
            .iter()
            .all(|spec| !spec.repository.contains("://")));
        assert_eq!(GITHUB_API_BASE, "https://api.github.com/repos");
    }
}

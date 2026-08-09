use reqwest::header::{ACCEPT, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

const GITHUB_API_BASE: &str = "https://api.github.com/repos";
const UPSTREAM_AUDIT_JSON: &str = include_str!("../../config/upstream-audit.json");
const ALLOWED_REPOSITORIES: [&str; 2] = ["router-for-me/CLIProxyAPI", "Wei-Shaw/sub2api"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamAudit {
    schema_version: u8,
    upstreams: Vec<UpstreamSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamSpec {
    id: String,
    label: String,
    repository: String,
    branch: String,
    audited_commit: String,
    audited_date: String,
    files: Vec<UpstreamFileSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamFileSpec {
    path: String,
    blob_sha: String,
}

#[derive(Debug, Deserialize)]
struct GitHubCommit {
    sha: String,
    html_url: String,
    commit: GitCommitDetails,
}

#[derive(Debug, Deserialize)]
struct GitCommitDetails {
    committer: GitCommitter,
    tree: GitTreeRef,
}

#[derive(Debug, Deserialize)]
struct GitCommitter {
    date: String,
}

#[derive(Debug, Deserialize)]
struct GitTreeRef {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GitHubTree {
    tree: Vec<GitHubTreeEntry>,
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct GitHubTreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamFileCheck {
    pub path: String,
    pub pinned_blob_sha: String,
    pub latest_blob_sha: Option<String>,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamCheck {
    pub id: String,
    pub label: String,
    pub repository: String,
    pub branch: String,
    pub pinned_sha: String,
    pub audited_date: String,
    pub latest_sha: Option<String>,
    pub latest_date: Option<String>,
    pub latest_url: Option<String>,
    pub status: &'static str,
    pub files: Vec<UpstreamFileCheck>,
    pub error: Option<String>,
}

impl UpstreamCheck {
    fn unknown(spec: &UpstreamSpec, error: impl Into<String>) -> Self {
        Self {
            id: spec.id.clone(),
            label: spec.label.clone(),
            repository: spec.repository.clone(),
            branch: spec.branch.clone(),
            pinned_sha: spec.audited_commit.clone(),
            audited_date: spec.audited_date.clone(),
            latest_sha: None,
            latest_date: None,
            latest_url: None,
            status: "unknown",
            files: spec
                .files
                .iter()
                .map(|file| UpstreamFileCheck {
                    path: file.path.clone(),
                    pinned_blob_sha: file.blob_sha.clone(),
                    latest_blob_sha: None,
                    status: "unknown",
                })
                .collect(),
            error: Some(error.into()),
        }
    }
}

fn is_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn load_upstreams() -> Result<Vec<UpstreamSpec>, String> {
    let audit: UpstreamAudit =
        serde_json::from_str(UPSTREAM_AUDIT_JSON).map_err(|_| "invalid_audit_json".to_string())?;
    if audit.schema_version != 1 || audit.upstreams.len() != ALLOWED_REPOSITORIES.len() {
        return Err("invalid_audit_schema".to_string());
    }
    for spec in &audit.upstreams {
        if !ALLOWED_REPOSITORIES.contains(&spec.repository.as_str())
            || spec.branch != "main"
            || !is_sha(&spec.audited_commit)
            || spec.files.is_empty()
            || spec
                .files
                .iter()
                .any(|file| file.path.is_empty() || !is_sha(&file.blob_sha))
        {
            return Err("invalid_audit_target".to_string());
        }
    }
    Ok(audit.upstreams)
}

fn from_snapshot(spec: &UpstreamSpec, commit: GitHubCommit, tree: GitHubTree) -> UpstreamCheck {
    let blobs: HashMap<String, String> = tree
        .tree
        .into_iter()
        .filter(|entry| entry.kind == "blob" && is_sha(&entry.sha))
        .map(|entry| (entry.path, entry.sha))
        .collect();
    let files: Vec<UpstreamFileCheck> = spec
        .files
        .iter()
        .map(|file| {
            let latest = blobs.get(&file.path).cloned();
            let status = match latest.as_deref() {
                Some(sha) if sha.eq_ignore_ascii_case(&file.blob_sha) => "current",
                Some(_) => "changed",
                None => "missing",
            };
            UpstreamFileCheck {
                path: file.path.clone(),
                pinned_blob_sha: file.blob_sha.clone(),
                latest_blob_sha: latest,
                status,
            }
        })
        .collect();
    let relevant_files_changed = files.iter().any(|file| file.status != "current");
    let status = if relevant_files_changed {
        "update_available"
    } else if commit.sha.eq_ignore_ascii_case(&spec.audited_commit) {
        "current"
    } else {
        "metadata_only"
    };

    UpstreamCheck {
        id: spec.id.clone(),
        label: spec.label.clone(),
        repository: spec.repository.clone(),
        branch: spec.branch.clone(),
        pinned_sha: spec.audited_commit.clone(),
        audited_date: spec.audited_date.clone(),
        latest_sha: Some(commit.sha),
        latest_date: Some(commit.commit.committer.date),
        latest_url: Some(commit.html_url),
        status,
        files,
        error: if tree.truncated {
            Some("truncated_tree".to_string())
        } else {
            None
        },
    }
}

#[tauri::command]
pub async fn check_upstream_updates() -> Vec<UpstreamCheck> {
    let specs = match load_upstreams() {
        Ok(specs) => specs,
        Err(error) => {
            return Vec::from([UpstreamCheck {
                id: "audit".to_string(),
                label: "算法审计配置".to_string(),
                repository: String::new(),
                branch: "main".to_string(),
                pinned_sha: String::new(),
                audited_date: String::new(),
                latest_sha: None,
                latest_date: None,
                latest_url: None,
                status: "unknown",
                files: Vec::new(),
                error: Some(error),
            }])
        }
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return specs
                .iter()
                .map(|spec| UpstreamCheck::unknown(spec, "client_error"))
                .collect()
        }
    };

    let mut results = Vec::with_capacity(specs.len());
    for spec in &specs {
        let commit_url = format!(
            "{GITHUB_API_BASE}/{}/commits/{}",
            spec.repository, spec.branch
        );
        let commit_response = match client
            .get(commit_url)
            .header(ACCEPT, "application/vnd.github+json")
            .header(USER_AGENT, "session-converter-desktop/0.1.5")
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
        if !commit_response.status().is_success() {
            results.push(UpstreamCheck::unknown(
                spec,
                format!("http_{}", commit_response.status().as_u16()),
            ));
            continue;
        }
        let commit = match commit_response.json::<GitHubCommit>().await {
            Ok(commit)
                if is_sha(&commit.sha)
                    && is_sha(&commit.commit.tree.sha)
                    && commit.html_url.starts_with("https://github.com/") =>
            {
                commit
            }
            _ => {
                results.push(UpstreamCheck::unknown(spec, "invalid_commit_response"));
                continue;
            }
        };
        let tree_url = format!(
            "{GITHUB_API_BASE}/{}/git/trees/{}?recursive=1",
            spec.repository, commit.commit.tree.sha
        );
        let tree_response = match client
            .get(tree_url)
            .header(ACCEPT, "application/vnd.github+json")
            .header(USER_AGENT, "session-converter-desktop/0.1.5")
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
        if !tree_response.status().is_success() {
            results.push(UpstreamCheck::unknown(
                spec,
                format!("tree_http_{}", tree_response.status().as_u16()),
            ));
            continue;
        }
        match tree_response.json::<GitHubTree>().await {
            Ok(tree) if !tree.truncated => results.push(from_snapshot(spec, commit, tree)),
            Ok(_) => results.push(UpstreamCheck::unknown(spec, "truncated_tree")),
            Err(_) => results.push(UpstreamCheck::unknown(spec, "invalid_tree_response")),
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
            "commit": {
                "committer": { "date": "2026-08-08T20:36:39Z" },
                "tree": { "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
            }
        }))
        .expect("valid fixture")
    }

    fn sample_tree(spec: &UpstreamSpec, changed_path: Option<&str>) -> GitHubTree {
        GitHubTree {
            truncated: false,
            tree: spec
                .files
                .iter()
                .map(|file| GitHubTreeEntry {
                    path: file.path.clone(),
                    kind: "blob".to_string(),
                    sha: if changed_path == Some(file.path.as_str()) {
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()
                    } else {
                        file.blob_sha.clone()
                    },
                })
                .collect(),
        }
    }

    #[test]
    fn compares_only_relevant_blob_shas_not_repository_head() {
        let spec = &load_upstreams().expect("valid audit")[0];
        let newer = sample_commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(
            from_snapshot(spec, newer, sample_tree(spec, None)).status,
            "metadata_only"
        );
        let changed = sample_commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(
            from_snapshot(spec, changed, sample_tree(spec, Some(&spec.files[0].path))).status,
            "update_available"
        );
    }

    #[test]
    fn audit_targets_are_fixed_public_github_repositories() {
        let specs = load_upstreams().expect("valid audit");
        assert_eq!(specs.len(), 2);
        assert!(specs
            .iter()
            .all(|spec| ALLOWED_REPOSITORIES.contains(&spec.repository.as_str())));
        assert_eq!(GITHUB_API_BASE, "https://api.github.com/repos");
    }
}

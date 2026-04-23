// slack.rs — Slack Web API client using reqwest directly
#![allow(dead_code)]
// auth: SLACK_MCP_XOXP_TOKEN (xoxp user token, Authorization: Bearer)
// Note: the generated slack-client crate (from OpenAPI) has overly strict
// deny_unknown_fields on nested types that break on real Slack responses.

use anyhow::{bail, Result};
use reqwest::Client;
use serde_json::Value;

fn client() -> Client {
    Client::new()
}

fn base() -> String {
    std::env::var("SLACK_API_BASE")
        .unwrap_or_else(|_| "https://slack.com/api".to_string())
        .trim_end_matches('/')
        .to_string()
}

async fn get(token: &str, method: &str, params: &[(&str, &str)]) -> Result<Value> {
    let resp = client()
        .get(format!("{}/{method}", base()))
        .bearer_auth(token)
        .query(params)
        .send()
        .await?
        .json::<Value>()
        .await?;
    if resp["ok"].as_bool() != Some(true) {
        bail!("Slack error on {method}: {}", resp["error"].as_str().unwrap_or("unknown"));
    }
    Ok(resp)
}

async fn post(token: &str, method: &str, body: Value) -> Result<Value> {
    let resp = client()
        .post(format!("{}/{method}", base()))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?
        .json::<Value>()
        .await?;
    if resp["ok"].as_bool() != Some(true) {
        bail!("Slack error on {method}: {}", resp["error"].as_str().unwrap_or("unknown"));
    }
    Ok(resp)
}

/// Fetch recent messages from a channel
pub async fn history(token: &str, channel_id: &str, limit: i64) -> Result<Value> {
    get(token, "conversations.history", &[
        ("channel", channel_id),
        ("limit", &limit.to_string()),
    ]).await
}

/// Search messages across workspace (single page, up to `count` results, 1-100)
pub async fn search(token: &str, query: &str) -> Result<Value> {
    search_page(token, query, 100, 1).await
}

/// Search messages — single page with explicit count (1-100) and page (1-based)
pub async fn search_page(token: &str, query: &str, count: i64, page: i64) -> Result<Value> {
    let count_s = count.clamp(1, 100).to_string();
    let page_s = page.max(1).to_string();
    get(token, "search.messages", &[
        ("query", query),
        ("sort", "timestamp"),
        ("sort_dir", "desc"),
        ("count", &count_s),
        ("page", &page_s),
    ]).await
}

/// Search messages — paginates until `max` results are collected or no more pages.
/// Returns merged matches array under `messages.matches`.
pub async fn search_all(token: &str, query: &str, max: i64) -> Result<Value> {
    let per_page: i64 = 100;
    let mut page: i64 = 1;
    let mut all_matches: Vec<Value> = Vec::new();
    let mut last_resp: Value = serde_json::json!({"ok": true, "messages": {}});
    loop {
        let resp = search_page(token, query, per_page, page).await?;
        let matches = resp["messages"]["matches"].as_array().cloned().unwrap_or_default();
        let got = matches.len() as i64;
        all_matches.extend(matches);
        let pages = resp["messages"]["paging"]["pages"].as_i64().unwrap_or(1);
        last_resp = resp;
        if got == 0 || page >= pages || (all_matches.len() as i64) >= max {
            break;
        }
        page += 1;
    }
    all_matches.truncate(max as usize);
    let mut out = last_resp;
    out["messages"]["matches"] = Value::Array(all_matches);
    Ok(out)
}

/// Send a message to a channel or DM, rendered as a markdown block
pub async fn send(token: &str, channel: &str, text: &str, thread_ts: Option<&str>) -> Result<String> {
    let mut body = serde_json::json!({
        "channel": channel,
        "text": text,  // fallback for notifications
        "blocks": [{ "type": "markdown", "text": text }]
    });
    if let Some(ts) = thread_ts {
        body["thread_ts"] = Value::String(ts.to_string());
    }
    let resp = post(token, "chat.postMessage", body).await?;
    Ok(resp["ts"].as_str().unwrap_or("").to_string())
}

/// List conversations (channels + DMs)
pub async fn list_conversations(token: &str) -> Result<Value> {
    get(token, "conversations.list", &[
        ("limit", "200"),
        ("types", "public_channel,private_channel,im,mpim"),
    ]).await
}

/// Open a DM channel with a user by user ID
pub async fn open_dm(token: &str, user_id: &str) -> anyhow::Result<String> {
    let resp = post(token, "conversations.open", serde_json::json!({ "users": user_id })).await?;
    resp["channel"]["id"].as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow::anyhow!("Failed to open DM with user {user_id}"))
}

/// Normalize a name for loose matching: lowercase + strip hyphens/underscores/whitespace.
/// Lets `@deploy-bot` match a Slack handle like `deploybot` or display name `Deploy-Bot`.
fn norm_name(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| !matches!(c, '-' | '_' | ' ' | '\t')).collect()
}

/// Extract channel ID from a Slack permalink (e.g. `https://app.slack.com/client/TXXXXXXX/CXXXXXXXX`)
fn parse_slack_url(s: &str) -> Option<String> {
    let re_prefix = "app.slack.com/client/T";
    let pos = s.find(re_prefix)?;
    let rest = &s[pos + re_prefix.len()..];
    // Skip over the team ID (alphanumeric)
    let team_end = rest.find('/')?;
    let after_team = &rest[team_end + 1..];
    // Take the channel/user ID (stops at next `/`, `?`, or end)
    let id_end = after_team
        .find(|c: char| !c.is_ascii_alphanumeric())
        .unwrap_or(after_team.len());
    let id = &after_team[..id_end];
    if id.is_empty() { None } else { Some(id.to_string()) }
}

/// Resolve @user or #channel name (or Slack URL) to a channel/DM ID.
/// For @user, performs normalized matching against name, real_name, and display_name.
pub async fn resolve_channel(token: &str, ref_str: &str) -> anyhow::Result<String> {
    // Accept Slack permalinks directly
    if let Some(id) = parse_slack_url(ref_str) {
        return Ok(id);
    }
    // Accept raw IDs (C..., D..., G...)
    if !ref_str.starts_with('@') && !ref_str.starts_with('#') {
        if ref_str.chars().all(|c| c.is_ascii_alphanumeric()) && ref_str.len() >= 9 {
            return Ok(ref_str.to_string());
        }
        anyhow::bail!("Target must start with # or @ (or be a Slack URL/ID), got: {ref_str}");
    }
    let is_im = ref_str.starts_with('@');
    let raw_name = &ref_str[1..];
    let name_norm = norm_name(raw_name);

    if is_im {
        // First find user ID via users.list (batch), then locate the IM channel.
        let mut user_id = String::new();
        let mut user_cursor = String::new();
        'outer: loop {
            let mut params = vec![("limit", "200")];
            if !user_cursor.is_empty() { params.push(("cursor", &user_cursor)); }
            let resp = get(token, "users.list", &params).await?;
            let members = resp["members"].as_array().cloned().unwrap_or_default();
            for u in &members {
                let n = u["name"].as_str().unwrap_or("");
                let rn = u["real_name"].as_str().unwrap_or("");
                let dn = u["profile"]["display_name"].as_str().unwrap_or("");
                if norm_name(n) == name_norm
                    || norm_name(rn) == name_norm
                    || (!dn.is_empty() && norm_name(dn) == name_norm)
                {
                    user_id = u["id"].as_str().unwrap_or("").to_string();
                    break 'outer;
                }
            }
            let next = resp["response_metadata"]["next_cursor"].as_str().unwrap_or("");
            if next.is_empty() { break; }
            user_cursor = next.to_string();
        }
        if user_id.is_empty() {
            anyhow::bail!("User not found: {ref_str}");
        }
        // Find an existing DM channel with this user (avoids needing im:write scope).
        let mut dm_cursor = String::new();
        loop {
            let mut params = vec![("types", "im"), ("limit", "200")];
            if !dm_cursor.is_empty() { params.push(("cursor", &dm_cursor)); }
            let resp = get(token, "conversations.list", &params).await?;
            for ch in resp["channels"].as_array().cloned().unwrap_or_default() {
                if ch["user"].as_str() == Some(&user_id) {
                    return Ok(ch["id"].as_str().unwrap_or("").to_string());
                }
            }
            let next = resp["response_metadata"]["next_cursor"].as_str().unwrap_or("");
            if next.is_empty() { break; }
            dm_cursor = next.to_string();
        }
        anyhow::bail!("No existing DM with {ref_str} ({user_id}). Open it once in Slack first.");
    }

    // Channel lookup
    let types = "public_channel,private_channel";
    let mut cursor = String::new();
    loop {
        let mut params = vec![("limit", "200"), ("types", types), ("exclude_archived", "true")];
        if !cursor.is_empty() { params.push(("cursor", &cursor)); }
        let resp = get(token, "conversations.list", &params).await?;
        let channels = resp["channels"].as_array().cloned().unwrap_or_default();
        for ch in &channels {
            let ch_name = ch["name"].as_str().unwrap_or("").to_lowercase();
            if ch_name == raw_name.to_lowercase() {
                return Ok(ch["id"].as_str().unwrap_or("").to_string());
            }
        }
        // Check for next page
        let next = resp["response_metadata"]["next_cursor"].as_str().unwrap_or("");
        if next.is_empty() { break; }
        cursor = next.to_string();
    }
    anyhow::bail!("{} not found: {ref_str}", if is_im { "DM" } else { "channel" })
}

/// Replace <@UXXXXXXX> mention tokens in text with display names
pub async fn resolve_mentions(token: &str, text: &str, cache: &mut std::collections::HashMap<String, String>) -> String {
    let mut result = text.to_string();
    // find all <@UXXXXXXX> or <@UXXXXXXX|label> patterns
    let re_pat = "<@U";
    let mut search = result.as_str();
    let mut ids = vec![];
    while let Some(pos) = search.find(re_pat) {
        let rest = &search[pos + 2..]; // skip "<@"
        let end = rest.find(|c| c == '>' || c == '|').unwrap_or(rest.len());
        let uid = &rest[..end];
        if uid.len() >= 9 { ids.push(uid.to_string()); }
        search = &search[pos + 1..];
    }
    for uid in ids {
        if !cache.contains_key(&uid) {
            cache.insert(uid.clone(), user_name(token, &uid).await);
        }
        let display = cache[&uid].clone();
        // replace <@UID> and <@UID|label> forms
        result = result.replace(&format!("<@{uid}>"), &format!("@{display}"));
        result = result.replace(&format!("<@{uid}|"), &format!("@{display}|")); // handle label form too
        // clean up trailing |label> if present
        while let Some(p) = result.find(&format!("@{display}|")) {
            let after = p + format!("@{display}|").len();
            if let Some(close) = result[after..].find('>') {
                result = format!("{}{}{}", &result[..p], &format!("@{display}"), &result[after + close + 1..]);
            } else { break; }
        }
    }
    result
}

// Resolve Slack date markup: <!date^EPOCH^{format}|fallback> → fallback or formatted date
pub fn resolve_date_markup(text: &str) -> String {
    let mut result = text.to_string();
    while let Some(start) = result.find("<!date^") {
        let Some(end) = result[start..].find('>') else { break };
        let tag = &result[start..start + end + 1];
        // parse: <!date^EPOCH^{format}|fallback>
        let inner = &tag[7..tag.len() - 1]; // strip <!date^ and >
        let parts: Vec<&str> = inner.splitn(3, |c| c == '^' || c == '|').collect();
        let replacement = if let Some(epoch_str) = parts.first() {
            if let Ok(epoch) = epoch_str.parse::<i64>() {
                if let Some(dt) = chrono::DateTime::from_timestamp(epoch, 0) {
                    dt.format("%A, %b %d, %Y").to_string()
                } else {
                    parts.last().unwrap_or(&"date").to_string()
                }
            } else {
                parts.last().unwrap_or(&"date").to_string()
            }
        } else {
            "date".to_string()
        };
        result = format!("{}{}{}", &result[..start], replacement, &result[start + end + 1..]);
    }
    result
}

/// Look up both the canonical display label and the `@handle` for a user.
/// Returns `(real_name or display_name, name)` — first is what's shown in Slack,
/// second is the @-mention handle.
pub async fn user_info_pair(token: &str, user_id: &str) -> (String, String) {
    let Ok(resp) = get(token, "users.info", &[("user", user_id)]).await else {
        return (user_id.to_string(), user_id.to_string());
    };
    let display = resp["user"]["profile"]["display_name"].as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| resp["user"]["real_name"].as_str())
        .unwrap_or(user_id)
        .to_string();
    let handle = resp["user"]["name"].as_str().unwrap_or(user_id).to_string();
    (display, handle)
}

/// Look up a user's display name by ID
pub async fn user_name(token: &str, user_id: &str) -> String {
    let Ok(resp) = get(token, "users.info", &[("user", user_id)]).await else {
        return user_id.to_string();
    };
    resp["user"]["profile"]["display_name"].as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| resp["user"]["real_name"].as_str())
        .or_else(|| resp["user"]["name"].as_str())
        .unwrap_or(user_id)
        .to_string()
}

/// Get channel/DM metadata (type, name, is_im, is_mpim, user)
pub async fn channel_info(token: &str, channel_id: &str) -> Result<Value> {
    get(token, "conversations.info", &[("channel", channel_id)]).await
}

/// Get replies in a thread
pub async fn replies(token: &str, channel_id: &str, thread_ts: &str, limit: i64) -> Result<Value> {
    get(token, "conversations.replies", &[
        ("channel", channel_id),
        ("ts", thread_ts),
        ("limit", &limit.to_string()),
    ]).await
}

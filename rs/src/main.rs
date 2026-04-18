mod slack;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::collections::HashMap;
use std::fmt::Write as _;

fn is_interactive() -> bool {
    // Returns true only if stderr is a real terminal (not piped/captured)
    unsafe { libc::isatty(libc::STDERR_FILENO) == 1 }
}

/// Format a message with timestamp, display_name, and resolved mention text.
/// Produces: `[YYYY-MM-DD HH:MM:SS] <real_name|@username> text`
async fn format_message(
    token: &str,
    m: &serde_json::Value,
    user_cache: &mut HashMap<String, String>,
) -> String {
    let ts_f = m["ts"].as_str().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
    let dt = chrono::DateTime::from_timestamp(ts_f as i64, 0).unwrap_or_default();
    let time = dt.format("%Y-%m-%d %H:%M:%S").to_string();
    let (real, uname) = if let Some(uid) = m["user"].as_str() {
        let key_real = uid.to_string();
        let key_handle = format!("@{uid}");
        if !user_cache.contains_key(&key_real) || !user_cache.contains_key(&key_handle) {
            let (d, h) = slack::user_info_pair(token, uid).await;
            user_cache.insert(key_real.clone(), d);
            user_cache.insert(key_handle.clone(), h);
        }
        (user_cache[&key_real].clone(), user_cache[&key_handle].clone())
    } else if let Some(bot) = m["username"].as_str() {
        (bot.to_string(), bot.to_string())
    } else {
        ("?".to_string(), "?".to_string())
    };
    let raw_text = m["text"].as_str().unwrap_or("");
    let text = slack::resolve_mentions(token, raw_text, user_cache).await;
    let text = slack::resolve_date_markup(&text);
    let oneline: String = text.lines().collect::<Vec<_>>().join(" ↵ ");
    format!("[{time}] <{real}|@{uname}> {oneline}")
}

fn sha256_hex(input: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, input.as_bytes());
    let mut s = String::with_capacity(64);
    for b in digest.as_ref() { write!(s, "{b:02x}").unwrap(); }
    s
}

#[derive(Parser)]
#[command(name = "slack", about = "Slack CLI")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Show recent messages. With no target: top joined channels overview.
    /// With a target (#channel, @user, Slack URL, or raw ID): channel/DM history with timestamps.
    Msgs {
        /// Optional target: #channel-name, @username, Slack permalink, or raw channel/DM ID
        target: Option<String>,
        /// Number of messages to fetch when target is given
        #[arg(short = 'n', long, default_value = "20")]
        limit: i64,
    },
    /// Show replies in a thread
    Thread {
        /// Target: #channel-name, @username, Slack permalink, or raw channel ID
        target: String,
        /// Thread root timestamp (e.g. 1767850498.239129)
        ts: String,
        /// Max replies to fetch
        #[arg(short = 'n', long, default_value = "100")]
        limit: i64,
    },
    /// Show activity feed (mentions, @channel, @here) like Slack's Activity tab
    News {
        /// Max items to show
        #[arg(short, long, default_value = "20")]
        limit: usize,
    },
    /// Search messages across workspace
    Search {
        query: String,
        /// Max total results to return (paginates through pages of 100)
        #[arg(short = 'n', long, default_value = "100")]
        count: i64,
    },
    /// Send a message to a channel or DM (requires --confirm hash)
    ///
    /// Target must be #channel-name or @username (human-readable).
    /// Use --channel-id or --user-id only when disambiguation is needed.
    Send {
        /// Target: #channel-name or @username
        target: String,
        message: String,
        #[arg(long)] thread: Option<String>,
        #[arg(long)] confirm: Option<String>,
        /// Override with a raw channel ID (e.g. C0123456789)
        #[arg(long)] channel_id: Option<String>,
        /// Override with a raw user ID (e.g. U0123456789) — opens/resolves DM
        #[arg(long)] user_id: Option<String>,
    },
    /// Dump recent messages from all joined channels (markdown format)
    Dump {
        /// Number of days to look back
        #[arg(short, long, default_value = "7")]
        days: u64,
        /// Max messages per channel
        #[arg(short, long, default_value = "200")]
        limit: usize,
        /// Only include channels matching this substring (case-insensitive)
        #[arg(short, long)]
        filter: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load env: XDG config first, then local .env
    if let Some(home) = std::env::var_os("HOME") {
        dotenvy::from_filename(std::path::Path::new(&home).join(".config/slack-cli/.env.local")).ok();
    }
    dotenvy::dotenv().ok();

    let token = std::env::var("SLACK_MCP_XOXP_TOKEN")?;
    let cli = Cli::parse();

    match cli.cmd {
        Cmd::Msgs { target: Some(tgt), limit } => {
            let channel_id = slack::resolve_channel(&token, &tgt).await?;
            let mut user_cache: HashMap<String, String> = HashMap::new();
            let hist = slack::history(&token, &channel_id, limit).await?;
            let messages = hist["messages"].as_array().cloned().unwrap_or_default();
            for m in messages.iter().rev() {
                let line = format_message(&token, m, &mut user_cache).await;
                println!("{line}");
            }
        }
        Cmd::Thread { target, ts, limit } => {
            let channel_id = slack::resolve_channel(&token, &target).await?;
            let mut user_cache: HashMap<String, String> = HashMap::new();
            let resp = slack::replies(&token, &channel_id, &ts, limit).await?;
            let messages = resp["messages"].as_array().cloned().unwrap_or_default();
            for m in &messages {
                let line = format_message(&token, m, &mut user_cache).await;
                println!("{line}");
            }
        }
        Cmd::Msgs { target: None, .. } => {
            let resp = slack::list_conversations(&token).await?;
            let mut channels = resp["channels"].as_array().cloned().unwrap_or_default();
            channels.sort_by(|a, b| {
                let ta = a["updated"].as_f64().unwrap_or(0.0);
                let tb = b["updated"].as_f64().unwrap_or(0.0);
                tb.partial_cmp(&ta).unwrap()
            });
            let mut user_cache: HashMap<String, String> = HashMap::new();
            let member_channels: Vec<_> = channels.iter()
                .filter(|c| c["is_member"].as_bool() == Some(true))
                .take(10)
                .collect();
            for ch in member_channels {
                let id = ch["id"].as_str().unwrap_or("");
                let name = ch["name"].as_str()
                    .or_else(|| ch["user"].as_str())
                    .unwrap_or(id);
                let msgs = slack::history(&token, id, 5).await?;
                let messages: Vec<_> = msgs["messages"].as_array()
                    .cloned().unwrap_or_default()
                    .into_iter()
                    .filter(|m| m["subtype"].is_null())
                    .filter(|m| {
                        let text = m["text"].as_str().unwrap_or("");
                        !text.is_empty() && !text.starts_with("<@")
                    })
                    .take(3)
                    .collect();
                if messages.is_empty() { continue; }
                println!("── #{name} ─────────────────────────────────");
                for m in &messages {
                    let display_name = if let Some(uid) = m["user"].as_str() {
                        if !user_cache.contains_key(uid) {
                            let name = slack::user_name(&token, uid).await;
                            user_cache.insert(uid.to_string(), name);
                        }
                        user_cache[uid].clone()
                    } else {
                        m["username"].as_str().unwrap_or("bot").to_string()
                    };
                    let raw_text = m["text"].as_str().unwrap_or("").lines().next().unwrap_or("");
                    let text = slack::resolve_mentions(&token, raw_text, &mut user_cache).await;
                    println!("  {display_name}: {text}");
                }
            }
        }
        Cmd::News { limit } => {
            let resp = slack::search(&token, "to:me").await?;
            let matches = resp["messages"]["matches"].as_array().cloned().unwrap_or_default();
            let mut user_cache: HashMap<String, String> = HashMap::new();
            let mut last_day = String::new();
            for m in matches.iter().take(limit) {
                let ts = m["ts"].as_str().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
                let dt = chrono::DateTime::from_timestamp(ts as i64, 0)
                    .unwrap_or_default();
                let now = chrono::Utc::now();
                let today = now.date_naive();
                let msg_day = dt.date_naive();
                let day_label = if msg_day == today {
                    "Today".to_string()
                } else if msg_day == today.pred_opt().unwrap_or(today) {
                    "Yesterday".to_string()
                } else {
                    msg_day.format("%A, %b %d").to_string()
                };
                if day_label != last_day {
                    if !last_day.is_empty() { println!(); }
                    println!("  {day_label}");
                    println!("  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄");
                    last_day = day_label;
                }
                let is_im = m["channel"]["is_im"].as_bool() == Some(true);
                let ch_name_raw = m["channel"]["name"].as_str().unwrap_or("dm");
                // For DMs, resolve UID to @display_name; for channels, use #channel-name
                let ch_label = if is_im && ch_name_raw.starts_with('U') {
                    if !user_cache.contains_key(ch_name_raw) {
                        user_cache.insert(ch_name_raw.to_string(), slack::user_name(&token, ch_name_raw).await);
                    }
                    format!("@{}", user_cache[ch_name_raw])
                } else if is_im {
                    format!("@{ch_name_raw}")
                } else {
                    format!("#{ch_name_raw}")
                };
                let username = m["username"].as_str().unwrap_or("?");
                let display = if let Some(uid) = m["user"].as_str() {
                    if !user_cache.contains_key(uid) {
                        user_cache.insert(uid.to_string(), slack::user_name(&token, uid).await);
                    }
                    user_cache[uid].clone()
                } else {
                    username.to_string()
                };
                let raw_text = m["text"].as_str().unwrap_or("");
                let text = slack::resolve_mentions(&token, raw_text, &mut user_cache).await;
                let text = slack::resolve_date_markup(&text);
                let first_line: String = text.lines().next().unwrap_or("").chars().take(80).collect();
                let time = dt.format("%H:%M").to_string();
                let icon = if is_im { "💬" } else { "🔔" };
                println!("  {icon} {ch_label}  {time}");
                println!("     {display}: {first_line}");
            }
        }
        Cmd::Search { query, count } => {
            let resp = slack::search_all(&token, &query, count).await?;
            println!("{}", serde_json::to_string_pretty(&resp)?);
        }
        Cmd::Dump { days, limit, filter } => {
            let cutoff = chrono::Utc::now().timestamp() - (days as i64 * 86400);
            let resp = slack::list_conversations(&token).await?;
            let channels = resp["channels"].as_array().cloned().unwrap_or_default();
            let mut member_channels: Vec<_> = channels.into_iter()
                .filter(|c| c["is_member"].as_bool() == Some(true))
                .filter(|c| {
                    c["is_im"].as_bool() != Some(true) && c["is_mpim"].as_bool() != Some(true)
                })
                .filter(|c| {
                    if let Some(ref f) = filter {
                        c["name"].as_str().unwrap_or("").to_lowercase().contains(&f.to_lowercase())
                    } else {
                        true
                    }
                })
                .collect();
            member_channels.sort_by(|a, b| {
                let ta = a["updated"].as_f64().unwrap_or(0.0);
                let tb = b["updated"].as_f64().unwrap_or(0.0);
                tb.partial_cmp(&ta).unwrap()
            });

            let mut user_cache: HashMap<String, String> = HashMap::new();
            let mut total_msgs = 0usize;
            let mut active_channels = 0usize;

            for ch in &member_channels {
                let id = ch["id"].as_str().unwrap_or("");
                let name = ch["name"].as_str().unwrap_or(id);

                let hist = match slack::history(&token, id, limit as i64).await {
                    Ok(h) => h,
                    Err(e) => {
                        eprintln!("  SKIP #{name}: {e}");
                        continue;
                    }
                };
                let messages: Vec<_> = hist["messages"].as_array()
                    .cloned().unwrap_or_default()
                    .into_iter()
                    .filter(|m| m["subtype"].is_null())
                    .filter(|m| {
                        let ts = m["ts"].as_str().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
                        ts as i64 >= cutoff
                    })
                    .collect();
                if messages.is_empty() { continue; }

                active_channels += 1;
                total_msgs += messages.len();
                println!("## #{name} ({} msgs)\n", messages.len());

                for m in messages.iter().rev() {
                    let ts = m["ts"].as_str().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
                    let dt = chrono::DateTime::from_timestamp(ts as i64, 0).unwrap_or_default();
                    let time = dt.format("%Y-%m-%d %H:%M").to_string();
                    let display = if let Some(uid) = m["user"].as_str() {
                        if !user_cache.contains_key(uid) {
                            let uname = slack::user_name(&token, uid).await;
                            user_cache.insert(uid.to_string(), uname);
                        }
                        user_cache[uid].clone()
                    } else {
                        m["username"].as_str().unwrap_or("bot").to_string()
                    };
                    let raw_text = m["text"].as_str().unwrap_or("");
                    let text = slack::resolve_mentions(&token, raw_text, &mut user_cache).await;
                    let text = slack::resolve_date_markup(&text);
                    let oneline: String = text.lines().collect::<Vec<_>>().join(" ↵ ");
                    println!("[{time}] {display}: {oneline}");
                }
                println!();
            }
            eprintln!("Dumped {total_msgs} messages across {active_channels} channels (cutoff: {days}d)");
        }
        Cmd::Send { target, message, thread, confirm, channel_id, user_id } => {
            let resolved_id = if let Some(cid) = channel_id {
                cid
            } else if let Some(uid) = user_id {
                let resp = slack::open_dm(&token, &uid).await?;
                resp
            } else if target.starts_with('#') || target.starts_with('@') {
                slack::resolve_channel(&token, &target).await?
            } else {
                eprintln!("Error: target must be #channel-name or @username (got: {target})");
                eprintln!("Use --channel-id=<ID> or --user-id=<ID> to send by raw ID.");
                std::process::exit(1);
            };
            let channel = target;
            let channel_id = resolved_id;
            let ctx = slack::history(&token, &channel_id, 5).await?;
            // Hash only stable fields (ts + text) — Slack randomizes block_id on each API call
            let ctx_stable: String = ctx["messages"].as_array()
                .cloned().unwrap_or_default()
                .iter()
                .filter(|m| m["subtype"].is_null())
                .take(5)
                .map(|m| format!("{}:{}", m["ts"].as_str().unwrap_or(""), m["text"].as_str().unwrap_or("")))
                .collect::<Vec<_>>()
                .join("\n");
            let hash = {
                let mut hasher_input = ctx_stable.clone();
                hasher_input.push_str(&message);
                let digest = sha256_hex(&hasher_input);
                digest[..4].to_string()
            };
            match confirm.as_deref() {
                None => {
                    // Show preview (context + message) regardless of interactive mode
                    let messages = ctx["messages"].as_array().cloned().unwrap_or_default();
                    if is_interactive() {
                        println!("─── Recent context ──────────────────────────");
                        for m in messages.iter().filter(|m| m["subtype"].is_null()).take(5) {
                            let user = m["user"].as_str().unwrap_or("?");
                            let text = m["text"].as_str().unwrap_or("").lines().next().unwrap_or("");
                            println!("  {user}: {text}");
                        }
                        println!("─── Message preview ─────────────────────────");
                        println!("  To:      {channel}{}", thread.as_deref().map(|t| format!(" (thread {t})")).unwrap_or_default());
                        println!("  Message: {message}");
                        println!("─────────────────────────────────────────────");
                    }
                    // Always print the hash so scripts can capture and rerun
                    eprintln!("Rerun with --confirm={hash}");
                    std::process::exit(1);
                }
                Some(c) if c != hash => {
                    eprintln!("Confirm hash mismatch. Expected: {hash}");
                    std::process::exit(1);
                }
                _ => {
                    let ts = slack::send(&token, &channel_id, &message, thread.as_deref()).await?;
                    println!("✓ Sent (ts: {})", ts);
                }
            }
        }
    }

    Ok(())
}

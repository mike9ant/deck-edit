//! Only the app itself may use the server.
//!
//! The server listens on 127.0.0.1, but any web page open in a browser on this
//! Mac could still send it requests. This layer, in front of everything,
//! refuses two kinds:
//!
//! - a `Host` that isn't loopback — a foreign domain made to resolve to
//!   127.0.0.1 (DNS rebinding), whose page the browser would otherwise treat
//!   as the server's own;
//! - an `Origin` that isn't a loopback page — another web site's script.
//!   Browsers set `Origin` themselves (pages can't forge it) on cross-site
//!   requests and on every POST/PUT/PATCH/DELETE.
//!
//! The app's own pages pass: the browser version and the desktop window both
//! load from `http://127.0.0.1:{port}`, the Vite dev server from
//! `localhost:5173`. Non-browser callers — the Claude CLI's hook and MCP
//! requests, `curl` — send no `Origin` and pass too.
//!
//! There is deliberately no CORS layer: the frontend is served from the same
//! address as the API, so no other origin needs to read its answers.

use axum::extract::Request;
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

/// Whether `host[:port]` names this machine's loopback interface.
pub fn is_loopback(authority: &str) -> bool {
    // "[::1]:3101" → "[::1]"; "[::1]" stays whole (its colons are not a port separator).
    let name = match authority.rsplit_once(':') {
        Some((h, port)) if !port.ends_with(']') => h,
        _ => authority,
    };
    matches!(name.to_ascii_lowercase().as_str(), "127.0.0.1" | "localhost" | "[::1]")
}

/// Why a request with this host and origin is refused, or None to let it through.
pub fn refusal(host: Option<&str>, origin: Option<&str>) -> Option<&'static str> {
    match host {
        Some(host) if is_loopback(host) => {}
        _ => return Some("this server only answers on 127.0.0.1 / localhost"),
    }
    match origin {
        None => None,
        Some(origin) if origin.strip_prefix("http://").is_some_and(is_loopback) => None,
        Some(_) => Some("requests from other web pages are not allowed"),
    }
}

pub async fn guard(req: Request, next: Next) -> Response {
    let value = |h: &HeaderMap, name| h.get(name).map(|v| v.to_str().unwrap_or("").to_owned());
    // HTTP/2 carries the host in the URI rather than a Host header.
    let host = value(req.headers(), header::HOST).or_else(|| req.uri().authority().map(|a| a.to_string()));
    let origin = value(req.headers(), header::ORIGIN);
    if let Some(why) = refusal(host.as_deref(), origin.as_deref()) {
        tracing::warn!("refused {} {} (host {host:?}, origin {origin:?}): {why}", req.method(), req.uri().path());
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": why }))).into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    const OK: Option<&str> = None;

    #[test]
    fn the_apps_own_pages_and_local_tools_pass() {
        assert_eq!(refusal(Some("127.0.0.1:3101"), Some("http://127.0.0.1:3101")), OK); // browser version, desktop window
        assert_eq!(refusal(Some("127.0.0.1:3101"), Some("http://localhost:5173")), OK); // Vite dev server's proxy
        assert_eq!(refusal(Some("localhost:3101"), None), OK); // same-origin GET, Claude CLI, curl
        assert_eq!(refusal(Some("[::1]:3101"), Some("http://[::1]:3101")), OK);
    }

    #[test]
    fn other_sites_and_rebound_names_are_refused() {
        assert!(refusal(Some("127.0.0.1:3101"), Some("https://evil.example")).is_some());
        assert!(refusal(Some("127.0.0.1:3101"), Some("null")).is_some()); // sandboxed iframe, file:// page
        assert!(refusal(Some("127.0.0.1:3101"), Some("http://localhost.evil.example")).is_some());
        assert!(refusal(Some("127.0.0.1:3101"), Some("https://127.0.0.1:3101")).is_some()); // not how the app is served
        assert!(refusal(Some("evil.example:3101"), Some("http://evil.example:3101")).is_some()); // DNS rebinding
        assert!(refusal(Some("evil.example:3101"), None).is_some());
        assert!(refusal(None, None).is_some());
    }

    #[test]
    fn loopback_names() {
        assert!(is_loopback("127.0.0.1") && is_loopback("LOCALHOST:80") && is_loopback("[::1]"));
        assert!(!is_loopback("127.0.0.2") && !is_loopback("example.com:3101") && !is_loopback("0.0.0.0:3101"));
    }
}

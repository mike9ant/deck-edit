//! The Deck Edit server (`./run.sh`): serves the app on http://127.0.0.1:3101
//! (`--port` / `DECKEDIT_PORT`). The desktop app runs the same server in-process.

use deck_edit::{default_data_dir, init_logging, repo_frontend_dist, run_server, ServerConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_logging(None);
    let port: u16 = std::env::args()
        .skip_while(|a| a != "--port")
        .nth(1)
        .and_then(|p| p.parse().ok())
        .or_else(|| std::env::var("DECKEDIT_PORT").ok().and_then(|p| p.parse().ok()))
        .unwrap_or(3101);
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))?;
    let config = ServerConfig { data_dir: default_data_dir(), frontend_dist: repo_frontend_dist(), provision_python: false };
    run_server(listener, config, None).await
}

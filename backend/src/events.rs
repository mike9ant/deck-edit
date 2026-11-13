//! `GET /api/events` — one Server-Sent-Events stream per browser carrying every
//! push: file changes, tree changes, chat stream events, turn status, notes,
//! permission prompts and screenshot requests. Each SSE `data:` is one JSON
//! object with a `type` field.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::Router;
use futures::Stream;
use tokio::sync::broadcast::error::RecvError;

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/events", get(events))
}

async fn events(State(state): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.events.subscribe();
    let stream = async_stream::stream! {
        yield Ok(Event::default().data(r#"{"type":"hello"}"#));
        loop {
            match rx.recv().await {
                Ok(v) => yield Ok(Event::default().data(v.to_string())),
                // A slow client missed events: tell it to resync everything.
                Err(RecvError::Lagged(_)) => yield Ok(Event::default().data(r#"{"type":"resync"}"#)),
                Err(RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

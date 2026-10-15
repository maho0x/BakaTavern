//! End-to-end tests of the HTTP API against a real (temporary) data directory.

use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use bt_server::{AppState, Config, router};
use futures_util::StreamExt;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

struct TestApp {
    app: axum::Router,
    _dir: tempfile::TempDir,
}

fn test_app() -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        data_dir: dir.path().to_path_buf(),
        ..Config::default()
    };
    let state = AppState::new(config).unwrap();
    TestApp {
        app: router(state),
        _dir: dir,
    }
}

impl TestApp {
    async fn send(&self, req: Request<Body>) -> Response {
        self.app.clone().oneshot(req).await.unwrap()
    }

    async fn json(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("x-bt-client", "1");
        let body = match body {
            Some(b) => {
                req = req.header(header::CONTENT_TYPE, "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let res = self.send(req.body(body).unwrap()).await;
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap_or(Value::Null)
            },
        )
    }

    async fn upload(
        &self,
        uri: &str,
        file_name: &str,
        bytes: &[u8],
        fields: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let boundary = "BTBOUNDARY";
        let mut body = Vec::new();
        for (name, value) in fields {
            body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").bytes());
        }
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            )
            .bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend(format!("\r\n--{boundary}--\r\n").bytes());
        let req = Request::post(uri)
            .header("x-bt-client", "1")
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .unwrap();
        let res = self.send(req).await;
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

fn card_png(name: &str) -> Vec<u8> {
    let card = bt_formats::card::normalize(json!({
        "spec": "chara_card_v2", "spec_version": "2.0",
        "data": {"name": name, "description": "desc", "first_mes": "Hello {{user}}", "tags": ["fantasy", "elf"],
                 "alternate_greetings": ["Hi again"], "extensions": {"talkativeness": "0.5"}}
    }))
    .unwrap();
    bt_formats::card::write_png(&bt_formats::png::placeholder(), &card).unwrap()
}

#[tokio::test]
async fn csrf_header_is_required_for_writes() {
    let t = test_app();
    let res = t
        .send(
            Request::post("/api/tags")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"name":"x"}"#))
                .unwrap(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let (status, body) = t.json("GET", "/api/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn character_import_chat_and_export_round_trip() {
    let t = test_app();
    let (status, imported) = t
        .upload(
            "/api/characters/import",
            "Seraphina.png",
            &card_png("Seraphina"),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{imported}");
    let character = &imported["characters"][0];
    let id = character["id"].as_str().unwrap();
    assert_eq!(character["name"], "Seraphina");
    assert_eq!(character["sourceFile"], "Seraphina.png");
    assert_eq!(character["tags"].as_array().unwrap().len(), 2);
    assert!(character["avatar"].is_string());

    // A broken file is reported, not fatal.
    let (status, failed) = t
        .upload(
            "/api/characters/import",
            "broken.png",
            b"\x89PNG\r\n\x1a\nxx",
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(failed["failures"][0]["fileName"], "broken.png");

    // Chat with a greeting, then a user message.
    let (status, created) = t
        .json(
            "POST",
            "/api/chats",
            Some(json!({"characterId": id, "title": "Seraphina - 1", "messages": [
                {"role": "assistant", "name": "Seraphina", "swipes": [{"content": "Hello"}, {"content": "Hi again"}]}
            ]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let chat_id = created["chat"]["id"].as_str().unwrap().to_string();
    let (_, added) = t
        .json(
            "POST",
            &format!("/api/chats/{chat_id}/messages"),
            Some(json!({"messages": [{"role": "user", "name": "You", "swipes": [{"content": "Hey"}]}]})),
        )
        .await;
    assert_eq!(added[0]["seq"], 1);

    // Swipe the greeting with a revision check; a stale revision conflicts.
    let greeting = &created["messages"][0];
    let gid = greeting["id"].as_str().unwrap();
    let (status, swiped) = t
        .json(
            "PATCH",
            &format!("/api/messages/{gid}"),
            Some(json!({"swipeId": 1, "rev": greeting["rev"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(swiped["swipeId"], 1);
    let (status, conflict) = t
        .json(
            "PATCH",
            &format!("/api/messages/{gid}"),
            Some(json!({"swipeId": 0, "rev": greeting["rev"]})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["error"]["rev"], 2);

    let (_, page) = t
        .json(
            "GET",
            &format!("/api/chats/{chat_id}/messages?limit=1"),
            None,
        )
        .await;
    assert_eq!(page.as_array().unwrap().len(), 1);
    assert_eq!(page[0]["swipes"][0]["content"], "Hey");

    // JSONL export and re-import.
    let res = t
        .send(
            Request::get(format!("/api/chats/{chat_id}/export"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    let jsonl = res.into_body().collect().await.unwrap().to_bytes();
    let parsed = bt_formats::chat::parse_jsonl(std::str::from_utf8(&jsonl).unwrap()).unwrap();
    assert_eq!(parsed.messages.len(), 2);
    assert_eq!(parsed.messages[0].swipes, vec!["Hello", "Hi again"]);
    let (status, reimported) = t
        .upload(
            "/api/chats/import",
            "Seraphina - 1.jsonl",
            &jsonl,
            &[("characterId", id)],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{reimported}");
    assert_eq!(reimported["title"], "Seraphina - 1 (2)");
    assert_eq!(reimported["messageCount"], 2);

    // PNG export carries the card.
    let res = t
        .send(
            Request::get(format!("/api/characters/{id}/export?format=png"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    let png = res.into_body().collect().await.unwrap().to_bytes();
    let raw = bt_formats::card::read_png(&png).unwrap();
    assert_eq!(raw["data"]["alternate_greetings"][0], "Hi again");

    // Bootstrap lists everything.
    let (_, boot) = t.json("GET", "/api/bootstrap", None).await;
    assert_eq!(boot["characters"][0]["chatCount"], 2);
    assert_eq!(boot["recentChats"].as_array().unwrap().len(), 2);
    assert_eq!(boot["tags"].as_array().unwrap().len(), 2);
}

/// A tiny upstream that streams five chunks slowly and echoes the auth header it received.
async fn mock_upstream() -> String {
    let app = axum::Router::new()
        .route(
            "/v1/stream",
            post(|headers: axum::http::HeaderMap| async move {
                let auth = headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let stream = futures_util::stream::iter(0..5).then(move |i| {
                    let auth = auth.clone();
                    async move {
                        tokio::time::sleep(Duration::from_millis(60)).await;
                        Ok::<_, std::io::Error>(Bytes::from(format!("data: {i} {auth}\n\n")))
                    }
                });
                (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(stream),
                )
            }),
        )
        .route(
            "/v1/models",
            get(|| async { axum::Json(json!({"data": [{"id": "m"}]})) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn secrets_are_bound_to_origins_and_injected() {
    let t = test_app();
    let upstream = mock_upstream().await;
    let (status, secret) = t
        .json("POST", "/api/secrets", Some(json!({"provider": "custom", "value": "sk-secret-123456", "allowedOrigins": [upstream]})))
        .await;
    assert_eq!(status, StatusCode::OK, "{secret}");
    assert_eq!(secret["masked"], "sk-…3456");
    let secret_id = secret["id"].as_str().unwrap();

    let (status, models) = t
        .json("POST", "/api/proxy", Some(json!({"url": format!("{upstream}/v1/models"), "method": "GET", "secretId": secret_id})))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(models["data"][0]["id"], "m");

    // The same key may not be sent anywhere else.
    let (status, err) = t
        .json("POST", "/api/proxy", Some(json!({"url": "https://example.com/v1/models", "method": "GET", "secretId": secret_id})))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{err}");

    let (_, secrets) = t.json("GET", "/api/secrets", None).await;
    assert!(!secrets.to_string().contains("sk-secret-123456"));
}

#[tokio::test]
async fn generation_jobs_survive_client_disconnects() {
    let t = test_app();
    let upstream = mock_upstream().await;
    let (_, secret) = t
        .json("POST", "/api/secrets", Some(json!({"provider": "custom", "value": "sk-abc-987654321", "allowedOrigins": [upstream]})))
        .await;
    let request = json!({
        "url": format!("{upstream}/v1/stream"), "body": "{}", "secretId": secret["id"],
        "meta": {"protocol": "test"}
    });
    let res = t
        .send(
            Request::post("/api/llm/jobs")
                .header("x-bt-client", "1")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(request.to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["x-bt-upstream"], "1");
    let job_id = res.headers()["x-bt-job-id"].to_str().unwrap().to_string();

    // Read the first chunk, then drop the connection mid-stream.
    let mut body = res.into_body().into_data_stream();
    let first = body.next().await.unwrap().unwrap();
    assert!(first.starts_with(b"data: 0 Bearer sk-abc-987654321"));
    drop(body);

    // The job keeps running without a client and ends up stored.
    let mut finished = Value::Null;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let (_, info) = t
            .json("GET", &format!("/api/llm/jobs/{job_id}"), None)
            .await;
        if info["status"] == "completed" {
            finished = info;
            break;
        }
    }
    assert_eq!(finished["status"], "completed");

    // Resume from where the client stopped.
    let res = t
        .send(
            Request::get(format!(
                "/api/llm/jobs/{job_id}/stream?offset={}",
                first.len()
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    let rest = res.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(rest.to_vec()).unwrap();
    assert!(text.starts_with("data: 1"), "{text}");
    assert!(text.contains("data: 4"));

    let (_, pending) = t.json("GET", "/api/llm/jobs", None).await;
    assert_eq!(pending.as_array().unwrap().len(), 1);
    let (status, _) = t
        .json("POST", &format!("/api/llm/jobs/{job_id}/ack"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, pending) = t.json("GET", "/api/llm/jobs", None).await;
    assert!(pending.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn unreachable_upstreams_fail_fast() {
    let t = test_app();
    let (status, body) = t
        .json(
            "POST",
            "/api/llm/jobs",
            Some(json!({"url": "http://127.0.0.1:1/v1/chat/completions", "body": "{}"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("could not connect"),
        "{body}"
    );
    let (_, pending) = t.json("GET", "/api/llm/jobs", None).await;
    assert!(pending.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn early_aborts_and_claims() {
    let t = test_app();
    let upstream = mock_upstream().await;

    // A Stop that overtakes the start request still prevents the job.
    let id = "client-chosen-job-0001";
    let (status, _) = t.json("DELETE", &format!("/api/llm/jobs/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = t
        .json(
            "POST",
            "/api/llm/jobs",
            Some(json!({"id": id, "url": format!("{upstream}/v1/stream"), "body": "{}"})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "aborted");

    let (status, _) = t
        .json(
            "POST",
            "/api/llm/jobs",
            Some(json!({"id": "bad id", "url": format!("{upstream}/v1/stream"), "body": "{}"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The tab that started a job gets the first right to store it; other tabs wait.
    let start = |client: &'static str| {
        Request::post("/api/llm/jobs")
            .header("x-bt-client", "1")
            .header("x-bt-client-id", client)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({"id": "client-chosen-job-0002", "url": format!("{upstream}/v1/stream"), "body": "{}"})
                    .to_string(),
            ))
            .unwrap()
    };
    let res = t.send(start("tab-a")).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["x-bt-job-id"], "client-chosen-job-0002");
    res.into_body().collect().await.unwrap();

    let claim = |client: &'static str| {
        Request::post("/api/llm/jobs/client-chosen-job-0002/claim")
            .header("x-bt-client", "1")
            .header("x-bt-client-id", client)
            .body(Body::empty())
            .unwrap()
    };
    let read = |res: Response| async move {
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice::<Value>(&bytes).unwrap()
    };
    // Wait for the job to be stored.
    for _ in 0..50 {
        let (_, info) = t
            .json("GET", "/api/llm/jobs/client-chosen-job-0002", None)
            .await;
        if info["status"] == "completed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        read(t.send(claim("tab-b")).await).await,
        json!({"claimed": false, "handled": false})
    );
    assert_eq!(
        read(t.send(claim("tab-a")).await).await,
        json!({"claimed": true, "handled": false})
    );
    let (status, _) = t
        .json("POST", "/api/llm/jobs/client-chosen-job-0002/ack", None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        read(t.send(claim("tab-b")).await).await,
        json!({"claimed": false, "handled": true})
    );
}

/// A chat written by SillyTavern 1.19 survives import and export unchanged (compared as JSON,
/// line by line): message shapes, swipe data, unknown fields, metadata and old date formats.
#[tokio::test]
async fn sillytavern_chats_round_trip_losslessly() {
    let t = test_app();
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/st/chats/Seraphina - 2026-10-14@23h56m12s.jsonl"
    );
    let original = std::fs::read_to_string(path).unwrap();
    let (status, chat) = t
        .upload(
            "/api/chats/import",
            "Seraphina - 2026-10-14@23h56m12s.jsonl",
            original.as_bytes(),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{chat}");
    assert_eq!(chat["title"], "Seraphina - 2026-10-14@23h56m12s");

    let res = t
        .send(
            Request::get(format!(
                "/api/chats/{}/export",
                chat["id"].as_str().unwrap()
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    let exported =
        String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();

    let parse = |text: &str| -> Vec<Value> {
        text.lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    };
    let (before, after) = (parse(&original), parse(&exported));
    assert_eq!(before.len(), after.len());
    for (i, (b, a)) in before.iter().zip(&after).enumerate() {
        assert_eq!(b, a, "line {} differs", i + 1);
    }
}

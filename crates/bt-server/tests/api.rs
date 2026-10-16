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

#[tokio::test]
async fn branches_and_checkpoints_link_back_like_sillytavern() {
    let t = test_app();
    let (_, imported) = t
        .upload("/api/characters/import", "Aiko.png", &card_png("Aiko"), &[])
        .await;
    let id = imported["characters"][0]["id"].as_str().unwrap();
    let (status, created) = t
        .json(
            "POST",
            "/api/chats",
            Some(json!({"characterId": id, "title": "Aiko - 2026", "messages": [
                {"role": "assistant", "name": "Aiko", "swipes": [{"content": "Hello"}]},
                {"role": "user", "name": "You", "swipes": [{"content": "Hi"}]},
                {"role": "assistant", "name": "Aiko", "swipes": [{"content": "One"}, {"content": "Two"}]}
            ]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let chat_id = created["chat"]["id"].as_str().unwrap().to_string();
    let branch = |body: Value| {
        let uri = format!("/api/chats/{chat_id}/branch");
        let t = &t;
        async move { t.json("POST", &uri, Some(body)).await }
    };

    // Branches are named after the chat and listed on the message.
    let (status, first) = branch(json!({"upTo": 1})).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["chat"]["title"], "Aiko - 2026 - Branch #1");
    assert_eq!(first["chat"]["metadata"]["main_chat"], "Aiko - 2026");
    assert_eq!(first["chat"]["messageCount"], 2);
    let (_, second) = branch(json!({"upTo": 1})).await;
    assert_eq!(second["chat"]["title"], "Aiko - 2026 - Branch #2");
    assert_eq!(
        second["message"]["extra"]["branches"],
        json!(["Aiko - 2026 - Branch #1", "Aiko - 2026 - Branch #2"])
    );

    // A checkpoint at a chosen swipe; the message links to it.
    let (status, checkpoint) = branch(json!({"upTo": 2, "checkpoint": true, "swipeId": 1})).await;
    assert_eq!(status, StatusCode::OK, "{checkpoint}");
    assert_eq!(checkpoint["chat"]["title"], "Aiko - 2026 - Checkpoint #1");
    assert_eq!(
        checkpoint["message"]["extra"]["bookmark_link"],
        "Aiko - 2026 - Checkpoint #1"
    );
    let cid = checkpoint["chat"]["id"].as_str().unwrap();
    let (_, copy) = t
        .json("GET", &format!("/api/chats/{cid}/messages"), None)
        .await;
    assert_eq!(copy[2]["swipeId"], 1);

    // Names are unique per character; bad indexes are refused.
    let (status, taken) = branch(json!({"upTo": 0, "title": "Aiko - 2026 - Branch #1"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(taken["error"]["code"], "exists");
    let (status, _) = branch(json!({"upTo": 7})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = branch(json!({"upTo": 2, "swipeId": 5})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn prompts_are_logged_per_generation() {
    let t = test_app();
    let (_, created) = t
        .json("POST", "/api/chats", Some(json!({"title": "Notes"})))
        .await;
    let chat_id = created["chat"]["id"].as_str().unwrap().to_string();
    let uri = format!("/api/chats/{chat_id}/prompts");
    for (at, total) in [
        ("2026-10-16T10:00:00.000Z", 10),
        ("2026-10-16T10:01:00.000Z", 12),
    ] {
        let (status, _) = t
            .json(
                "POST",
                &uri,
                Some(json!({"startedAt": at, "data": {"total": total}})),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }
    let (status, log) = t
        .json(
            "GET",
            &format!("{uri}?startedAt=2026-10-16T10:01:00.000Z"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        log,
        json!({"prompt": {"total": 12}, "previous": {"total": 10}})
    );
    let (_, none) = t
        .json(
            "GET",
            &format!("{uri}?startedAt=2026-10-16T09:00:00.000Z"),
            None,
        )
        .await;
    assert_eq!(none, json!({"prompt": null, "previous": null}));
    // Only the owner's chats.
    let (status, _) = t
        .json("GET", "/api/chats/nope/prompts?startedAt=x", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn taken_names_are_reported_as_exists() {
    let t = test_app();
    let (status, _) = t
        .json("POST", "/api/lorebooks", Some(json!({"name": "Eldoria"})))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = t
        .json("POST", "/api/lorebooks", Some(json!({"name": "Eldoria"})))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "exists");
}

#[tokio::test]
async fn seeding_presets_keeps_existing_ones() {
    let t = test_app();
    let (status, _) = t
        .json(
            "PUT",
            "/api/presets",
            Some(json!({"kind": "context", "name": "Default", "data": {"story_string": "mine"}})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let seed = json!({"presets": [
        {"kind": "context", "name": "Default", "data": {"story_string": "theirs"}},
        {"kind": "instruct", "name": "ChatML", "data": {"input_sequence": "<|im_start|>user"}},
    ]});
    let (status, created) = t
        .json("POST", "/api/presets/seed", Some(seed.clone()))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created.as_array().unwrap().len(), 1);
    assert_eq!(created[0]["name"], "ChatML");
    // Seeding again creates nothing; the user's own preset is untouched.
    let (_, again) = t.json("POST", "/api/presets/seed", Some(seed)).await;
    assert_eq!(again, json!([]));
    let (_, list) = t.json("GET", "/api/presets?kind=context", None).await;
    let id = list[0]["id"].as_str().unwrap().to_string();
    let (_, preset) = t.json("GET", &format!("/api/presets/{id}"), None).await;
    assert_eq!(preset["data"]["story_string"], "mine");
}

#[tokio::test]
async fn tokenizer_files_come_from_the_cache() {
    let t = test_app();
    // A file placed in the cache by hand is served without downloading.
    let dir = t._dir.path().join("cache").join("tokenizers");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("llama3.json"), b"{\"model\":{}}").unwrap();
    let res = t
        .send(
            Request::get("/api/tokenizers/llama3.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], b"{\"model\":{}}");
    // Only known tokenizer files.
    let res = t
        .send(
            Request::get("/api/tokenizers/secret.key")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

/// A SillyTavern user directory as a backup zip: a card with chats, a lorebook, presets, a
/// persona with avatar, tags, keys and things BakaTavern does not import yet.
fn st_backup_zip() -> Vec<u8> {
    use std::io::Write;
    let chat = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/st/chats/Seraphina - 2026-10-14@23h56m12s.jsonl"
    ))
    .unwrap();
    let settings = json!({
        "power_user": {
            "personas": { "user-default.png": "Mika", "user-2.png": "Ren" },
            "persona_descriptions": {
                "user-default.png": { "description": "{{user}} is a nurse.", "position": 4, "depth": 1, "role": 1, "lorebook": "", "title": "Night shift" },
                "user-2.png": { "description": "A pilot." }
            },
            "default_persona": "user-default.png"
        },
        "tags": [{ "id": "1700000000000", "name": "favorite", "folder_type": "OPEN", "color": "#ff0000" }],
        "tag_map": { "Seraphina.png": ["1700000000000"] },
        "extension_settings": { "regex": [{ "id": "r1", "scriptName": "Shout", "findRegex": "/a/g", "replaceString": "A" }] },
        "world_info_settings": { "world_info": { "globalSelect": ["Eldoria"] } }
    });
    let secrets = json!({
        "_migrated": true,
        "api_key_openai": [{ "id": "k1", "value": "sk-test-1234567890", "label": "work", "active": true }],
        "api_key_tavily": [{ "id": "k2", "value": "tvly", "label": "", "active": true }]
    });
    let files: Vec<(&str, Vec<u8>)> = vec![
        ("settings.json", settings.to_string().into_bytes()),
        ("secrets.json", secrets.to_string().into_bytes()),
        ("characters/Seraphina.png", card_png("Seraphina")),
        ("chats/Seraphina/Seraphina - 2026-10-14@23h56m12s.jsonl", chat.into_bytes()),
        ("chats/Unknown/Orphan.jsonl", b"{}\n".to_vec()),
        (
            "chats/Seraphina/Photos.jsonl",
            [
                json!({ "user_name": "Mika", "character_name": "Seraphina", "create_date": "2026-10-15@10h00m00s", "chat_metadata": {} }),
                json!({ "name": "Mika", "is_user": true, "is_system": false, "send_date": "2026-10-15T10:00:00.000Z", "mes": "Look!",
                    "extra": {
                        "media": [{ "url": "user/images/Seraphina/photo.png", "type": "image", "title": "photo.png", "source": "upload" }],
                        "files": [{ "url": "user/files/1760000000000_note.txt", "name": "note.txt", "size": 5 }, { "url": "user/files/gone.txt", "name": "gone.txt" }]
                    } }),
            ]
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            .into_bytes(),
        ),
        ("user/images/Seraphina/photo.png", bt_formats::png::placeholder()),
        ("user/files/1760000000000_note.txt", b"Notes".to_vec()),
        (
            "worlds/Eldoria.json",
            json!({ "entries": { "0": { "uid": 0, "key": ["glade"], "content": "A quiet glade." } } })
                .to_string()
                .into_bytes(),
        ),
        ("OpenAI Settings/My Preset.json", json!({ "temp_openai": 0.7 }).to_string().into_bytes()),
        ("instruct/ChatML.json", json!({ "name": "ChatML", "input_sequence": "<|im_start|>user" }).to_string().into_bytes()),
        ("User Avatars/user-default.png", bt_formats::png::placeholder()),
        ("groups/1.json", b"{}".to_vec()),
        ("backgrounds/rain.jpg", b"jpeg".to_vec()),
    ];
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (path, bytes) in files {
        zip.start_file(path, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[tokio::test]
async fn sillytavern_backups_import_once() {
    let t = test_app();
    let backup = st_backup_zip();
    let (status, report) = t
        .upload(
            "/api/import/st",
            "backup.zip",
            &backup,
            &[("secrets", "true")],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(report["characters"], 1);
    assert_eq!(report["chats"], 2);
    assert_eq!(report["lorebooks"], 1);
    assert_eq!(report["presets"], 2);
    assert_eq!(report["personas"], 2);
    assert_eq!(report["secrets"], 1);
    assert_eq!(report["attachments"], 2);
    // Two links point at files the backup does not have (one in the fixture chat).
    assert_eq!(report["skipped"]["missingAttachments"], 2);
    assert_eq!(report["settings"], true);
    assert_eq!(report["skipped"]["groups"], 1);
    assert_eq!(report["skipped"]["backgrounds"], 1);
    assert_eq!(report["skipped"]["chatsWithoutCharacter"], 1);
    assert_eq!(report["skipped"]["otherKeys"], 1);
    assert_eq!(report["failures"], json!([]));

    let (_, characters) = t.json("GET", "/api/characters", None).await;
    let seraphina = &characters[0];
    assert_eq!(seraphina["sourceFile"], "Seraphina.png");
    let (_, chats) = t
        .json(
            "GET",
            &format!(
                "/api/characters/{}/chats",
                seraphina["id"].as_str().unwrap()
            ),
            None,
        )
        .await;
    let titles: Vec<&str> = chats
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["title"].as_str().unwrap())
        .collect();
    assert!(titles.contains(&"Seraphina - 2026-10-14@23h56m12s"));
    // Attached files move into the file store; the messages point there.
    let photos = chats
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["title"] == "Photos")
        .unwrap();
    let (_, messages) = t
        .json(
            "GET",
            &format!("/api/chats/{}/messages", photos["id"].as_str().unwrap()),
            None,
        )
        .await;
    let extra = &messages[0]["extra"];
    let image = extra["media"][0]["url"].as_str().unwrap();
    assert!(image.starts_with("/api/files/"), "{image}");
    let note = extra["files"][0]["url"].as_str().unwrap();
    let res = t
        .send(Request::get(note).body(Body::empty()).unwrap())
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        &res.into_body().collect().await.unwrap().to_bytes()[..],
        b"Notes"
    );
    // A file that was not in the backup keeps its link.
    assert_eq!(extra["files"][1]["url"], "user/files/gone.txt");
    let (_, tags) = t.json("GET", "/api/tags", None).await;
    let favorite = tags
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "favorite")
        .unwrap();
    assert_eq!(favorite["folder"], "open");
    assert!(
        seraphina["tags"]
            .as_array()
            .unwrap()
            .contains(&favorite["id"])
    );

    let (_, personas) = t.json("GET", "/api/personas", None).await;
    let mika = personas
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "Mika")
        .unwrap();
    assert_eq!(mika["position"], 4);
    assert_eq!(mika["isDefault"], true);
    assert_eq!(mika["sourceFile"], "user-default.png");
    assert!(mika["avatar"].is_string());
    assert_eq!(mika["data"]["title"], "Night shift");

    let (_, secrets) = t.json("GET", "/api/secrets", None).await;
    assert_eq!(secrets[0]["provider"], "openai");
    assert_eq!(secrets[0]["label"], "work");
    assert_eq!(secrets[0]["allowedOrigins"], json!([]));

    let (_, stash) = t.json("GET", "/api/settings/st_import", None).await;
    assert_eq!(
        stash["data"]["settings"]["extension_settings"]["regex"][0]["scriptName"],
        "Shout"
    );
    assert_eq!(
        stash["data"]["characters"]["Seraphina.png"],
        seraphina["id"]
    );
    assert!(stash["data"]["presets"]["openai/My Preset"].is_string());
    assert_eq!(stash["data"]["secrets"][0]["active"], true);
    assert_eq!(stash["data"]["secrets"][0]["stId"], "k1");

    // A second import changes nothing that is already here.
    let (_, again) = t.upload("/api/import/st", "backup.zip", &backup, &[]).await;
    assert_eq!(again["characters"], 0);
    assert_eq!(again["chats"], 0);
    assert_eq!(again["lorebooks"], 0);
    assert_eq!(again["personas"], 0);
    assert_eq!(again["presets"], 2);
    assert_eq!(again["unchanged"], 6);
    let (_, characters) = t.json("GET", "/api/characters", None).await;
    assert_eq!(characters.as_array().unwrap().len(), 1);
}

fn zip_entries(bytes: &[u8]) -> std::collections::BTreeMap<String, Vec<u8>> {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = std::collections::BTreeMap::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        let mut data = Vec::new();
        file.read_to_end(&mut data).unwrap();
        out.insert(file.name().unwrap().to_string(), data);
    }
    out
}

#[tokio::test]
async fn exports_a_sillytavern_folder_that_imports_again() {
    let t = test_app();
    let (status, _) = t
        .upload("/api/import/st", "backup.zip", &st_backup_zip(), &[])
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, names) = t.json("GET", "/api/export/st/names", None).await;
    let (_, characters) = t.json("GET", "/api/characters", None).await;
    let seraphina = characters[0]["id"].as_str().unwrap();
    assert_eq!(names["characters"][seraphina], "Seraphina.png");

    let req = Request::post("/api/export/st")
        .header("x-bt-client", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "settings": { "world_info_settings": { "world_info": { "globalSelect": ["Eldoria"] } } } })
                .to_string(),
        ))
        .unwrap();
    let res = t.send(req).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], "application/zip");
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let files = zip_entries(&bytes);
    let paths: Vec<&str> = files.keys().map(String::as_str).collect();
    for expected in [
        "characters/Seraphina.png",
        "chats/Seraphina/Seraphina - 2026-10-14@23h56m12s.jsonl",
        "worlds/Eldoria.json",
        "OpenAI Settings/My Preset.json",
        "instruct/ChatML.json",
        "User Avatars/user-default.png",
        "settings.json",
    ] {
        assert!(
            paths.contains(&expected),
            "{expected} missing from {paths:?}"
        );
    }
    // The chat comes back exactly as it was imported.
    let original = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/st/chats/Seraphina - 2026-10-14@23h56m12s.jsonl"
    ))
    .unwrap();
    let exported =
        String::from_utf8(files["chats/Seraphina/Seraphina - 2026-10-14@23h56m12s.jsonl"].clone())
            .unwrap();
    let as_json = |text: &str| -> Vec<Value> {
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    };
    assert_eq!(as_json(&exported), as_json(&original));
    // Attachments go back into SillyTavern's user folder.
    let photos =
        as_json(&String::from_utf8(files["chats/Seraphina/Photos.jsonl"].clone()).unwrap());
    let image = photos[1]["extra"]["media"][0]["url"].as_str().unwrap();
    assert!(
        image.starts_with("user/images/Seraphina/") && image.ends_with(".png"),
        "{image}"
    );
    assert_eq!(files[image], bt_formats::png::placeholder());
    let note = photos[1]["extra"]["files"][0]["url"].as_str().unwrap();
    assert!(
        note.starts_with("user/files/") && note.ends_with(".txt"),
        "{note}"
    );
    assert_eq!(files[note], b"Notes");
    let card = bt_formats::card::read_png(&files["characters/Seraphina.png"]).unwrap();
    assert_eq!(card["data"]["name"], "Seraphina");
    let settings: Value = serde_json::from_slice(&files["settings.json"]).unwrap();
    assert_eq!(
        settings["world_info_settings"]["world_info"]["globalSelect"][0],
        "Eldoria"
    );
    assert_eq!(
        settings["power_user"]["personas"]["user-default.png"],
        "Mika"
    );
    assert_eq!(
        settings["power_user"]["persona_descriptions"]["user-default.png"]["position"],
        4
    );
    assert_eq!(
        settings["power_user"]["default_persona"],
        "user-default.png"
    );
    let tag_id = settings["tag_map"]["Seraphina.png"][0].as_str().unwrap();
    let favorite = settings["tags"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == tag_id);
    assert!(favorite.is_some());

    // Back into a fresh BakaTavern.
    let fresh = test_app();
    let (status, report) = fresh
        .upload("/api/import/st", "export.zip", &bytes, &[])
        .await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(report["characters"], 1);
    assert_eq!(report["chats"], 2);
    assert_eq!(report["attachments"], 2);
    assert_eq!(report["lorebooks"], 1);
    assert_eq!(report["presets"], 2);
    assert_eq!(report["personas"], 2);
}

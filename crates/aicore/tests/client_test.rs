//! Tests for the DeepSeek client against a local mock server, plus prompt
//! build/chunk/retrieval checks. No real network access is used.

use aicore::prompts::{
    ask_prompt, chunk_text, metadata_prompt, parse_metadata_reply, select_relevant_pages,
    summarize_prompt, translate_page_prompt, Plan, SummaryLength, SummaryOptions, SummaryStyle,
    TranslateOptions,
};
use aicore::{AiConfig, AiError, CancelToken, ChatMessage, ChatOptions, DeepSeekClient};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

/// Starts a mock HTTP server; `responder` returns the raw body for a request.
fn mock_server(
    status: u16,
    content_type: &'static str,
    body: String,
    chunked: bool,
) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("addr");
    let handle = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = read_request(&mut stream);
            if chunked {
                let header = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(header.as_bytes());
                for line in body.split_inclusive('\n') {
                    let frame = format!("{:x}\r\n{}\r\n", line.len(), line);
                    if stream.write_all(frame.as_bytes()).is_err() {
                        return;
                    }
                    let _ = stream.flush();
                    thread::sleep(std::time::Duration::from_millis(5));
                }
                let _ = stream.write_all(b"0\r\n\r\n");
                let _ = stream.flush();
            } else {
                let response = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        }
    });
    (format!("http://{address}"), handle)
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut buffer = [0u8; 4096];
    let mut request = String::new();
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
    while let Ok(read) = stream.read(&mut buffer) {
        if read == 0 {
            break;
        }
        request.push_str(&String::from_utf8_lossy(&buffer[..read]));
        if request.contains("\r\n\r\n") {
            // Body may still be pending; the mock does not need it.
            break;
        }
    }
    request
}

fn client_for(base_url: String) -> DeepSeekClient {
    DeepSeekClient::new(AiConfig {
        api_key: "test-key".into(),
        base_url,
        ..Default::default()
    })
    .expect("client")
}

#[tokio::test]
async fn chat_reads_a_normal_completion() {
    let body = r#"{"choices":[{"message":{"role":"assistant","content":"  1200 EUR  "}}]}"#.to_string();
    let (url, handle) = mock_server(200, "application/json", body, false);
    let client = client_for(url);
    let reply = client
        .chat(&[ChatMessage::user("total?")], ChatOptions::default())
        .await
        .expect("completion");
    assert_eq!(reply.trim(), "1200 EUR");
    handle.join().unwrap();
}

#[tokio::test]
async fn chat_stream_assembles_server_sent_events() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_string();
    let (url, handle) = mock_server(200, "text/event-stream", body, true);
    let client = client_for(url);
    let cancel = CancelToken::new();
    let mut deltas = String::new();
    let full = client
        .chat_stream(
            &[ChatMessage::user("hi")],
            ChatOptions::default(),
            &cancel,
            &mut |delta| deltas.push_str(delta),
            &mut |_| {},
        )
        .await
        .expect("stream");
    assert_eq!(full, "Hello world");
    assert_eq!(deltas, "Hello world");
    handle.join().unwrap();
}

#[tokio::test]
async fn http_errors_map_to_friendly_codes() {
    for (status, expected) in [
        (401, "invalid_api_key"),
        (402, "insufficient_balance"),
        (429, "rate_limited"),
    ] {
        let body = format!(r#"{{"error":{{"message":"nope","code":"{status}"}}}}"#);
        let (url, handle) = mock_server(status, "application/json", body, false);
        let client = client_for(url);
        let error = client
            .chat(&[ChatMessage::user("x")], ChatOptions::default())
            .await
            .expect_err("should fail");
        let code = match error {
            AiError::InvalidApiKey => "invalid_api_key",
            AiError::InsufficientBalance => "insufficient_balance",
            AiError::RateLimited => "rate_limited",
            other => panic!("unexpected error {other:?}"),
        };
        assert_eq!(code, expected);
        handle.join().unwrap();
    }
}

#[tokio::test]
async fn missing_api_key_is_rejected_before_any_request() {
    let config = AiConfig {
        api_key: String::new(),
        ..Default::default()
    };
    assert!(matches!(
        DeepSeekClient::new(config),
        Err(AiError::MissingApiKey)
    ));
}

#[tokio::test]
async fn cancellation_stops_the_stream() {
    let body = (0..50)
        .map(|index| format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{index}\"}}}}]}}\n\n"))
        .collect::<String>();
    let (url, handle) = mock_server(200, "text/event-stream", body, true);
    let client = client_for(url);
    let cancel = CancelToken::new();
    cancel.cancel();
    let result = client
        .chat_stream(&[ChatMessage::user("hi")], ChatOptions::default(), &cancel, &mut |_| {}, &mut |_| {})
        .await;
    assert!(matches!(result, Err(AiError::Cancelled)));
    handle.join().unwrap();
}

#[tokio::test]
async fn reasoning_only_streams_return_the_thinking_trace() {
    // Thinking mode can consume the whole token budget before any answer
    // text arrives; the client must not fail with an empty response.
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Let me \"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think about this.\"}}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_string();
    let (url, handle) = mock_server(200, "text/event-stream", body, true);
    let client = client_for(url);
    let cancel = CancelToken::new();
    let mut reasoning = String::new();
    let mut answer = String::new();
    let full = client
        .chat_stream(
            &[ChatMessage::user("hi")],
            ChatOptions::default(),
            &cancel,
            &mut |delta| answer.push_str(delta),
            &mut |delta| reasoning.push_str(delta),
        )
        .await
        .expect("reasoning-only stream must succeed");
    assert_eq!(full, "Let me think about this.");
    assert_eq!(reasoning, "Let me think about this.");
    assert!(answer.is_empty());
    handle.join().unwrap();
}

#[tokio::test]
async fn thinking_deltas_are_reported_separately_from_the_answer() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"checking numbers...\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Total is 1200 EUR.\"}}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_string();
    let (url, handle) = mock_server(200, "text/event-stream", body, true);
    let client = client_for(url);
    let cancel = CancelToken::new();
    let mut reasoning = String::new();
    let mut answer = String::new();
    let full = client
        .chat_stream(
            &[ChatMessage::user("total?")],
            ChatOptions::default(),
            &cancel,
            &mut |delta| answer.push_str(delta),
            &mut |delta| reasoning.push_str(delta),
        )
        .await
        .expect("stream");
    assert_eq!(full, "Total is 1200 EUR.");
    assert_eq!(answer, "Total is 1200 EUR.");
    assert_eq!(reasoning, "checking numbers...");
    handle.join().unwrap();
}

#[test]
fn thinking_parameters_only_apply_to_v4_models() {
    assert!(aicore::supports_thinking("deepseek-v4-flash"));
    assert!(aicore::supports_thinking("deepseek-v4-pro"));
    assert!(!aicore::supports_thinking("deepseek-chat"));
    assert!(!aicore::supports_thinking("llama3.1:8b"));
    let config = AiConfig {
        api_key: "k".into(),
        model: "deepseek-v4-flash".into(),
        ..Default::default()
    };
    assert!(config.thinking);
    assert_eq!(config.reasoning_effort, "high");
}

#[tokio::test]
async fn thinking_fields_are_sent_to_v4_models_and_omitted_otherwise() {
    // The mock echoes the received request body via the reasoning channel, so
    // the test can inspect what the client actually sent.
    let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let captured_clone = captured.clone();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let request = read_request(&mut stream);
            let body = request.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
            *captured_clone.lock().unwrap() = body;
            let reply = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
            let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(header.as_bytes());
            for line in reply.split_inclusive('\n') {
                let frame = format!("{:x}\r\n{}\r\n", line.len(), line);
                let _ = stream.write_all(frame.as_bytes());
            }
            let _ = stream.write_all(b"0\r\n\r\n");
            let _ = stream.flush();
        }
    });

    let client = client_for(format!("http://{address}"));
    let cancel = CancelToken::new();
    client
        .chat_stream(&[ChatMessage::user("hi")], ChatOptions::default(), &cancel, &mut |_| {}, &mut |_| {})
        .await
        .expect("v4 stream");
    handle.join().unwrap();
    let body = captured.lock().unwrap().clone();
    assert!(body.contains("\"thinking\":{\"type\":\"enabled\"}"), "thinking missing in {body}");
    assert!(body.contains("\"reasoning_effort\":\"high\""), "effort missing in {body}");

    // A legacy model must not receive the V4-only fields.
    let captured2 = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let captured2_clone = captured2.clone();
    let listener2 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address2 = listener2.local_addr().unwrap();
    let handle2 = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener2.accept() {
            let request = read_request(&mut stream);
            let body = request.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
            *captured2_clone.lock().unwrap() = body;
            let reply = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
            let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(header.as_bytes());
            for line in reply.split_inclusive('\n') {
                let frame = format!("{:x}\r\n{}\r\n", line.len(), line);
                let _ = stream.write_all(frame.as_bytes());
            }
            let _ = stream.write_all(b"0\r\n\r\n");
            let _ = stream.flush();
        }
    });
    let legacy = DeepSeekClient::new(AiConfig {
        api_key: "k".into(),
        base_url: format!("http://{address2}"),
        model: "deepseek-chat".into(),
        ..Default::default()
    })
    .unwrap();
    legacy
        .chat_stream(&[ChatMessage::user("hi")], ChatOptions::default(), &cancel, &mut |_| {}, &mut |_| {})
        .await
        .expect("legacy stream");
    handle2.join().unwrap();
    let body2 = captured2.lock().unwrap().clone();
    assert!(!body2.contains("thinking"), "legacy model must not receive thinking: {body2}");
    assert!(!body2.contains("reasoning_effort"), "legacy model must not receive effort: {body2}");
}

#[test]
fn chunking_splits_on_paragraphs_and_keeps_order() {
    let paragraph = "Sentence about invoices and payments. ".repeat(60); // ~2.3k chars
    let text = (0..30)
        .map(|index| format!("{paragraph} [para {index}]"))
        .collect::<Vec<_>>()
        .join("\n\n");
    let chunks = chunk_text(&text, 8_000);
    assert!(chunks.len() > 1, "expected chunking, got {}", chunks.len());
    assert!(chunks.iter().all(|chunk| chunk.len() <= 8_000));
    let rebuilt = chunks.join(" ");
    assert!(rebuilt.contains("[para 0]"));
    assert!(rebuilt.contains("[para 29]"));
}

#[test]
fn summarize_prompt_switches_to_map_reduce_for_long_documents() {
    let short = summarize_prompt("Short text", &SummaryOptions::default());
    assert!(matches!(short, Plan::Single { .. }));

    let long_text = "word ".repeat(20_000); // ~100k chars
    let plan = summarize_prompt(&long_text, &SummaryOptions::default());
    match plan {
        Plan::MapReduce { chunks, reduce } => {
            assert!(chunks.len() >= 3);
            assert!(reduce.contains("Summarize the document text below"));
        }
        Plan::Single { .. } => panic!("expected map/reduce for long input"),
    }
}

#[test]
fn summarize_prompt_includes_style_and_language() {
    let plan = summarize_prompt(
        "text",
        &SummaryOptions {
            language: "Turkish".into(),
            length: SummaryLength::Short,
            style: SummaryStyle::Bullets,
            focus: "payment terms".into(),
        },
    );
    let Plan::Single { messages } = plan else {
        panic!("expected single request");
    };
    let user_message = &messages[1].content;
    assert!(user_message.contains("Reply in Turkish."));
    assert!(user_message.contains("3-5 sentences"));
    assert!(user_message.contains("bullet points"));
    assert!(user_message.contains("payment terms"));
}

#[test]
fn translation_prompt_keeps_markers_and_optional_bilingual_output() {
    let messages = translate_page_prompt(
        "Page 3",
        "Hello world",
        &TranslateOptions {
            target_language: "tr".into(),
            bilingual: true,
        },
    );
    assert_eq!(messages[0].role, "system");
    let user = &messages[1].content;
    assert!(user.contains("into tr"));
    assert!(user.contains("Page marker: Page 3"));
    assert!(user.contains("Hello world"));
    assert!(user.contains("Original"));
}

#[test]
fn relevance_retrieval_prefers_matching_pages() {
    let pages = vec![
        (1, "Introduction and table of contents".to_string()),
        (2, "The total amount due is 1200 EUR, payable in 30 days.".to_string()),
        (3, "Appendix with addresses".to_string()),
        (4, "Payment terms: bank transfer to IBAN DE00.".to_string()),
    ];
    let selected = select_relevant_pages(&pages, "payment terms and total amount", 10_000);
    let page_numbers: Vec<u32> = selected.iter().map(|(page, _)| *page).collect();
    assert!(page_numbers.contains(&2));
    assert!(page_numbers.contains(&4));
    assert!(!page_numbers.contains(&3));
    // Results stay in document order.
    let mut sorted = page_numbers.clone();
    sorted.sort_unstable();
    assert_eq!(page_numbers, sorted);
}

#[test]
fn metadata_reply_is_parsed_from_json_with_chatter() {
    let reply = "Sure!\n```json\n{\"title\":\"Invoice 2026-01\",\"author\":\"Acme\",\"subject\":\"Billing\",\"keywords\":[\"invoice\",\"2026\",\"\"]}\n```";
    let parsed = parse_metadata_reply(reply).expect("parsed");
    assert_eq!(parsed.title, "Invoice 2026-01");
    assert_eq!(parsed.author, "Acme");
    assert_eq!(parsed.keywords, vec!["invoice", "2026"]);
    assert!(parse_metadata_reply("no json here").is_none());
}

#[test]
fn ask_and_metadata_prompts_are_bounded() {
    let long_text = "x".repeat(50_000);
    let messages = metadata_prompt(&long_text);
    assert!(messages[1].content.len() < 9_000, "metadata excerpt must be small");
    let ask = ask_prompt("[page 1]\nsome content", "What is the total?");
    assert!(ask[1].content.contains("What is the total?"));
    assert!(ask[0].content.contains("Cite the page numbers"));
}

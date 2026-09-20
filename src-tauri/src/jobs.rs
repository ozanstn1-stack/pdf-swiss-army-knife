//! Job registry: cancellation tokens and progress forwarding for background
//! operations. No document content or passwords ever pass through here.

use pdfcore::progress::{CancelToken, ProgressEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, CancelToken>>,
}

impl JobRegistry {
    pub fn register(&self, job_id: &str) -> CancelToken {
        let token = CancelToken::new();
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.retain(|_, token| !token.is_cancelled());
            jobs.insert(job_id.to_string(), token.clone());
        }
        token
    }

    pub fn cancel(&self, job_id: &str) {
        if let Ok(jobs) = self.jobs.lock() {
            if let Some(token) = jobs.get(job_id) {
                token.cancel();
            }
        }
    }

    pub fn finish(&self, job_id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(job_id);
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(jobs) = self.jobs.lock() {
            for token in jobs.values() {
                token.cancel();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub job_id: String,
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub message: Option<String>,
}

pub fn emit_progress(app: &AppHandle, job_id: &str, event: &ProgressEvent) {
    let payload = ProgressPayload {
        job_id: job_id.to_string(),
        stage: event.stage.clone(),
        current: event.current,
        total: event.total,
        message: event.message.clone(),
    };
    // Progress is best-effort: a closed window must not abort the job.
    let _ = app.emit("job:progress", payload);
}

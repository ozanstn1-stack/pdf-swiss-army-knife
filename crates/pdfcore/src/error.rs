use serde::Serialize;
use std::path::Path;

/// Stable error codes surfaced to the UI. The frontend maps these to
/// localized, user friendly messages - raw internal errors are never shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidPdf,
    CorruptPdf,
    PasswordRequired,
    WrongPassword,
    NotFound,
    PermissionDenied,
    FileLocked,
    OutputExists,
    DiskFull,
    Cancelled,
    EngineMissing,
    OcrEngineUnavailable,
    Unsupported,
    InvalidInput,
    InvalidImage,
    RangeOutOfBounds,
    ConversionFailed,
    ProcessingFailed,
    Internal,
}

#[derive(Debug, thiserror::Error)]
pub enum PdfError {
    #[error("invalid PDF: {0}")]
    InvalidPdf(String),
    #[error("corrupt PDF: {0}")]
    CorruptPdf(String),
    #[error("document is password protected")]
    PasswordRequired,
    #[error("incorrect password")]
    WrongPassword,
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("file is in use by another program: {0}")]
    FileLocked(String),
    #[error("output file already exists: {0}")]
    OutputExists(String),
    #[error("not enough disk space")]
    DiskFull,
    #[error("operation cancelled")]
    Cancelled,
    #[error("required engine is not available: {0}")]
    EngineMissing(String),
    #[error("OCR engine is not available")]
    OcrEngineUnavailable,
    #[error("unsupported input: {0}")]
    Unsupported(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("invalid image: {0}")]
    InvalidImage(String),
    #[error("page selection is out of bounds")]
    RangeOutOfBounds,
    #[error("conversion failed: {0}")]
    ConversionFailed(String),
    #[error("processing failed: {0}")]
    ProcessingFailed(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl PdfError {
    pub fn code(&self) -> ErrorCode {
        match self {
            PdfError::InvalidPdf(_) => ErrorCode::InvalidPdf,
            PdfError::CorruptPdf(_) => ErrorCode::CorruptPdf,
            PdfError::PasswordRequired => ErrorCode::PasswordRequired,
            PdfError::WrongPassword => ErrorCode::WrongPassword,
            PdfError::NotFound(_) => ErrorCode::NotFound,
            PdfError::PermissionDenied(_) => ErrorCode::PermissionDenied,
            PdfError::FileLocked(_) => ErrorCode::FileLocked,
            PdfError::OutputExists(_) => ErrorCode::OutputExists,
            PdfError::DiskFull => ErrorCode::DiskFull,
            PdfError::Cancelled => ErrorCode::Cancelled,
            PdfError::EngineMissing(_) => ErrorCode::EngineMissing,
            PdfError::OcrEngineUnavailable => ErrorCode::OcrEngineUnavailable,
            PdfError::Unsupported(_) => ErrorCode::Unsupported,
            PdfError::InvalidInput(_) => ErrorCode::InvalidInput,
            PdfError::InvalidImage(_) => ErrorCode::InvalidImage,
            PdfError::RangeOutOfBounds => ErrorCode::RangeOutOfBounds,
            PdfError::ConversionFailed(_) => ErrorCode::ConversionFailed,
            PdfError::ProcessingFailed(_) => ErrorCode::ProcessingFailed,
            PdfError::Internal(_) => ErrorCode::Internal,
        }
    }

    pub fn from_io(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => PdfError::NotFound(err.to_string()),
            std::io::ErrorKind::PermissionDenied => PdfError::PermissionDenied(err.to_string()),
            std::io::ErrorKind::StorageFull => PdfError::DiskFull,
            _ => {
                let msg = err.to_string();
                if msg.contains("being used by another process") || msg.contains("os error 32") {
                    PdfError::FileLocked(msg)
                } else {
                    PdfError::Internal(msg)
                }
            }
        }
    }

    /// Maps a lopdf error to a user-facing error. Inspects the raw bytes only
    /// when the error type alone is ambiguous.
    pub fn from_lopdf(err: lopdf::Error, path: Option<&Path>) -> Self {
        let msg = err.to_string();
        if let Some(p) = path {
            if !p.exists() {
                return PdfError::NotFound(p.display().to_string());
            }
        }
        let lower = msg.to_lowercase();
        if lower.contains("password") {
            return PdfError::PasswordRequired;
        }
        if lower.contains("encrypt") {
            return PdfError::PasswordRequired;
        }
        PdfError::InvalidPdf(msg)
    }
}

pub type PdfResult<T> = Result<T, PdfError>;

impl From<lopdf::Error> for PdfError {
    fn from(err: lopdf::Error) -> Self {
        PdfError::from_lopdf(err, None)
    }
}

impl From<std::io::Error> for PdfError {
    fn from(err: std::io::Error) -> Self {
        PdfError::from_io(err)
    }
}

impl Serialize for PdfError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("PdfError", 2)?;
        s.serialize_field("code", &self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

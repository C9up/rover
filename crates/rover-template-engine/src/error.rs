//! `Error` — the engine error type. Only the three codes the Rust engine can
//! actually emit live here. The TS facade owns the filesystem-bound codes
//! (`E_MAIL_TEMPLATE_NOT_FOUND` on a missing root template / `E_MAIL_TEMPLATE_READ_ERROR`)
//! and the loader code (`E_MAIL_TEMPLATE_NAPI_REQUIRED`); those never originate in
//! Rust. `NotFound` here covers only the render-time "partial absent from the
//! pre-resolved map" path (an inline `render` source referencing a partial that
//! does not exist), mapped back to the same TS `E_MAIL_TEMPLATE_NOT_FOUND` code.
//!
//! `as_str()` is the byte-stable code the NAPI boundary serialises into the
//! error JSON envelope so the TS side can reconstruct a `ReamError` with the
//! correct `code`.

use serde::Serialize;

#[derive(Debug, Clone, thiserror::Error)]
#[error("[{}] {message}", code.as_str())]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorCode {
    Syntax,
    Recursion,
    NotFound,
}

impl ErrorCode {
    /// The TS-side `ReamError` code string. Stable across the NAPI boundary.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Syntax => "E_MAIL_TEMPLATE_SYNTAX",
            ErrorCode::Recursion => "MAIL_TEMPLATE_RECURSION",
            ErrorCode::NotFound => "E_MAIL_TEMPLATE_NOT_FOUND",
        }
    }
}

impl Error {
    pub fn syntax(message: impl Into<String>) -> Self {
        Self { code: ErrorCode::Syntax, message: message.into() }
    }

    pub fn recursion(message: impl Into<String>) -> Self {
        Self { code: ErrorCode::Recursion, message: message.into() }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self { code: ErrorCode::NotFound, message: message.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_strings_are_byte_stable() {
        assert_eq!(ErrorCode::Syntax.as_str(), "E_MAIL_TEMPLATE_SYNTAX");
        assert_eq!(ErrorCode::Recursion.as_str(), "MAIL_TEMPLATE_RECURSION");
        assert_eq!(ErrorCode::NotFound.as_str(), "E_MAIL_TEMPLATE_NOT_FOUND");
    }
}

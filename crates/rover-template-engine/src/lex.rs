//! Tokeniser — ports `SimpleTemplate.ts:tokenise` (lines 154-253) verbatim.
//!
//! Six token kinds: `text`, `interp`, `raw_interp`, `if_open`, `if_close`,
//! `partial`. `{{{` wins over `{{` at the same index. Line numbers are tracked
//! by counting `\n` exactly as the TS `countNewlines` helper does, so syntax
//! errors carry the same line numbers the suite asserts
//! (`simple-template.test.ts:212-219` → `/line 2/`).
//!
//! Delimiters are all ASCII, so byte-offset slicing (`str::find`) always lands
//! on UTF-8 char boundaries even when the surrounding text is multi-byte.

use crate::error::Error;
use crate::identifiers::{is_valid_identifier, is_valid_partial_name};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Text,
    Interp,
    RawInterp,
    IfOpen,
    IfClose,
    Partial,
}

#[derive(Debug, Clone)]
pub struct Token {
    pub kind: TokenKind,
    pub value: String,
    pub line: u32,
    /// Byte offset of the token start (informational; used in the defensive
    /// "Unexpected token near position" message only).
    pub start: usize,
}

fn count_newlines(s: &str) -> u32 {
    s.bytes().filter(|&b| b == b'\n').count() as u32
}

fn assert_identifier(expr: &str, line: u32) -> Result<(), Error> {
    if !is_valid_identifier(expr) {
        return Err(Error::syntax(format!(
            "Invalid identifier \"{expr}\" at line {line}."
        )));
    }
    Ok(())
}

pub fn tokenise(source: &str) -> Result<Vec<Token>, Error> {
    let mut tokens: Vec<Token> = Vec::new();
    let mut i: usize = 0;
    let mut line: u32 = 1;
    let len = source.len();

    while i < len {
        // Find the next `{{` ONCE (O(n) total as `i` advances), then decide raw
        // vs double by a cheap `starts_with("{{{")` at that position. This is
        // exactly equivalent to the TS `indexOf("{{{")` / `indexOf("{{")` pair —
        // a `{{{` always sits at the same index as the next `{{`, so raw wins
        // iff the next `{{` is the start of a `{{{` — but avoids the O(n²) blow-up
        // where `indexOf("{{{")` rescans to EOF on every `{{`-only iteration.
        let next_open = source[i..].find("{{").map(|p| i + p);

        let next_open = match next_open {
            None => {
                if i < len {
                    let value = &source[i..];
                    tokens.push(Token {
                        kind: TokenKind::Text,
                        value: value.to_string(),
                        line,
                        start: i,
                    });
                    // (no `line +=` here: this is the final text run before EOF,
                    // the line counter is never read again — keeping the dead
                    // assignment would only trip `unused_assignments`.)
                }
                break;
            }
            Some(n) => n,
        };

        if next_open > i {
            let value = &source[i..next_open];
            tokens.push(Token {
                kind: TokenKind::Text,
                value: value.to_string(),
                line,
                start: i,
            });
            line += count_newlines(value);
        }

        let raw = source[next_open..].starts_with("{{{");
        let open_len = if raw { 3 } else { 2 };
        let close_pat = if raw { "}}}" } else { "}}" };
        let search_from = next_open + open_len;
        let close = source[search_from..]
            .find(close_pat)
            .map(|p| search_from + p);
        let close = match close {
            None => {
                return Err(Error::syntax(format!(
                    "Unterminated tag starting at line {line}"
                )));
            }
            Some(c) => c,
        };

        let body_start = next_open + open_len;
        let body_text = source[body_start..close].trim();
        if body_text.is_empty() {
            return Err(Error::syntax(format!("Empty tag at line {line}")));
        }

        let tag_line = line;
        if raw {
            assert_identifier(body_text, tag_line)?;
            tokens.push(Token {
                kind: TokenKind::RawInterp,
                value: body_text.to_string(),
                line: tag_line,
                start: next_open,
            });
        } else if let Some(after) = body_text.strip_prefix("#if") {
            let expr = after.trim();
            assert_identifier(expr, tag_line)?;
            tokens.push(Token {
                kind: TokenKind::IfOpen,
                value: expr.to_string(),
                line: tag_line,
                start: next_open,
            });
        } else if body_text == "/if" {
            tokens.push(Token {
                kind: TokenKind::IfClose,
                value: String::new(),
                line: tag_line,
                start: next_open,
            });
        } else if let Some(after) = body_text.strip_prefix('>') {
            let name = after.trim();
            if name.is_empty() {
                return Err(Error::syntax(format!(
                    "Partial name is empty at line {tag_line}. Use {{{{> name}}}}."
                )));
            }
            if !is_valid_partial_name(name) {
                return Err(Error::syntax(format!(
                    "Invalid partial name \"{name}\" at line {tag_line}."
                )));
            }
            tokens.push(Token {
                kind: TokenKind::Partial,
                value: name.to_string(),
                line: tag_line,
                start: next_open,
            });
        } else {
            assert_identifier(body_text, tag_line)?;
            tokens.push(Token {
                kind: TokenKind::Interp,
                value: body_text.to_string(),
                line: tag_line,
                start: next_open,
            });
        }

        let consumed_end = close + open_len;
        line += count_newlines(&source[next_open..consumed_end]);
        i = consumed_end;
    }

    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(src: &str) -> Vec<TokenKind> {
        tokenise(src).unwrap().into_iter().map(|t| t.kind).collect()
    }

    #[test]
    fn plain_text_is_one_token() {
        assert_eq!(kinds("hello"), vec![TokenKind::Text]);
    }

    #[test]
    fn interp_and_raw_and_if_and_partial() {
        assert_eq!(
            kinds("a{{ x }}b{{{ y }}}c{{#if z}}d{{/if}}{{> p}}"),
            vec![
                TokenKind::Text,
                TokenKind::Interp,
                TokenKind::Text,
                TokenKind::RawInterp,
                TokenKind::Text,
                TokenKind::IfOpen,
                TokenKind::Text,
                TokenKind::IfClose,
                TokenKind::Partial,
            ]
        );
    }

    #[test]
    fn triple_brace_wins_over_double() {
        let toks = tokenise("{{{ raw }}}").unwrap();
        assert_eq!(toks.len(), 1);
        assert_eq!(toks[0].kind, TokenKind::RawInterp);
        assert_eq!(toks[0].value, "raw");
    }

    #[test]
    fn unterminated_tag_reports_line() {
        let err = tokenise("ok\n{{ x ").unwrap_err();
        assert_eq!(err.code.as_str(), "E_MAIL_TEMPLATE_SYNTAX");
        assert!(err.message.contains("line 2"), "got: {}", err.message);
    }

    #[test]
    fn empty_partial_name_is_syntax_error() {
        let err = tokenise("{{> }}").unwrap_err();
        assert_eq!(err.code.as_str(), "E_MAIL_TEMPLATE_SYNTAX");
    }

    #[test]
    fn double_dot_path_is_syntax_error() {
        let err = tokenise("{{ user..email }}").unwrap_err();
        assert_eq!(err.code.as_str(), "E_MAIL_TEMPLATE_SYNTAX");
    }

    #[test]
    fn line_tracking_across_text_with_newlines() {
        // `#if` opens on line 2 — the value the unclosed-block message reports.
        let toks = tokenise("line1\nline2 {{#if foo}}nope").unwrap();
        let if_open = toks.iter().find(|t| t.kind == TokenKind::IfOpen).unwrap();
        assert_eq!(if_open.line, 2);
    }
}

//! Identifier + partial-name validators and the prototype-pollution key
//! denylist.
//!
//! Mirrors `packages/rover/src/templating/SimpleTemplate.ts` 1:1:
//!   - `IDENT`           dot-path identifier (interp / raw / `#if` condition)
//!   - partial-name      `{{> name}}` token shape
//!   - `RESERVED_KEYS`   own-property dot-path denylist
//!
//! These are hand-rolled char scans rather than compiled regexes: the parser
//! validates an identifier on EVERY tag, so a regex engine invocation per tag
//! dominated `compile`. The scans are byte-for-byte equivalent to the TS
//! regexes (ASCII classes only).

/// Byte-for-byte equivalent of
/// `^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$` — a non-empty
/// dot-path where every segment is a JS-ish identifier (no empty segments, so
/// `user..email`, `.x` and `x.` are all rejected).
pub fn is_valid_identifier(name: &str) -> bool {
    let mut had_segment = false;
    for segment in name.split('.') {
        had_segment = true;
        let mut chars = segment.chars();
        match chars.next() {
            Some(c) if c == '_' || c.is_ascii_alphabetic() => {}
            _ => return false,
        }
        if !chars.all(|c| c == '_' || c.is_ascii_alphanumeric()) {
            return false;
        }
    }
    had_segment
}

/// Byte-for-byte equivalent of `^[A-Za-z_][A-Za-z0-9_/-]*$` — the `{{> name}}`
/// partial-name shape (allows `/` and `-` for nested partial directories).
pub fn is_valid_partial_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c == '_' || c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c == '_' || c == '/' || c == '-' || c.is_ascii_alphanumeric())
}

/// Dot-path keys refused outright — prototype-chain escalation vectors. Mirrors
/// the TS `RESERVED_KEYS` set.
pub fn is_reserved_key(name: &str) -> bool {
    matches!(name, "__proto__" | "prototype" | "constructor")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ident_accepts_dot_paths() {
        assert!(is_valid_identifier("name"));
        assert!(is_valid_identifier("user.email"));
        assert!(is_valid_identifier("_x9.y_z"));
    }

    #[test]
    fn ident_rejects_double_dot_and_leading_digit() {
        assert!(!is_valid_identifier("user..email"));
        assert!(!is_valid_identifier("9bad"));
        assert!(!is_valid_identifier(".x"));
        assert!(!is_valid_identifier("x."));
        assert!(!is_valid_identifier(""));
        assert!(!is_valid_identifier("a-b"));
    }

    #[test]
    fn partial_name_allows_slash_and_dash() {
        assert!(is_valid_partial_name("footer"));
        assert!(is_valid_partial_name("emails/footer"));
        assert!(is_valid_partial_name("foo-bar"));
        assert!(!is_valid_partial_name("9bad"));
        assert!(!is_valid_partial_name("with space"));
        assert!(!is_valid_partial_name(""));
    }

    #[test]
    fn reserved_keys_blocked() {
        assert!(is_reserved_key("__proto__"));
        assert!(is_reserved_key("constructor"));
        assert!(is_reserved_key("prototype"));
        assert!(!is_reserved_key("name"));
    }
}

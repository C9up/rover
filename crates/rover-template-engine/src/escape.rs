// PATTERN: structurally mirrors `packages/inker/crates/inker-engine/src/escape.rs`,
// but the BYTE MAP is rover's OWN 7-char set — NOT a copy of inker's (D55.2.5).
// Story 55.5 (extract a shared `c9up-escape` crate) was dismissed: every package
// owns its escape map (agnostic invariant; `project_package_extraction`).
//
// Byte-identical to `packages/rover/src/templating/SimpleTemplate.ts:escapeHtml`,
// applied in the SAME order (`&` first to avoid double-encoding):
//   &  -> &amp;
//   <  -> &lt;
//   >  -> &gt;
//   "  -> &quot;
//   '  -> &#39;
//   /  -> &#x2F;
//   `  -> &#x60;
//
// NOTE: rover's set has `/` and backtick-as-`&#x60;`, and LACKS U+2028/U+2029 —
// the opposite of inker's 8-char set (which has the line separators + backtick
// as `&#96;` and no `/`). The `/` and backtick escaping is a locked security
// contract (`tests/unit/simple-template.test.ts:203-210`: `</script>` ->
// `&lt;&#x2F;script&gt;`).

/// HTML-text-context escape — replaces the 7 chars listed above, `&` first.
pub fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    escape_into(&mut out, s);
    out
}

/// Escape `s` directly into `out` — the render hot path uses this to avoid the
/// per-interpolation intermediate `String` allocation that `escape_text` would
/// incur (escape + a separate `push_str` copy into the output buffer).
pub fn escape_into(out: &mut String, s: &str) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '/' => out.push_str("&#x2F;"),
            '`' => out.push_str("&#x60;"),
            _ => out.push(ch),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_through_ascii_safe() {
        assert_eq!(escape_text("hello world 123"), "hello world 123");
    }

    #[test]
    fn ampersand_first_to_avoid_double_encoding() {
        // `&` MUST be replaced first, otherwise the `&` it introduces gets
        // re-escaped. Pins the order parity with the TS `.replace(/&/g, ...)`
        // chain that runs first.
        assert_eq!(escape_text("A & B"), "A &amp; B");
        assert_eq!(escape_text("&amp;"), "&amp;amp;");
    }

    #[test]
    fn angle_brackets() {
        assert_eq!(escape_text("<script>"), "&lt;script&gt;");
    }

    #[test]
    fn double_and_single_quotes() {
        assert_eq!(escape_text("\"x\""), "&quot;x&quot;");
        assert_eq!(escape_text("'x'"), "&#39;x&#39;");
    }

    #[test]
    fn slash_to_hex_entity() {
        // Defense-in-depth: closing a `<script>` block via `</script>` is the
        // canonical break-out, so `/` is escaped. Locked byte (AC6 / AC-E5).
        assert_eq!(escape_text("</script>"), "&lt;&#x2F;script&gt;");
    }

    #[test]
    fn backtick_to_hex_entity() {
        // Rover uses `&#x60;` (hex) — NOT inker's `&#96;` (decimal). Pinning the
        // exact byte sequence the suite locks (`simple-template.test.ts:207`).
        assert_eq!(escape_text("`backtick`"), "&#x60;backtick&#x60;");
    }

    #[test]
    fn line_separators_are_not_escaped() {
        // Unlike inker, rover does NOT escape U+2028/U+2029 — they pass through.
        assert_eq!(escape_text("\u{2028}\u{2029}"), "\u{2028}\u{2029}");
    }

    #[test]
    fn full_seven_char_map_in_order() {
        assert_eq!(
            escape_text("&<>\"'/`"),
            "&amp;&lt;&gt;&quot;&#39;&#x2F;&#x60;"
        );
    }
}

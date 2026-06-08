//! Interpreter — ports `SimpleTemplate.ts:interpret` (299-321) + `resolve`
//! (330-341) + `truthy` (343-346), with one deliberate structural change baked
//! by D55.2.1/D55.2.2:
//!
//! Partials are NOT read from disk here (the engine never touches the
//! filesystem — ADR-007). The TS facade pre-resolves every reachable partial
//! into `partials: name -> Ir` and passes it in. Render-time recursion is
//! detected HERE via a `visited` name set (insert before descending into a
//! partial, remove after) so that:
//!   - a cyclic partial chain that is actually rendered raises
//!     `MAIL_TEMPLATE_RECURSION` (self-recursion + mutual `a -> b -> a`), and
//!   - a `{{> loop}}` behind a falsy `{{#if}}` never renders, so never errors.
//!
//! The backtracking (remove-after) gives path semantics: the same partial
//! referenced twice in sequence is fine; only a true cycle errors — matching
//! the per-branch `new Set(visited)` copy the TS engine used.

use crate::error::Error;
use crate::escape;
use crate::identifiers::is_reserved_key;
use crate::{Ir, IrNode};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

pub fn render_ir(
    ir: &Ir,
    data: &Value,
    partials: &HashMap<String, Ir>,
) -> Result<String, Error> {
    let mut out = String::new();
    let mut visited: HashSet<String> = HashSet::new();
    render_nodes(&ir.nodes, data, partials, &mut visited, &mut out, 0)?;
    Ok(out)
}

/// Guards against a Rust stack overflow (which would abort the Node process,
/// since `catch_unwind` cannot catch it) from pathologically deep `{{#if}}`
/// nesting or partial chains. The pre-migration TS engine threw a catchable
/// `RangeError`; this keeps the failure a clean, catchable engine error.
const MAX_RENDER_DEPTH: u32 = 512;

fn render_nodes(
    nodes: &[IrNode],
    data: &Value,
    partials: &HashMap<String, Ir>,
    visited: &mut HashSet<String>,
    out: &mut String,
    depth: u32,
) -> Result<(), Error> {
    if depth > MAX_RENDER_DEPTH {
        return Err(Error::syntax(format!(
            "Template nesting exceeds the maximum depth of {MAX_RENDER_DEPTH} ({{#if}} blocks or partial chain too deep)"
        )));
    }
    for node in nodes {
        match node {
            IrNode::Text(value) => out.push_str(value),
            IrNode::Interp { path, raw } => {
                // Fast path: a resolved string is escaped (or copied) straight
                // into `out` with no intermediate allocation. Other JSON shapes
                // go through `js_string` first (String(v) parity).
                match resolve(data, path).as_deref() {
                    None | Some(Value::Null) => {}
                    Some(Value::String(s)) => {
                        if *raw {
                            out.push_str(s);
                        } else {
                            escape::escape_into(out, s);
                        }
                    }
                    Some(v) => {
                        let rendered = js_string(v);
                        if *raw {
                            out.push_str(&rendered);
                        } else {
                            escape::escape_into(out, &rendered);
                        }
                    }
                }
            }
            IrNode::If { path, body } => {
                if truthy(resolve(data, path).as_deref()) {
                    render_nodes(body, data, partials, visited, out, depth + 1)?;
                }
            }
            IrNode::Partial { name } => {
                if visited.contains(name) {
                    return Err(Error::recursion(format!(
                        "Template partial \"{name}\" recurses into itself (cycle detected)"
                    )));
                }
                match partials.get(name) {
                    Some(partial_ir) => {
                        visited.insert(name.clone());
                        render_nodes(&partial_ir.nodes, data, partials, visited, out, depth + 1)?;
                        visited.remove(name);
                    }
                    None => {
                        return Err(Error::not_found(format!(
                            "Template partial \"{name}\" was not provided to the renderer"
                        )));
                    }
                }
            }
        }
    }
    Ok(())
}

/// Safe dot-path lookup. Own-property only, rejects the prototype-pollution
/// keys, stops at any non-object intermediate (yielding `None` = `undefined`).
/// Note: the identifier grammar rejects digit-leading segments, so numeric array
/// indices like `items.0` never reach here (they fail at parse); the `Value::Array`
/// arm below only fires if that grammar is relaxed. The named array property
/// `.length` is resolved to the element count as a synthesized number (parity
/// with the pre-migration engine, which returned `arr.length` via `Object.hasOwn`);
/// it is the one path segment that yields an owned value, hence the `Cow`.
fn resolve<'a>(data: &'a Value, dot_path: &str) -> Option<Cow<'a, Value>> {
    let mut current = data;
    let mut segments = dot_path.split('.').peekable();
    while let Some(key) = segments.next() {
        match current {
            Value::Object(map) => {
                if is_reserved_key(key) {
                    return None;
                }
                current = map.get(key)?;
            }
            Value::Array(arr) => {
                if key == "length" {
                    // `arr.length` is a terminal number; any further segment
                    // (`items.length.x`) resolves against a number → undefined.
                    return segments
                        .peek()
                        .is_none()
                        .then(|| Cow::Owned(Value::Number(arr.len().into())));
                }
                match key.parse::<usize>() {
                    Ok(idx) => current = arr.get(idx)?,
                    Err(_) => return None,
                }
            }
            _ => return None,
        }
    }
    Some(Cow::Borrowed(current))
}

/// `truthy` parity: empty array is falsy, otherwise JS `Boolean(v)` semantics.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::Object(_)) => true,
    }
}

/// `String(v)` parity for interpolation. `null`/`undefined` are handled by the
/// caller (rendered as `""`); this covers the remaining JSON value shapes.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|e| match e {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::compile;
    use serde_json::json;

    fn render(src: &str, data: Value) -> Result<String, Error> {
        let ir = compile(src).unwrap();
        render_ir(&ir, &data, &HashMap::new())
    }

    #[test]
    fn interpolates_and_escapes() {
        assert_eq!(render("Hi {{ name }}", json!({"name":"Ada"})).unwrap(), "Hi Ada");
        assert_eq!(
            render("{{ name }}", json!({"name":"<script>"})).unwrap(),
            "&lt;script&gt;"
        );
    }

    #[test]
    fn raw_is_not_escaped() {
        assert_eq!(
            render("{{{ html }}}", json!({"html":"<b>hi</b>"})).unwrap(),
            "<b>hi</b>"
        );
    }

    #[test]
    fn array_length_resolves_to_count() {
        // Parity with the pre-migration engine: `arr.length` yields the element count.
        assert_eq!(
            render("{{ items.length }}", json!({"items":[1,2,3]})).unwrap(),
            "3"
        );
        // Empty array → "0", and length drives `{{#if}}` truthiness like a number.
        assert_eq!(
            render("{{ items.length }}", json!({"items":[]})).unwrap(),
            "0"
        );
        assert_eq!(
            render("{{#if items.length}}has{{/if}}", json!({"items":[1]})).unwrap(),
            "has"
        );
        assert_eq!(
            render("{{#if items.length}}has{{/if}}", json!({"items":[]})).unwrap(),
            ""
        );
        // A segment past `.length` resolves against a number → undefined (empty).
        assert_eq!(
            render("{{ items.length.x }}", json!({"items":[1,2]})).unwrap(),
            ""
        );
    }

    #[test]
    fn dot_path_and_missing() {
        assert_eq!(
            render("{{ user.email }}", json!({"user":{"email":"a@b.co"}})).unwrap(),
            "a@b.co"
        );
        assert_eq!(render("Hello {{ name }}!", json!({})).unwrap(), "Hello !");
    }

    #[test]
    fn conditionals() {
        assert_eq!(render("{{#if show}}Y{{/if}}", json!({"show":true})).unwrap(), "Y");
        assert_eq!(render("{{#if show}}Y{{/if}}", json!({"show":false})).unwrap(), "");
        assert_eq!(render("{{#if missing}}N{{/if}}", json!({})).unwrap(), "");
        // empty array is falsy
        assert_eq!(render("{{#if xs}}Y{{/if}}", json!({"xs":[]})).unwrap(), "");
        assert_eq!(render("{{#if xs}}Y{{/if}}", json!({"xs":[1]})).unwrap(), "Y");
    }

    #[test]
    fn proto_pollution_keys_blocked() {
        let data = json!({"name":"Ada"});
        assert_eq!(render("{{ __proto__.x }}", data.clone()).unwrap(), "");
        assert_eq!(render("{{ constructor.name }}", data.clone()).unwrap(), "");
        assert_eq!(render("{{ name }}", data).unwrap(), "Ada");
    }

    #[test]
    fn self_recursion_errors_when_rendered() {
        let root = compile("body {{> loop}}").unwrap();
        let mut partials = HashMap::new();
        partials.insert("loop".to_string(), compile("body {{> loop}}").unwrap());
        let err = render_ir(&root, &json!({}), &partials).unwrap_err();
        assert_eq!(err.code.as_str(), "MAIL_TEMPLATE_RECURSION");
    }

    #[test]
    fn mutual_recursion_errors() {
        let root = compile("A {{> b}}").unwrap();
        let mut partials = HashMap::new();
        partials.insert("b".to_string(), compile("B {{> a}}").unwrap());
        partials.insert("a".to_string(), compile("A {{> b}}").unwrap());
        let err = render_ir(&root, &json!({}), &partials).unwrap_err();
        assert_eq!(err.code.as_str(), "MAIL_TEMPLATE_RECURSION");
    }

    #[test]
    fn cycle_behind_falsy_if_does_not_error() {
        // The partial reference is never reached (the `{{#if}}` is falsy), so no
        // recursion error — the data-dependent semantics the suite locks.
        let root = compile("{{#if never}}{{> loop}}{{/if}}done").unwrap();
        let mut partials = HashMap::new();
        partials.insert("loop".to_string(), compile("{{> loop}}").unwrap());
        assert_eq!(
            render_ir(&root, &json!({"never":false}), &partials).unwrap(),
            "done"
        );
    }

    #[test]
    fn same_partial_twice_in_sequence_is_fine() {
        let root = compile("{{> foo}}{{> foo}}").unwrap();
        let mut partials = HashMap::new();
        partials.insert("foo".to_string(), compile("x").unwrap());
        assert_eq!(render_ir(&root, &json!({}), &partials).unwrap(), "xx");
    }

    #[test]
    fn renders_partial_from_map() {
        let root = compile("Greet: {{> footer}}").unwrap();
        let mut partials = HashMap::new();
        partials.insert("footer".to_string(), compile("bye {{ name }}").unwrap());
        assert_eq!(
            render_ir(&root, &json!({"name":"Ada"}), &partials).unwrap(),
            "Greet: bye Ada"
        );
    }
}

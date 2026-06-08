//! `rover-template-engine` — pure-Rust port of rover's `SimpleTemplate` hot path
//! (tokenise -> parse -> IR -> interpret). No `napi` dependency, no filesystem
//! access: the TS facade (`packages/rover/src/templating/SimpleTemplate.ts`)
//! owns path resolution, the FS read, the compiled-IR cache, and the transitive
//! partial pre-resolution (D55.2.1). This crate is the CPU-bound core.
//!
//! Agnostic invariant: this crate links to ZERO inker code. It mirrors the
//! inker 55.1 crate SHAPE only (escape module, identifier guards, error enum,
//! IR-handle render contract); the bytes are rover's own.

pub mod error;
pub mod escape;
pub mod identifiers;
pub mod lex;
pub mod parse;
pub mod render;

pub use error::{Error, ErrorCode};
pub use parse::compile;
pub use render::render_ir;

/// One IR node. Byte-for-byte the union from `SimpleTemplate.ts:5-9`.
#[derive(Debug, Clone, PartialEq)]
pub enum IrNode {
    Text(String),
    Interp { path: String, raw: bool },
    If { path: String, body: Vec<IrNode> },
    Partial { name: String },
}

/// A compiled template — the node list `compile` produces and `render_ir`
/// consumes. Wrapped in an `Arc` behind the NAPI handle so the JS GC drop frees
/// it automatically (D55.1.3 precedent).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Ir {
    pub nodes: Vec<IrNode>,
}

/// Walk an IR (descending into `{{#if}}` bodies) and collect every referenced
/// partial name, in document order. The TS facade uses this — via the NAPI
/// `partialNames` getter — to drive transitive partial pre-resolution without
/// having to walk the opaque native IR itself.
pub fn collect_partial_names(ir: &Ir) -> Vec<String> {
    let mut out = Vec::new();
    collect(&ir.nodes, &mut out);
    out
}

fn collect(nodes: &[IrNode], out: &mut Vec<String>) {
    for node in nodes {
        match node {
            IrNode::Partial { name } => out.push(name.clone()),
            IrNode::If { body, .. } => collect(body, out),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_partial_names_descends_into_if_bodies() {
        let ir = compile("{{> a}}{{#if x}}{{> b}}{{/if}}{{ y }}").unwrap();
        assert_eq!(collect_partial_names(&ir), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn empty_template_has_no_partials() {
        let ir = compile("just text {{ x }}").unwrap();
        assert!(collect_partial_names(&ir).is_empty());
    }
}

//! Parser — ports `SimpleTemplate.ts:compile` (136-145) + `parseBlock`
//! (255-297) verbatim. Folds the flat token stream into the nested `Ir`
//! (text / interp / if / partial), with `{{#if}}` blocks recursively nested.

use crate::error::Error;
use crate::lex::{tokenise, Token, TokenKind};
use crate::{Ir, IrNode};

pub fn compile(source: &str) -> Result<Ir, Error> {
    let tokens = tokenise(source)?;
    let (nodes, index) = parse_block(&tokens, 0, None, 1, 0)?;
    if index != tokens.len() {
        let pos = tokens.get(index).map(|t| t.start).unwrap_or(0);
        return Err(Error::syntax(format!(
            "Unexpected token near position {pos}"
        )));
    }
    Ok(Ir { nodes })
}

/// Bounds compile-time recursion on nested `{{#if}}` blocks so a pathological
/// template cannot overflow the Rust stack (an uncatchable process abort across
/// the FFI boundary). The pre-migration TS parser threw a catchable `RangeError`.
const MAX_PARSE_DEPTH: u32 = 512;

fn parse_block(
    tokens: &[Token],
    start: usize,
    terminator: Option<TokenKind>,
    open_line: u32,
    depth: u32,
) -> Result<(Vec<IrNode>, usize), Error> {
    if depth > MAX_PARSE_DEPTH {
        return Err(Error::syntax(format!(
            "Template `{{#if}}` nesting exceeds the maximum depth of {MAX_PARSE_DEPTH}"
        )));
    }
    let mut nodes: Vec<IrNode> = Vec::new();
    let mut i = start;
    while i < tokens.len() {
        let tok = &tokens[i];
        if let Some(term) = terminator {
            if tok.kind == term {
                return Ok((nodes, i + 1));
            }
        }
        match tok.kind {
            TokenKind::Text => {
                nodes.push(IrNode::Text(tok.value.clone()));
                i += 1;
            }
            TokenKind::Interp => {
                nodes.push(IrNode::Interp {
                    path: tok.value.clone(),
                    raw: false,
                });
                i += 1;
            }
            TokenKind::RawInterp => {
                nodes.push(IrNode::Interp {
                    path: tok.value.clone(),
                    raw: true,
                });
                i += 1;
            }
            TokenKind::Partial => {
                nodes.push(IrNode::Partial {
                    name: tok.value.clone(),
                });
                i += 1;
            }
            TokenKind::IfOpen => {
                let inner_open_line = tok.line;
                let (inner_nodes, inner_index) = parse_block(
                    tokens,
                    i + 1,
                    Some(TokenKind::IfClose),
                    inner_open_line,
                    depth + 1,
                )?;
                nodes.push(IrNode::If {
                    path: tok.value.clone(),
                    body: inner_nodes,
                });
                i = inner_index;
            }
            TokenKind::IfClose => {
                return Err(Error::syntax(format!(
                    "Unexpected {{{{/if}}}} at line {} with no matching {{{{#if}}}}.",
                    tok.line
                )));
            }
        }
    }
    if terminator == Some(TokenKind::IfClose) {
        return Err(Error::syntax(format!(
            "Unclosed {{{{#if}}}} block starting at line {open_line} — missing {{{{/if}}}}."
        )));
    }
    Ok((nodes, i))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_nested_if() {
        let ir = compile("a{{#if x}}b{{ y }}{{/if}}c").unwrap();
        assert_eq!(
            ir.nodes,
            vec![
                IrNode::Text("a".into()),
                IrNode::If {
                    path: "x".into(),
                    body: vec![
                        IrNode::Text("b".into()),
                        IrNode::Interp {
                            path: "y".into(),
                            raw: false
                        },
                    ],
                },
                IrNode::Text("c".into()),
            ]
        );
    }

    #[test]
    fn unclosed_if_reports_opening_line() {
        let err = compile("line1\nline2 {{#if foo}}nope").unwrap_err();
        assert_eq!(err.code.as_str(), "E_MAIL_TEMPLATE_SYNTAX");
        assert!(err.message.contains("line 2"), "got: {}", err.message);
    }

    #[test]
    fn stray_if_close_is_syntax_error() {
        let err = compile("{{/if}}").unwrap_err();
        assert_eq!(err.code.as_str(), "E_MAIL_TEMPLATE_SYNTAX");
    }

    #[test]
    fn partial_node_carries_name() {
        let ir = compile("{{> footer}}").unwrap();
        assert_eq!(
            ir.nodes,
            vec![IrNode::Partial {
                name: "footer".into()
            }]
        );
    }
}

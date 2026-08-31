// NAPI boundary for `rover-template-engine`. Exposes:
//   - `compile(source) -> RoverIr`            opaque Arc-backed IR handle.
//   - `RoverIr#partialNames` getter           document-ordered partial names,
//                                             so the TS facade drives transitive
//                                             partial pre-resolution (D55.2.1)
//                                             without walking the native IR.
//   - `renderIr(ir, data, partials) -> String` synchronous render with the
//                                             pre-resolved partial-IR map;
//                                             render-time recursion detection
//                                             lives in the engine (D55.2.2).
//   - `engineVersion()`                       startup diagnostic.
//
// Engine `Error` -> `napi::Error`: the message is `JSON.stringify({code,message})`
// so the TS-side `loadNapi.ts` reconstructs a `ReamError` with the right
// `MAIL_TEMPLATE_*` code (line numbers preserved in the message text).
//
// EVERY entry point is wrapped in `wrap()` / `catch_unwind` so an engine panic
// surfaces as a catchable error, not a process abort (inker 55.1 review finding
// — do NOT repeat the unwrapped-entry-point footgun). Mirrors the inker NAPI
// shape; links to zero inker code (agnostic invariant).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rover_template_engine::error::Error as EngineError;
use rover_template_engine::{collect_partial_names, Ir};
use serde::Serialize;
use std::collections::HashMap;
use std::panic::catch_unwind;
use std::sync::Arc;

#[derive(Serialize)]
struct RoverNapiErrorPayload {
    code: String,
    message: String,
}

fn to_napi_error(e: EngineError) -> napi::Error {
    let payload = RoverNapiErrorPayload {
        code: e.code.as_str().to_string(),
        message: e.message.clone(),
    };
    let json = serde_json::to_string(&payload).unwrap_or_else(|_| {
        format!(
            "{{\"code\":\"E_MAIL_TEMPLATE_SYNTAX\",\"message\":{:?}}}",
            e.message
        )
    });
    napi::Error::from_reason(json)
}

fn wrap<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> std::result::Result<T, EngineError> + std::panic::UnwindSafe,
{
    match catch_unwind(f) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(to_napi_error(e)),
        Err(_) => Err(napi::Error::from_reason(
            "{\"code\":\"E_MAIL_TEMPLATE_SYNTAX\",\"message\":\"Internal panic in rover template engine\"}",
        )),
    }
}

/// Opaque handle to a compiled template IR. The TS-side `cache` keeps these
/// instances alive; when the JS GC collects the wrapper, napi-rs drops the
/// inner `Arc` automatically (Arc + GC bridge — no manual dispose API).
#[napi]
pub struct RoverIr {
    inner: Arc<Ir>,
}

#[napi]
impl RoverIr {
    /// Every referenced partial name, in document order (descends into
    /// `{{#if}}` bodies). Drives the TS facade's transitive partial map build.
    #[napi(getter)]
    pub fn partial_names(&self) -> Vec<String> {
        collect_partial_names(&self.inner)
    }
}

/// Compile a template source string into an opaque `RoverIr` handle.
#[napi]
pub fn compile(source: String) -> Result<RoverIr> {
    wrap(move || {
        let ir = rover_template_engine::compile(&source)?;
        Ok(RoverIr { inner: Arc::new(ir) })
    })
}

/// Render a compiled IR against `data` (a JSON string), resolving `{{> name}}`
/// partials from the pre-resolved `partials` map. Render-time recursion ->
/// `MAIL_TEMPLATE_RECURSION`.
///
/// `data` crosses as a JSON STRING (the TS facade calls `JSON.stringify`), not
/// as an object graph: `JSON.stringify` is own-enumerable-only, which preserves
/// the engine's `Object.hasOwn` dot-path contract (inherited prototype-chain
/// props must NOT be visible — `simple-template.test.ts:195-201`). It is also a
/// single native stringify + one Rust parse, instead of napi walking the whole
/// object graph (which would additionally surface inherited enumerable props).
#[napi]
pub fn render_ir(
    ir: &RoverIr,
    data_json: String,
    #[napi(ts_arg_type = "Record<string, RoverIr>")] partials: HashMap<String, ClassInstance<RoverIr>>,
) -> Result<String> {
    let root = ir.inner.clone();
    // Extracting the inner IR from each ClassInstance consumes the napi handles,
    // so it runs OUTSIDE wrap() (the closure must be UnwindSafe — owned Rust
    // data only). Cloning the Arc'd IR is a refcount bump, not a deep copy.
    let partial_map: HashMap<String, Ir> = partials
        .into_iter()
        .map(|(name, handle)| (name, (*handle.inner).clone()))
        .collect();
    wrap(move || {
        let data: serde_json::Value = serde_json::from_str(&data_json)
            .map_err(|e| EngineError::syntax(format!("Invalid render data JSON: {e}")))?;
        rover_template_engine::render_ir(&root, &data, &partial_map)
    })
}

/// Crate version — useful for the TS-side `loadNapi.ts` startup diagnostic.
#[napi]
pub fn engine_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

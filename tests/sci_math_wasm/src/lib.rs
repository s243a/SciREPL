/// sci_math — A toy WASM library demonstrating the SciREPL JSON FFI convention.
///
/// Exports: alloc, dealloc, call (JSON FFI)
/// Functions: add, multiply, fibonacci, factorial, stats, list_functions
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

#[no_mangle]
pub extern "C" fn call(func_ptr: *const c_char, args_ptr: *const c_char) -> *mut c_char {
    let func_name = unsafe { CStr::from_ptr(func_ptr) }.to_str().unwrap_or("");
    let args_json = unsafe { CStr::from_ptr(args_ptr) }.to_str().unwrap_or("{}");
    let args: serde_json::Value = serde_json::from_str(args_json).unwrap_or_default();

    let result = match func_name {
        "add" => {
            let a = args["a"].as_f64().unwrap_or(0.0);
            let b = args["b"].as_f64().unwrap_or(0.0);
            format!(r#"{{"result":{}}}"#, a + b)
        }
        "multiply" => {
            let a = args["a"].as_f64().unwrap_or(0.0);
            let b = args["b"].as_f64().unwrap_or(0.0);
            format!(r#"{{"result":{}}}"#, a * b)
        }
        "fibonacci" => {
            let n = args["n"].as_u64().unwrap_or(0);
            let result = fibonacci(n);
            format!(r#"{{"result":{}}}"#, result)
        }
        "factorial" => {
            let n = args["n"].as_u64().unwrap_or(0);
            let result = factorial(n);
            format!(r#"{{"result":{}}}"#, result)
        }
        "stats" => {
            if let Some(arr) = args["data"].as_array() {
                let values: Vec<f64> = arr.iter().filter_map(|v| v.as_f64()).collect();
                if values.is_empty() {
                    r#"{"error":"empty array"}"#.to_string()
                } else {
                    let count = values.len();
                    let sum: f64 = values.iter().sum();
                    let mean = sum / count as f64;
                    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
                    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                    format!(
                        r#"{{"mean":{},"min":{},"max":{},"sum":{},"count":{}}}"#,
                        mean, min, max, sum, count
                    )
                }
            } else {
                r#"{"error":"missing 'data' array"}"#.to_string()
            }
        }
        "list_functions" => {
            r#"{"functions":["add","multiply","fibonacci","factorial","stats","list_functions"]}"#
                .to_string()
        }
        _ => format!(r#"{{"error":"unknown function: {}"}}"#, func_name),
    };

    CString::new(result).unwrap().into_raw()
}

fn fibonacci(n: u64) -> u64 {
    if n <= 1 {
        return n;
    }
    let (mut a, mut b) = (0u64, 1u64);
    for _ in 2..=n {
        let tmp = a + b;
        a = b;
        b = tmp;
    }
    b
}

fn factorial(n: u64) -> u64 {
    (1..=n).product()
}

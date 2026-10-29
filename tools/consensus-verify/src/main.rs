//! stdin: {"tx": "<hex>", "prevouts": [{"script": "<hex>", "amount": <sats>}, ...], "flags": ["CHECKSEQUENCEVERIFY", ...]}
//! `flags` is optional; by default every consensus flag before taproot is enforced
//! (P2SH, DERSIG, NULLDUMMY, CHECKLOCKTIMEVERIFY, CHECKSEQUENCEVERIFY, WITNESS).
//! `TAPROOT` adds BIPs 341 and 342 (taproot key and script paths). Taproot signatures commit to
//! every spent output, so the verifier always hands libbitcoinconsensus all of them
//! (`bitcoinconsensus_verify_script_with_spent_outputs`); `ALL` is every flag including TAPROOT.
//! Exit codes: 0 if every input verifies, 1 if any input fails, 2 on malformed input.
use std::io::Read;

#[derive(serde::Deserialize)]
struct Prevout {
    script: String,
    amount: u64,
}

#[derive(serde::Deserialize)]
struct Request {
    tx: String,
    prevouts: Vec<Prevout>,
    flags: Option<Vec<String>>,
}

fn flag_bits(names: &[String]) -> Result<u32, String> {
    let mut bits = 0;
    for n in names {
        bits |= match n.as_str() {
            "P2SH" => bitcoinconsensus::VERIFY_P2SH,
            "DERSIG" => bitcoinconsensus::VERIFY_DERSIG,
            "NULLDUMMY" => bitcoinconsensus::VERIFY_NULLDUMMY,
            "CHECKLOCKTIMEVERIFY" => bitcoinconsensus::VERIFY_CHECKLOCKTIMEVERIFY,
            "CHECKSEQUENCEVERIFY" => bitcoinconsensus::VERIFY_CHECKSEQUENCEVERIFY,
            "WITNESS" => bitcoinconsensus::VERIFY_WITNESS,
            "ALL_PRE_TAPROOT" => bitcoinconsensus::VERIFY_ALL_PRE_TAPROOT,
            "TAPROOT" => bitcoinconsensus::VERIFY_TAPROOT,
            "ALL" => bitcoinconsensus::VERIFY_ALL_PRE_TAPROOT | bitcoinconsensus::VERIFY_TAPROOT,
            other => return Err(format!("unknown flag: {other}")),
        };
    }
    Ok(bits)
}

/// Number of inputs in a serialized transaction (handles the segwit marker).
fn input_count(tx: &[u8]) -> Option<u64> {
    let mut rest = tx.get(4..)?;
    if rest.starts_with(&[0x00, 0x01]) {
        rest = &rest[2..];
    }
    match *rest.first()? {
        n @ 0..=0xfc => Some(n as u64),
        0xfd => Some(u16::from_le_bytes(rest.get(1..3)?.try_into().ok()?) as u64),
        _ => None,
    }
}

fn usage_error(msg: &str) -> ! {
    eprintln!("consensus-verify: {msg}");
    std::process::exit(2);
}

fn main() {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        usage_error(&format!("read stdin: {e}"));
    }
    let req: Request = serde_json::from_str(&input).unwrap_or_else(|e| usage_error(&format!("parse request: {e}")));
    let tx = hex::decode(&req.tx).unwrap_or_else(|e| usage_error(&format!("tx hex: {e}")));
    let flags = match &req.flags {
        Some(names) => flag_bits(names).unwrap_or_else(|e| usage_error(&e)),
        None => bitcoinconsensus::VERIFY_ALL_PRE_TAPROOT,
    };
    let scripts: Vec<Vec<u8>> = req
        .prevouts
        .iter()
        .map(|p| hex::decode(&p.script).unwrap_or_else(|e| usage_error(&format!("script hex: {e}"))))
        .collect();
    let utxos: Vec<bitcoinconsensus::Utxo> = scripts
        .iter()
        .zip(&req.prevouts)
        .map(|(s, p)| bitcoinconsensus::Utxo { script_pubkey: s.as_ptr(), script_pubkey_len: s.len() as u32, value: p.amount as i64 })
        .collect();
    // An input without a prevout would silently go unchecked (and taproot needs every spent output).
    if input_count(&tx) != Some(req.prevouts.len() as u64) {
        usage_error(&format!("tx has {:?} inputs but {} prevouts were given", input_count(&tx), req.prevouts.len()));
    }
    let mut ok = true;
    for (i, (script, p)) in scripts.iter().zip(&req.prevouts).enumerate() {
        match bitcoinconsensus::verify_with_flags(script, p.amount, &tx, Some(&utxos), i, flags) {
            Ok(()) => println!("input {i}: ok"),
            // Only a script failure means the spend is invalid; the rest are bad requests.
            Err(bitcoinconsensus::Error::ERR_SCRIPT) => {
                println!("input {i}: FAIL ERR_SCRIPT");
                ok = false;
            }
            Err(e) => usage_error(&format!("input {i}: {e:?}")),
        }
    }
    std::process::exit(if ok { 0 } else { 1 });
}

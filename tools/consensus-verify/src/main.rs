//! stdin: {"tx": "<hex>", "prevouts": [{"script": "<hex>", "amount": <sats>}, ...]}
//! Exits 0 if every input verifies under all consensus flags, 1 otherwise.
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
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("read stdin");
    let req: Request = serde_json::from_str(&input).expect("parse request");
    let tx = hex::decode(&req.tx).expect("tx hex");
    let scripts: Vec<Vec<u8>> = req.prevouts.iter().map(|p| hex::decode(&p.script).expect("script hex")).collect();
    let utxos: Vec<bitcoinconsensus::Utxo> = scripts
        .iter()
        .zip(&req.prevouts)
        .map(|(s, p)| bitcoinconsensus::Utxo { script_pubkey: s.as_ptr(), script_pubkey_len: s.len() as u32, value: p.amount as i64 })
        .collect();
    let mut ok = true;
    for (i, (script, p)) in scripts.iter().zip(&req.prevouts).enumerate() {
        match bitcoinconsensus::verify_with_flags(script, p.amount, &tx, Some(&utxos), i, bitcoinconsensus::VERIFY_ALL_PRE_TAPROOT) {
            Ok(()) => println!("input {i}: ok"),
            Err(e) => {
                println!("input {i}: FAIL {e:?}");
                ok = false;
            }
        }
    }
    std::process::exit(if ok { 0 } else { 1 });
}

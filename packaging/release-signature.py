#!/usr/bin/env python3
"""Trikey's signed releases: the manifest of a release's files, and the check of its signature.

docs/design/signed-releases.md has the design. Python's standard library only (BIP 340 included), so the release jobs,
which hold write tokens, run no package code for it, and anyone can check a release with nothing but Python 3.

A release has, besides its other files:

- trikey-<tag>-SHA256SUMS: one `<sha256>  <name>` line for every other file of the release, sorted by name
  (`sha256sum -c` reads it);
- trikey-<tag>-SHA256SUMS.event.json: a nostr event (kind 1420) signed by Trikey's publisher key, whose `x` tag is the
  manifest's SHA-256. The key is pinned in packaging/release-signer.npub; GitHub never holds its secret half.

Commands:

  manifest --tag <tag> --dir <dir> [--created-at <unix time>]
      Writes <dir>/trikey-<tag>-SHA256SUMS from the files in <dir> and prints the event to sign (JSON, no id,
      pubkey or sig). Used by tools/release/sign-release.mjs.

  check --tag <tag> --dir <dir> [--signer-file <file>]
      Checks <dir>, which holds a release's files: the manifest lists exactly the other files with their hashes, and
      the event is the expected one, signed by the pinned key. Exit 0 when it all holds, 1 when it does not.

The signer file defaults to packaging/release-signer.npub next to this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import time

KIND = 1420
TAG_RE = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9]+)?$")
NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX128 = re.compile(r"^[0-9a-f]{128}$")
# No release was signed before this (2026-11-10); an event dated earlier is not one of ours.
EARLIEST = 1_794_268_800
# A signer's clock may run a little ahead of the checker's.
FUTURE_SLACK = 3600


def manifest_name(tag: str) -> str:
    return f"trikey-{tag}-SHA256SUMS"


def event_name(tag: str) -> str:
    return f"{manifest_name(tag)}.event.json"


def content_line(tag: str) -> str:
    return f"Trikey release {tag}: the files listed in {manifest_name(tag)}"


# --- BIP 340 (Schnorr signatures for secp256k1): verification, as in the BIP's reference code -----------------------

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)


def _tagged_hash(tag: str, msg: bytes) -> bytes:
    t = hashlib.sha256(tag.encode()).digest()
    return hashlib.sha256(t + t + msg).digest()


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    if p1[0] == p2[0] and p1[1] != p2[1]:
        return None
    if p1 == p2:
        lam = (3 * p1[0] * p1[0] * pow(2 * p1[1], P - 2, P)) % P
    else:
        lam = ((p2[1] - p1[1]) * pow(p2[0] - p1[0], P - 2, P)) % P
    x3 = (lam * lam - p1[0] - p2[0]) % P
    return (x3, (lam * (p1[0] - x3) - p1[1]) % P)


def _mul(p, n: int):
    r = None
    for i in range(256):
        if (n >> i) & 1:
            r = _add(r, p)
        p = _add(p, p)
    return r


def _lift_x(x: int):
    if x >= P:
        return None
    y_sq = (pow(x, 3, P) + 7) % P
    y = pow(y_sq, (P + 1) // 4, P)
    if pow(y, 2, P) != y_sq:
        return None
    return (x, y if y & 1 == 0 else P - y)


def schnorr_verify(msg: bytes, pubkey: bytes, sig: bytes) -> bool:
    if len(pubkey) != 32 or len(sig) != 64:
        return False
    pt = _lift_x(int.from_bytes(pubkey, "big"))
    r = int.from_bytes(sig[:32], "big")
    s = int.from_bytes(sig[32:], "big")
    if pt is None or r >= P or s >= N:
        return False
    e = int.from_bytes(_tagged_hash("BIP0340/challenge", sig[:32] + pubkey + msg), "big") % N
    big_r = _add(_mul(G, s), _mul(pt, N - e))
    return big_r is not None and big_r[1] % 2 == 0 and big_r[0] == r


# --- npub (NIP-19, bech32) ------------------------------------------------------------------------------------------

_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values) -> int:
    gen = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk


def npub_to_hex(npub: str) -> str:
    """The 32-byte public key of an npub, as hex. Raises ValueError for anything else."""
    if npub != npub.lower() or not npub.startswith("npub1"):
        raise ValueError("not an npub")
    hrp, data = "npub", npub[5:]
    if any(c not in _CHARSET for c in data) or len(data) < 6:
        raise ValueError("not an npub")
    values = [_CHARSET.index(c) for c in data]
    expanded = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    if _polymod(expanded + values) != 1:  # bech32, not bech32m
        raise ValueError("bad npub checksum")
    acc = bits = 0
    out = bytearray()
    for v in values[:-6]:
        acc = (acc << 5) | v
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xFF)
    if bits >= 5 or (acc & ((1 << bits) - 1)):
        raise ValueError("bad npub padding")
    if len(out) != 32:
        raise ValueError("an npub holds 32 bytes")
    return out.hex()


def read_signer(path: str) -> str:
    """The pinned key: the one npub in the file (lines starting with # are comments), as hex."""
    with open(path, encoding="utf-8") as f:
        lines = [l.strip() for l in f if l.strip() and not l.lstrip().startswith("#")]
    if len(lines) != 1:
        raise ValueError(f"{path} must hold exactly one npub")
    return npub_to_hex(lines[0])


# --- The manifest and the event -------------------------------------------------------------------------------------


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def make_manifest(directory: str, tag: str) -> str:
    """`<sha256>  <name>` for every file in the directory but the manifest and its event, sorted by name."""
    skip = {manifest_name(tag), event_name(tag)}
    lines = []
    for name in sorted(os.listdir(directory)):
        if name in skip:
            continue
        path = os.path.join(directory, name)
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError(f"{name} is not a plain file")
        if not NAME_RE.match(name):
            raise ValueError(f"unexpected file name: {name!r}")
        lines.append(f"{sha256_file(path)}  {name}\n")
    if not lines:
        raise ValueError(f"no release files in {directory}")
    return "".join(lines)


def event_template(tag: str, manifest_sha256: str, created_at: int) -> dict:
    return {
        "kind": KIND,
        "created_at": created_at,
        "tags": [["x", manifest_sha256], ["version", tag]],
        "content": content_line(tag),
    }


def event_id(ev: dict) -> str:
    """NIP-01: the SHA-256 of [0, pubkey, created_at, kind, tags, content] serialized without spaces. The check only
    accepts the exact ASCII tags and content above, so json.dumps gives exactly NIP-01's serialization."""
    data = [0, ev["pubkey"], ev["created_at"], ev["kind"], ev["tags"], ev["content"]]
    return hashlib.sha256(json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def _no_duplicates(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise ValueError(f"the event has {k!r} twice")
        out[k] = v
    return out


def check(directory: str, tag: str, pubkey_hex: str, now: int | None = None) -> list[str]:
    """Every reason the release in `directory` is not validly signed; an empty list when it is."""
    now = int(time.time()) if now is None else now
    if not TAG_RE.match(tag):
        return [f"not a release tag: {tag!r}"]
    mpath = os.path.join(directory, manifest_name(tag))
    epath = os.path.join(directory, event_name(tag))
    missing = [os.path.basename(p) for p in (mpath, epath) if not os.path.isfile(p)]
    if missing:
        return [f"not signed: {' and '.join(missing)} missing. The owner signs with: node tools/release/sign-release.mjs {tag}"]

    errors: list[str] = []
    with open(mpath, "rb") as f:
        manifest = f.read()
    try:
        expected = make_manifest(directory, tag).encode("utf-8")
    except ValueError as e:
        return [str(e)]
    if manifest != expected:
        errors.append(f"{manifest_name(tag)} does not list exactly this release's other files with their SHA-256")
    manifest_sha = hashlib.sha256(manifest).hexdigest()

    try:
        with open(epath, "rb") as f:
            ev = json.loads(f.read().decode("utf-8"), object_pairs_hook=_no_duplicates)
    except (ValueError, UnicodeDecodeError) as e:
        return errors + [f"{event_name(tag)} is not a JSON event: {e}"]
    if not isinstance(ev, dict) or set(ev) != {"id", "pubkey", "created_at", "kind", "tags", "content", "sig"}:
        return errors + [f"{event_name(tag)} does not have exactly the fields of a nostr event"]

    if not (isinstance(ev["pubkey"], str) and HEX64.match(ev["pubkey"])):
        errors.append("pubkey is not 64 lowercase hex digits")
    elif ev["pubkey"] != pubkey_hex:
        errors.append(f"signed by {ev['pubkey']}, not by the pinned key {pubkey_hex}")
    if ev["kind"] != KIND or isinstance(ev["kind"], bool):
        errors.append(f"kind {ev['kind']!r}, not {KIND}")
    ts = ev["created_at"]
    if not isinstance(ts, int) or isinstance(ts, bool) or ts < EARLIEST or ts > now + FUTURE_SLACK:
        errors.append(f"created_at {ts!r} is not a plausible time")
    if ev["tags"] != [["x", manifest_sha], ["version", tag]]:
        errors.append(f"tags are not [[\"x\", <the manifest's SHA-256 {manifest_sha}>], [\"version\", \"{tag}\"]]")
    if ev["content"] != content_line(tag):
        errors.append(f"content is not {content_line(tag)!r}")
    if not (isinstance(ev["id"], str) and HEX64.match(ev["id"])) or not (isinstance(ev["sig"], str) and HEX128.match(ev["sig"])):
        errors.append("id or sig is not lowercase hex of the right length")
    if errors:
        return errors

    if event_id(ev) != ev["id"]:
        return ["the event's id is not the hash of its content"]
    if not schnorr_verify(bytes.fromhex(ev["id"]), bytes.fromhex(ev["pubkey"]), bytes.fromhex(ev["sig"])):
        return ["the signature does not verify"]
    return []


def main(argv: list[str]) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Trikey's signed release manifest (docs/design/signed-releases.md).")
    sub = parser.add_subparsers(dest="command", required=True)
    m = sub.add_parser("manifest", help="write the manifest and print the event to sign")
    m.add_argument("--tag", required=True)
    m.add_argument("--dir", required=True)
    m.add_argument("--created-at", type=int, default=None)
    c = sub.add_parser("check", help="check a release's manifest and signature")
    c.add_argument("--tag", required=True)
    c.add_argument("--dir", required=True)
    c.add_argument("--signer-file", default=os.path.join(here, "release-signer.npub"))
    args = parser.parse_args(argv[1:])

    if not TAG_RE.match(args.tag):
        print(f"Not a release tag: {args.tag!r}", file=sys.stderr)
        return 2

    if args.command == "manifest":
        try:
            text = make_manifest(args.dir, args.tag)
        except (OSError, ValueError) as e:
            print(f"Could not make the manifest: {e}", file=sys.stderr)
            return 2
        with open(os.path.join(args.dir, manifest_name(args.tag)), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        created = int(time.time()) if args.created_at is None else args.created_at
        print(json.dumps(event_template(args.tag, sha, created)))
        return 0

    try:
        pinned = read_signer(args.signer_file)
    except (OSError, ValueError) as e:
        print(f"The pinned key: {e}")
        return 2
    try:
        errors = check(args.dir, args.tag, pinned)
    except OSError as e:
        errors = [str(e)]
    if errors:
        for e in errors:
            print(f"{args.tag}: {e}")
        return 1
    print(f"{args.tag}: {manifest_name(args.tag)} lists every other file, signed by the pinned key {pinned}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

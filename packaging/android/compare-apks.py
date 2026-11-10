#!/usr/bin/env python3
"""Compare two builds of the same APK and say where they differ.

Usage: python3 -I packaging/android/compare-apks.py A.apk B.apk

Used by .github/workflows/android-reproducible.yml, and by anyone checking a build by hand. Standard library only.

An APK is a ZIP file plus a signing block (APK Signature Scheme v2/v3) between the last entry and the central
directory. The APKs compared here are the ones Gradle makes, which Expo's generated project signs with its public
debug key; the release is then re-signed (packaging/android/sign-apk.sh). So this script reports, in this order:

1. whether the two files are byte for byte the same (the only result that counts as reproducible);
2. entries that only one APK has;
3. entries whose content differs (each one's SHA-256 of the uncompressed bytes);
4. entries with the same content but other ZIP metadata (time stamp, compression, attributes, extra field, order);
5. whether the bytes outside the entries differ (the signing block and the rest of the ZIP structure).

Exit status: 0 identical, 1 different, 2 could not read an APK. The report is Markdown, for the job summary.
"""

from __future__ import annotations

import hashlib
import struct
import sys
import zipfile


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def entries(path: str) -> tuple[list[str], dict[str, dict[str, object]]]:
    """Every entry, in archive order, with the SHA-256 of its uncompressed content and its metadata."""
    order: list[str] = []
    info: dict[str, dict[str, object]] = {}
    with zipfile.ZipFile(path) as z:
        for zi in z.infolist():
            h = hashlib.sha256()
            with z.open(zi) as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            order.append(zi.filename)
            info[zi.filename] = {
                "sha256": h.hexdigest(),
                "size": zi.file_size,
                "date_time": zi.date_time,
                "compress_type": zi.compress_type,
                "compress_size": zi.compress_size,
                "external_attr": zi.external_attr,
                "extra": zi.extra.hex(),
                "offset": zi.header_offset,
            }
    return order, info


def outside_entries(path: str) -> bytes:
    """The bytes between the last local entry and the central directory: on an APK, the signing block."""
    with open(path, "rb") as f:
        data = f.read()
    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise ValueError("no end of central directory record")
    (cd_offset,) = struct.unpack_from("<I", data, eocd + 16)
    with zipfile.ZipFile(path) as z:
        last = max(z.infolist(), key=lambda zi: zi.header_offset, default=None)
        if last is None:
            return data[:cd_offset]
        # Local header: 30 bytes, then the name and extra field, then the compressed data (and maybe a data descriptor).
        name_len, extra_len = struct.unpack_from("<HH", data, last.header_offset + 26)
        end = last.header_offset + 30 + name_len + extra_len + last.compress_size
        if last.flag_bits & 0x08:
            end += 16 if data[end:end + 4] == b"PK\x07\x08" else 12
    return data[end:cd_offset]


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    a, b = argv[1], argv[2]
    try:
        hash_a, hash_b = sha256_file(a), sha256_file(b)
        order_a, info_a = entries(a)
        order_b, info_b = entries(b)
        block_a, block_b = outside_entries(a), outside_entries(b)
    except (OSError, ValueError, zipfile.BadZipFile) as e:
        print(f"Could not read the APKs: {e}")
        return 2

    out: list[str] = []
    out.append(f"- A: `{hash_a}` ({len(order_a)} entries)")
    out.append(f"- B: `{hash_b}` ({len(order_b)} entries)")
    if hash_a == hash_b:
        out.append("")
        out.append("**The two APKs are identical, byte for byte.**")
        print("\n".join(out))
        return 0

    out.append("")
    out.append("**The two APKs differ.**")

    only_a = [n for n in order_a if n not in info_b]
    only_b = [n for n in order_b if n not in info_a]
    common = [n for n in order_a if n in info_b]
    content = [n for n in common if info_a[n]["sha256"] != info_b[n]["sha256"]]
    meta_keys = ("date_time", "compress_type", "compress_size", "external_attr", "extra")
    meta = {
        n: [k for k in meta_keys if info_a[n][k] != info_b[n][k]]
        for n in common
        if n not in content
    }
    meta = {n: ks for n, ks in meta.items() if ks}
    same_order = [n for n in order_a if n in info_b] == [n for n in order_b if n in info_a]

    def section(title: str, lines: list[str]) -> None:
        out.append("")
        out.append(f"### {title} ({len(lines)})")
        out.append("")
        if not lines:
            out.append("None.")
            return
        for line in lines[:200]:
            out.append(f"- {line}")
        if len(lines) > 200:
            out.append(f"- ... and {len(lines) - 200} more")

    section("Only in A", [f"`{n}`" for n in only_a])
    section("Only in B", [f"`{n}`" for n in only_b])
    section(
        "Same name, different content",
        [
            f"`{n}`: {info_a[n]['size']} bytes `{str(info_a[n]['sha256'])[:16]}…` / "
            f"{info_b[n]['size']} bytes `{str(info_b[n]['sha256'])[:16]}…`"
            for n in content
        ],
    )
    section("Same content, different ZIP metadata", [f"`{n}`: {', '.join(ks)}" for n, ks in meta.items()])
    out.append("")
    out.append(f"Entry order: {'the same' if same_order else '**different**'}.")
    if block_a == block_b:
        out.append("Bytes outside the entries (the signing block): the same.")
    else:
        out.append(
            f"Bytes outside the entries (the signing block): **different** ({len(block_a)} / {len(block_b)} bytes). "
            "Expected whenever any entry differs, since the signature covers them."
        )
    print("\n".join(out))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

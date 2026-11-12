#!/usr/bin/env python3
"""Compare two builds of the same APK and say where they differ.

Usage: python3 -I packaging/android/compare-apks.py [--ignore-signature] A.apk B.apk

Used by .github/workflows/android-reproducible.yml, and by anyone checking a build by hand. Standard library only.

An APK is a ZIP file plus a signing block (APK Signature Scheme v2/v3) between the last entry and the central
directory. The APKs compared here are the ones Gradle makes, which Expo's generated project signs with its public
debug key; the release is then re-signed (packaging/android/sign-apk.sh). So this script reports, in this order:

1. whether the two files are byte for byte the same (the only result that counts as reproducible);
2. entries that only one APK has;
3. entries whose content differs (each one's SHA-256 of the uncompressed bytes);
4. entries with the same content but other ZIP metadata (time stamp, compression, attributes, extra field, order);
5. whether the bytes outside the entries differ (the signing block and the rest of the ZIP structure).

With --ignore-signature, the verdict is whether the two APKs are the same apart from their signatures. That is how a
rebuild is checked against a release APK, which is signed with the release key (by apksigner) while a rebuild has
Expo's debug signature (by Gradle). A signature is two things in the file, and only these are set aside:

- the APK Signing Block (v2/v3 signatures), between the last entry and the central directory;
- the v1 (JAR) signature files apksigner adds: META-INF/MANIFEST.MF, META-INF/*.SF and META-INF/*.RSA, *.DSA or *.EC
  (each one's local entry and its central directory record).

Every other byte must be the same: each entry's local header and data, whatever lies between entries, every other
central directory record (with entry offsets as they are once those files are cut out) and the end record (with its
counts, size and offset adjusted the same way). So equal means the release APK is this build plus a signature, and
nothing else. Whether that signature is valid and by the release key is a separate check
(`apksigner verify --print-certs`, which also checks the v1 files against the entries).

Exit status: 0 identical, 1 different, 2 could not read an APK. The report is Markdown, for the job summary.
"""

from __future__ import annotations

import hashlib
import re
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


SIG_BLOCK_MAGIC = b"APK Sig Block 42"
V1_SIGNATURE_FILE = re.compile(r"META-INF/(MANIFEST\.MF|[^/]+\.(SF|RSA|DSA|EC))", re.IGNORECASE)


# What each ID-value pair of an APK Signing Block holds, for the report.
SIG_BLOCK_IDS = {
    0x7109871A: "v2 signature",
    0xF05368C0: "v3 signature",
    0x1B93AD61: "v3.1 signature",
    0x504B4453: "dependency metadata (encrypted for Google Play)",
    0x6DFF800D: "source stamp",
    0x2146444E: "Google Play frosting",
    0x42726577: "padding",
}


def signing_block_entries(path: str) -> list[str]:
    """What the APK Signing Block holds: each pair's ID (and what it is) and size. Empty if there is no block."""
    with open(path, "rb") as f:
        data = f.read()
    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise ValueError("no end of central directory record")
    (cd_offset,) = struct.unpack_from("<I", data, eocd + 16)
    if cd_offset < 32 or data[cd_offset - 16:cd_offset] != SIG_BLOCK_MAGIC:
        return []
    (size,) = struct.unpack_from("<Q", data, cd_offset - 24)
    p, end = cd_offset - size - 8 + 8, cd_offset - 24
    pairs = []
    while p < end:
        length, pair_id = struct.unpack_from("<QI", data, p)
        if length < 4 or p + 8 + length > end:
            raise ValueError("malformed APK Signing Block")
        pairs.append(f"0x{pair_id:08x} {SIG_BLOCK_IDS.get(pair_id, 'unknown')} ({length - 4} bytes)")
        p += 8 + length
    return pairs


def without_signature(path: str) -> tuple[bytes, int, list[str]]:
    """The file without its APK Signing Block and v1 signature files, with the ZIP offsets adjusted to match.

    Returns those bytes, the signing block's size (0 if none) and the v1 signature files set aside. Every other byte of
    the file is kept, so two APKs that differ only in their signatures give the same bytes here. No ZIP64 (an APK is
    far below 4 GB), one disk, nothing after the end record but its comment.
    """
    with open(path, "rb") as f:
        data = f.read()
    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0 or len(data) - eocd < 22:
        raise ValueError("no end of central directory record")
    disk, cd_disk, count_disk, count, cd_size, cd_offset, comment_len = struct.unpack_from("<HHHHIIH", data, eocd + 4)
    if eocd + 22 + comment_len != len(data):
        raise ValueError("bytes after the end of central directory record")
    if disk or cd_disk or count_disk != count:
        raise ValueError("a multi-disk ZIP")
    if cd_offset + cd_size != eocd:
        raise ValueError("bytes between the central directory and its end record (or ZIP64)")

    # The APK Signing Block: its size (uint64, not counting this first field) at both ends, then the magic.
    start = cd_offset
    if cd_offset >= 32 and data[cd_offset - 16:cd_offset] == SIG_BLOCK_MAGIC:
        (size,) = struct.unpack_from("<Q", data, cd_offset - 24)
        start = cd_offset - (size + 8)
        if start < 0 or struct.unpack_from("<Q", data, start)[0] != size:
            raise ValueError("malformed APK Signing Block")

    # The central directory, record by record.
    records = []  # (name, local header offset, central directory record bytes)
    p = cd_offset
    for _ in range(count):
        if data[p:p + 4] != b"PK\x01\x02":
            raise ValueError(f"no central directory record at {p}")
        (flags,) = struct.unpack_from("<H", data, p + 8)
        (csize,) = struct.unpack_from("<I", data, p + 20)
        name_len, extra_len, comment_len = struct.unpack_from("<HHH", data, p + 28)
        (local,) = struct.unpack_from("<I", data, p + 42)
        raw_name = data[p + 46:p + 46 + name_len]
        name = raw_name.decode("utf-8" if flags & 0x800 else "cp437")
        rec_end = p + 46 + name_len + extra_len + comment_len
        records.append((name, local, csize, flags, data[p:rec_end]))
        p = rec_end
    if p != eocd:
        raise ValueError("the central directory is not the size its end record says")

    # The v1 signature files' local entries (header, data, data descriptor), to cut out.
    cuts: list[tuple[int, int]] = []
    v1 = []
    for name, local, csize, flags, _ in records:
        if not V1_SIGNATURE_FILE.fullmatch(name):
            continue
        if data[local:local + 4] != b"PK\x03\x04":
            raise ValueError(f"no local header for {name}")
        name_len, extra_len = struct.unpack_from("<HH", data, local + 26)
        end = local + 30 + name_len + extra_len + csize
        if flags & 0x08:
            end += 16 if data[end:end + 4] == b"PK\x07\x08" else 12
        cuts.append((local, end))
        v1.append(name)
    cuts.sort()
    for (s1, e1), (s2, _) in zip(cuts, cuts[1:]):
        if e1 > s2:
            raise ValueError("overlapping v1 signature entries")
    if cuts and cuts[-1][1] > start:
        raise ValueError("a v1 signature entry runs into the signing block")

    def moved(offset: int) -> int:
        for s0, e0 in cuts:
            if s0 < offset < e0:
                raise ValueError(f"an entry at {offset} lies inside a v1 signature entry")
        return offset - sum(e0 - s0 for s0, e0 in cuts if e0 <= offset)

    entries_part = bytearray()
    pos = 0
    for s0, e0 in cuts:
        entries_part += data[pos:s0]
        pos = e0
    entries_part += data[pos:start]
    directory = bytearray()
    kept = 0
    for name, local, _, _, rec in records:
        if V1_SIGNATURE_FILE.fullmatch(name):
            continue
        rec = bytearray(rec)
        struct.pack_into("<I", rec, 42, moved(local))
        directory += rec
        kept += 1
    end_record = bytearray(data[eocd:])
    struct.pack_into("<HHII", end_record, 8, kept, kept, len(directory), len(entries_part))
    return bytes(entries_part + directory + end_record), cd_offset - start, v1


def main(argv: list[str]) -> int:
    args = argv[1:]
    ignore_signature = "--ignore-signature" in args
    args = [x for x in args if x != "--ignore-signature"]
    if len(args) != 2:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    a, b = args
    try:
        hash_a, hash_b = sha256_file(a), sha256_file(b)
        if ignore_signature:
            unsigned_a, sig_size_a, v1_a = without_signature(a)
            unsigned_b, sig_size_b, v1_b = without_signature(b)
        order_a, info_a = entries(a)
        order_b, info_b = entries(b)
        block_a, block_b = outside_entries(a), outside_entries(b)
        pairs_a, pairs_b = signing_block_entries(a), signing_block_entries(b)
    except (OSError, ValueError, struct.error, zipfile.BadZipFile) as e:
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
    if ignore_signature:
        def v1_list(names: list[str]) -> str:
            return ", ".join(f"`{n}`" for n in names) if names else "none"

        out.append("")
        out.append(f"Set aside as the signature: signing block {sig_size_a} / {sig_size_b} bytes; "
                   f"v1 signature files in A: {v1_list(v1_a)}; in B: {v1_list(v1_b)}.")
        for label, pairs in (("A", pairs_a), ("B", pairs_b)):
            out.append(f"Signing block of {label}: {'; '.join(pairs) if pairs else 'none'}.")
        if unsigned_a == unsigned_b:
            out.append("")
            out.append(
                "**The two APKs are identical apart from their signatures**: every other byte is the same "
                f"(SHA-256 `{hashlib.sha256(unsigned_a).hexdigest()}` without them)."
            )
            print("\n".join(out))
            return 0

    out.append("")
    out.append("**The two APKs differ, in more than their signatures.**" if ignore_signature else "**The two APKs differ.**")

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
    if not ignore_signature:  # listed above otherwise
        for label, pairs in (("A", pairs_a), ("B", pairs_b)):
            out.append(f"Signing block of {label}: {'; '.join(pairs) if pairs else 'none'}.")
    print("\n".join(out))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

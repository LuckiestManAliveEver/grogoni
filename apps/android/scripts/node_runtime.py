#!/usr/bin/env python3
"""Fetch the pinned Android Node.js runtime for the on-device WhatsApp sidecar.

The runtime is Termux's `nodejs-lts` build (Node 24 LTS, Android bionic, arm64-v8a and x86_64)
plus the shared libraries it links. Nothing here is committed: every file is downloaded from
packages.termux.dev, checked against the SHA-256 pinned in ../node-runtime.lock.json, and
written into a git-ignored build directory.

Android only installs `lib*.so` files from an APK's lib/<abi>/ directory, and only files there
may be executed by an app (W^X for targetSdk >= 29). So the `node` executable is packaged as
`libgrogoni_node.so`, and versioned sonames such as `libssl.so.3` are renamed to the same-length
`libssl_3.so` inside every ELF that names them (DT_NEEDED, DT_SONAME and the version-needed
file names, which share the same dynamic string table entries). Same-length renames never move
an ELF section, so no relinking tool is required.

32-bit phones (armeabi-v7a, x86) cannot run the sidecar, but they must still install the app.
Google Play serves an App Bundle only to devices whose ABI has a lib/<abi>/ directory, so
`fetch` also writes a 336-byte placeholder ELF (`libgrogoni_abi_placeholder.so`, generated here,
never loaded) for each of them. Without it the bundle would silently drop every 32-bit phone.

Commands:
  fetch   --out DIR [--cache DIR] [--abi arm64-v8a,x86_64] [--placeholder-abi armeabi-v7a,x86]
                                                              download, verify, extract
  resolve --index-dir DIR                                     rewrite the lock from Packages indices
  selftest                                                    deterministic checks, no network
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import lzma
import os
import struct
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCK = HERE.parent / "node-runtime.lock.json"
TERMUX_PREFIX = "data/data/com.termux/files/usr/"
ABI_TO_ARCH = {"arm64-v8a": "aarch64", "x86_64": "x86_64"}
ELF_MACHINE = {"arm64-v8a": 183, "x86_64": 62}  # EM_AARCH64, EM_X86_64
NODE_OUTPUT = "libgrogoni_node.so"
# Libraries every Android app process may link from the platform (NDK stable system libraries).
SYSTEM_LIBRARIES = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so", "libz.so"}
DT_NULL, DT_NEEDED, DT_STRTAB, DT_STRSZ, DT_SONAME = 0, 1, 5, 10, 14
DT_VERNEED, DT_VERNEEDNUM = 0x6FFFFFFE, 0x6FFFFFFF
DT_SYMTAB, DT_SYMENT = 6, 11
PLACEHOLDER_OUTPUT = "libgrogoni_abi_placeholder.so"
# EM_ARM with the EABI5 flag, EM_386.
PLACEHOLDER_MACHINE = {"armeabi-v7a": (40, 0x05000000), "x86": (3, 0)}


class RuntimeError_(Exception):
    pass


# ----------------------------------------------------------------------------- lock + download
def load_lock() -> dict:
    lock = json.loads(LOCK.read_text())
    if lock.get("schema") != 1:
        raise RuntimeError_("Unsupported node-runtime.lock.json schema.")
    return lock


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, target: Path, expected: str) -> None:
    """Download to a temporary name, verify, then rename. A mismatching file never lands."""
    if target.is_file() and sha256_file(target) == expected:
        return
    if not url.startswith("https://packages.termux.dev/"):
        raise RuntimeError_(f"Refusing a download outside the pinned official host: {url}")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".partial")
    request = urllib.request.Request(url, headers={"User-Agent": "grogoni-android-build"})
    with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as out:
        while chunk := response.read(1 << 20):
            out.write(chunk)
    actual = sha256_file(partial)
    if actual != expected:
        partial.unlink(missing_ok=True)
        raise RuntimeError_(f"SHA-256 mismatch for {url}: expected {expected}, got {actual}")
    partial.replace(target)


# ----------------------------------------------------------------------------- .deb parsing
def ar_members(data: bytes) -> dict[str, bytes]:
    if not data.startswith(b"!<arch>\n"):
        raise RuntimeError_("Not a Debian package (ar archive).")
    members, offset = {}, 8
    while offset + 60 <= len(data):
        header = data[offset : offset + 60]
        name = header[:16].decode().strip().rstrip("/")
        size = int(header[48:58].decode().strip())
        members[name] = data[offset + 60 : offset + 60 + size]
        offset += 60 + size + (size & 1)
    return members


def deb_files(deb: Path) -> dict[str, bytes | str]:
    """Regular files map to bytes; symlinks map to their target string (relative to prefix)."""
    members = ar_members(deb.read_bytes())
    name = next((n for n in members if n.startswith("data.tar")), None)
    if name is None:
        raise RuntimeError_(f"{deb.name} has no data archive.")
    payload = members[name]
    if name.endswith(".xz"):
        payload = lzma.decompress(payload)
    elif not name.endswith((".tar", ".gz")):
        raise RuntimeError_(f"Unsupported data archive {name} in {deb.name}.")
    files: dict[str, bytes | str] = {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as archive:
        for member in archive.getmembers():
            path = member.name.lstrip("./")
            if not path.startswith(TERMUX_PREFIX):
                continue
            relative = path[len(TERMUX_PREFIX) :]
            if member.issym():
                files[relative] = os.path.normpath(os.path.join(os.path.dirname(relative), member.linkname))
            elif member.isfile():
                files[relative] = archive.extractfile(member).read()  # type: ignore[union-attr]
    return files


def resolve_link(files: dict[str, bytes | str], path: str) -> bytes | None:
    for _ in range(8):
        value = files.get(path)
        if value is None or isinstance(value, bytes):
            return value
        path = value
    raise RuntimeError_(f"Symlink loop at {path}.")


# ----------------------------------------------------------------------------- ELF handling
class Elf:
    """Minimal little-endian ELF64 dynamic-section reader for DT_NEEDED/DT_SONAME/verneed."""

    def __init__(self, data: bytes):
        if data[:4] != b"\x7fELF" or data[4] != 2 or data[5] != 1:
            raise RuntimeError_("Only little-endian ELF64 objects are supported.")
        self.data = data
        (self.machine,) = struct.unpack_from("<H", data, 18)
        phoff, = struct.unpack_from("<Q", data, 32)
        phentsize, phnum = struct.unpack_from("<HH", data, 54)
        self.loads, self.dynamic, self.min_align = [], None, None
        for index in range(phnum):
            p_type, _flags, p_offset, p_vaddr, _paddr, p_filesz, _memsz, p_align = struct.unpack_from(
                "<IIQQQQQQ", data, phoff + index * phentsize
            )
            if p_type == 1:  # PT_LOAD
                self.loads.append((p_vaddr, p_offset, p_filesz))
                self.min_align = p_align if self.min_align is None else min(self.min_align, p_align)
            elif p_type == 2:  # PT_DYNAMIC
                self.dynamic = (p_offset, p_filesz)
        self.entries: list[tuple[int, int]] = []
        if self.dynamic:
            offset, size = self.dynamic
            for position in range(offset, offset + size, 16):
                tag, value = struct.unpack_from("<qQ", data, position)
                if tag == DT_NULL:
                    break
                self.entries.append((tag, value))
        tags = dict(self.entries)
        self.strtab = self.file_offset(tags[DT_STRTAB]) if DT_STRTAB in tags else None
        self.strsz = tags.get(DT_STRSZ, 0)

    def file_offset(self, vaddr: int) -> int:
        for start, offset, size in self.loads:
            if start <= vaddr < start + size:
                return offset + vaddr - start
        raise RuntimeError_("Dynamic address outside every PT_LOAD segment.")

    def string_at(self, index: int) -> str:
        start = self.strtab + index  # type: ignore[operator]
        return self.data[start : self.data.index(b"\0", start)].decode()

    def string_refs(self) -> list[int]:
        """Offsets into .dynstr of DT_NEEDED, DT_SONAME and every Verneed vn_file."""
        refs = [value for tag, value in self.entries if tag in (DT_NEEDED, DT_SONAME)]
        tags = dict(self.entries)
        if DT_VERNEED in tags:
            position = self.file_offset(tags[DT_VERNEED])
            for _ in range(tags.get(DT_VERNEEDNUM, 0)):
                _version, _cnt, vn_file, _aux, vn_next = struct.unpack_from("<HHIII", self.data, position)
                refs.append(vn_file)
                if not vn_next:
                    break
                position += vn_next
        return refs

    @property
    def needed(self) -> list[str]:
        return [self.string_at(value) for tag, value in self.entries if tag == DT_NEEDED]


def android_name(soname: str) -> str:
    """`libssl.so.3` -> `libssl_3.so`; `libicuuc.so.79.1` -> `libicuuc_79_1.so`. Same length."""
    if soname.endswith(".so"):
        return soname
    base, _, version = soname.partition(".so.")
    if not base or not version:
        raise RuntimeError_(f"Unexpected library name {soname}.")
    renamed = f"{base}_{version.replace('.', '_')}.so"
    assert len(renamed) == len(soname)
    return renamed


def rename_strings(data: bytes, renames: dict[str, str]) -> bytes:
    """Rewrite referenced .dynstr strings in place. Only whole referenced strings are changed."""
    elf = Elf(data)
    if elf.strtab is None:
        return data
    patched = bytearray(data)
    for ref in set(elf.string_refs()):
        current = elf.string_at(ref)
        replacement = renames.get(current)
        if replacement is None or replacement == current:
            continue
        if len(replacement) != len(current):
            raise RuntimeError_(f"Rename {current} -> {replacement} would change its length.")
        start = elf.strtab + ref
        patched[start : start + len(current)] = replacement.encode()
    return bytes(patched)


# ----------------------------------------------------------------------------- fetch
# Upstream licenses for packages whose Termux license file is broken (libicu 79.1 ships a
# "404: Not Found" body in place of its LICENSE).
KNOWN_LICENSES = {"libicu": "Unicode-3.0"}


def plausible_notice(text: bytes) -> bool:
    return len(text) >= 64 and not text.lstrip().startswith(b"404")


def fetch(out: Path, cache: Path, abis: list[str]) -> dict:
    lock = load_lock()
    report = {"node": lock["node"], "abis": {}}
    for abi in abis:
        arch = ABI_TO_ARCH[abi]
        packages = lock["packages"][arch]
        files: dict[str, bytes | str] = {}
        notices: dict[str, bytes] = {}
        for package in packages:
            deb = cache / arch / f"{package['name']}_{package['sha256'][:16]}.deb"
            download(lock["baseUrl"] + package["filename"], deb, package["sha256"])
            contents = deb_files(deb)
            files.update(contents)
            candidates = [f"share/doc/{package['name']}/copyright", f"share/doc/{package['name']}/LICENSE"]
            candidates += sorted(path for path in contents if path.startswith("share/") and path.endswith("/LICENSE"))
            for candidate in candidates:
                link = contents.get(candidate)
                if link is None:
                    continue
                notice = resolve_link(contents, candidate)
                if isinstance(notice, bytes) and not plausible_notice(notice):
                    # Termux's libicu ships "404: Not Found" as its doc LICENSE; use the real one.
                    continue
                if notice is None and isinstance(link, str):
                    # Termux links standard texts into termux-licenses (share/LICENSES/<SPDX>.txt).
                    license_name = Path(link).stem
                    notice = (
                        f"{package['name']} {package['version']} (Termux build) is licensed under "
                        f"{license_name}. See https://spdx.org/licenses/ for the standard text.\n"
                    ).encode()
                if notice is not None:
                    notices[package["name"]] = notice
                    break
            if package["name"] not in notices:
                spdx = KNOWN_LICENSES.get(package["name"])
                if spdx is None:
                    raise RuntimeError_(f"{arch}: {package['name']} ships no usable license notice.")
                notices[package["name"]] = (
                    f"{package['name']} {package['version']} (Termux build) is licensed under {spdx}. "
                    "The Termux package's own license file is invalid, so this notice names the upstream "
                    "license. See https://spdx.org/licenses/ for the standard text.\n"
                ).encode()
        node = resolve_link(files, "bin/node")
        if node is None:
            raise RuntimeError_(f"{arch}: bin/node missing from the pinned packages.")
        outputs: dict[str, bytes] = {NODE_OUTPUT: node}
        queue, sonames = list(Elf(node).needed), {}
        while queue:
            needed = queue.pop()
            if needed in sonames or needed in SYSTEM_LIBRARIES:
                continue
            library = resolve_link(files, f"lib/{needed}")
            if library is None:
                raise RuntimeError_(f"{arch}: {needed} is neither pinned nor an Android system library.")
            sonames[needed] = library
            queue.extend(Elf(library).needed)
        renames = {name: android_name(name) for name in sonames}
        for name, library in sonames.items():
            outputs[renames[name]] = library
        target = out / "jniLibs" / abi
        target.mkdir(parents=True, exist_ok=True)
        for stale in target.iterdir():
            if stale.name not in outputs:
                stale.unlink()
        entries = {}
        for name, data in sorted(outputs.items()):
            elf = Elf(data)
            if elf.machine != ELF_MACHINE[abi]:
                raise RuntimeError_(f"{arch}: {name} has ELF machine {elf.machine}, expected {ELF_MACHINE[abi]}.")
            patched = rename_strings(data, renames)
            unresolved = [n for n in Elf(patched).needed if n not in SYSTEM_LIBRARIES and n not in outputs]
            if unresolved:
                raise RuntimeError_(f"{arch}: {name} still needs {unresolved}.")
            (target / name).write_bytes(patched)
            entries[name] = {
                "bytes": len(patched),
                "sha256": hashlib.sha256(patched).hexdigest(),
                "loadAlign": elf.min_align,
            }
        report["abis"][abi] = entries
        licenses = out / "assets" / "third-party-licenses" / "node-runtime"
        licenses.mkdir(parents=True, exist_ok=True)
        for stale in licenses.iterdir():
            if stale.stem not in notices:
                stale.unlink()
        for name, notice in notices.items():
            (licenses / f"{name}.txt").write_bytes(notice)
    (out / "node-runtime-manifest.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def placeholder_elf(abi: str) -> bytes:
    """A minimal, valid ELF32 shared object for `abi`: one PT_LOAD, a PT_DYNAMIC naming its own
    soname, an empty symbol table, no code. It exists only so the ABI directory is present."""
    machine, flags = PLACEHOLDER_MACHINE[abi]
    strtab = b"\0" + PLACEHOLDER_OUTPUT.encode() + b"\0"
    dynamic = [(DT_STRTAB, 0x100), (DT_SYMTAB, 0x140), (DT_STRSZ, len(strtab)), (DT_SYMENT, 16), (DT_SONAME, 1), (DT_NULL, 0)]
    size = 0x150
    image = bytearray(size)
    image[0:16] = b"\x7fELF\x01\x01\x01" + b"\0" * 9
    # e_type ET_DYN, e_machine, e_version, e_entry, e_phoff, e_shoff, e_flags, e_ehsize,
    # e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx
    struct.pack_into("<HHIIIIIHHHHHH", image, 16, 3, machine, 1, 0, 52, 0, flags, 52, 32, 2, 40, 0, 0)
    # PT_LOAD (R) covering the whole file, PT_DYNAMIC (RW) at 0x80.
    struct.pack_into("<IIIIIIII", image, 52, 1, 0, 0, 0, size, size, 4, 0x1000)
    struct.pack_into("<IIIIIIII", image, 84, 2, 0x80, 0x80, 0x80, 8 * len(dynamic), 8 * len(dynamic), 6, 4)
    for index, (tag, value) in enumerate(dynamic):
        struct.pack_into("<iI", image, 0x80 + 8 * index, tag, value)
    image[0x100 : 0x100 + len(strtab)] = strtab
    return bytes(image)


def write_placeholders(out: Path, abis: list[str]) -> dict:
    written = {}
    for abi in abis:
        target = out / "jniLibs" / abi
        target.mkdir(parents=True, exist_ok=True)
        for stale in target.iterdir():
            if stale.name != PLACEHOLDER_OUTPUT:
                stale.unlink()
        data = placeholder_elf(abi)
        (target / PLACEHOLDER_OUTPUT).write_bytes(data)
        written[abi] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    return written


# ----------------------------------------------------------------------------- resolve
def parse_index(text: str) -> dict[str, dict[str, str]]:
    packages = {}
    for block in text.split("\n\n"):
        fields = {}
        for line in block.splitlines():
            if ": " in line and not line.startswith(" "):
                key, value = line.split(": ", 1)
                fields[key] = value
        if "Package" in fields:
            packages[fields["Package"]] = fields
    return packages


def closure(index: dict[str, dict[str, str]], root: str) -> list[dict[str, str]]:
    seen, order, todo = set(), [], [root]
    while todo:
        name = todo.pop(0)
        if name in seen:
            continue
        seen.add(name)
        fields = index[name]
        order.append({"name": name, "version": fields["Version"], "filename": fields["Filename"], "sha256": fields["SHA256"]})
        for dependency in fields.get("Depends", "").split(","):
            dependency = dependency.strip().split(" ")[0]
            if dependency and "|" not in dependency:
                todo.append(dependency)
    return order


def resolve(index_dir: Path) -> None:
    lock = load_lock()
    for arch in ABI_TO_ARCH.values():
        index = parse_index((index_dir / f"Packages-{arch}").read_text())
        lock["packages"][arch] = closure(index, lock["rootPackage"])
        lock["node"] = index[lock["rootPackage"]]["Version"]
    LOCK.write_text(json.dumps(lock, indent=2) + "\n")


# ----------------------------------------------------------------------------- selftest
def selftest() -> None:
    assert android_name("libssl.so.3") == "libssl_3.so"
    assert android_name("libicuuc.so.79.1") == "libicuuc_79_1.so"
    assert android_name("libc++_shared.so") == "libc++_shared.so"
    # A synthetic ELF64 with one PT_LOAD, a PT_DYNAMIC and a .dynstr naming libssl.so.3 twice
    # (DT_NEEDED and a verneed vn_file sharing one string), plus an unrelated symbol string.
    strtab = b"\0libssl.so.3\0SSL_new\0"
    dyn_entries = [(DT_NEEDED, 1), (DT_STRTAB, 0x200), (DT_STRSZ, len(strtab)), (DT_VERNEED, 0x300), (DT_VERNEEDNUM, 1), (DT_NULL, 0)]
    image = bytearray(0x400)
    image[0:16] = b"\x7fELF\x02\x01\x01" + b"\0" * 9
    struct.pack_into("<HHIQQQIHHHHHH", image, 16, 3, 62, 1, 0, 64, 0, 0, 64, 56, 2, 64, 0, 0)
    struct.pack_into("<IIQQQQQQ", image, 64, 1, 5, 0, 0, 0, 0x400, 0x400, 0x4000)
    struct.pack_into("<IIQQQQQQ", image, 120, 2, 6, 0x100, 0x100, 0x100, 16 * len(dyn_entries), 16 * len(dyn_entries), 8)
    for index, (tag, value) in enumerate(dyn_entries):
        struct.pack_into("<qQ", image, 0x100 + 16 * index, tag, value)
    image[0x200 : 0x200 + len(strtab)] = strtab
    struct.pack_into("<HHIII", image, 0x300, 1, 0, 1, 0, 0)
    elf = Elf(bytes(image))
    assert elf.needed == ["libssl.so.3"], elf.needed
    assert elf.min_align == 0x4000
    patched = Elf(rename_strings(bytes(image), {"libssl.so.3": "libssl_3.so"}))
    assert patched.needed == ["libssl_3.so"], patched.needed
    assert patched.string_at(13) == "SSL_new", "an unreferenced string must stay untouched"
    assert len(patched.data) == len(image)
    assert not plausible_notice(b"404: Not Found") and plausible_notice(b"Copyright " * 10)
    try:
        rename_strings(bytes(image), {"libssl.so.3": "libssl.so"})
        raise AssertionError("a length-changing rename must be refused")
    except RuntimeError_:
        pass
    lock = load_lock()
    for arch in ABI_TO_ARCH.values():
        names = [package["name"] for package in lock["packages"][arch]]
        assert names[0] == lock["rootPackage"] and len(set(names)) == len(names)
        for package in lock["packages"][arch]:
            assert len(package["sha256"]) == 64 and int(package["sha256"], 16) >= 0
    for abi, (machine, _flags) in PLACEHOLDER_MACHINE.items():
        data = placeholder_elf(abi)
        assert data[:4] == b"\x7fELF" and data[4] == 1, "placeholders are ELF32"
        assert struct.unpack_from("<HH", data, 16) == (3, machine), "ET_DYN for the right machine"
        assert PLACEHOLDER_OUTPUT.encode() in data and data == placeholder_elf(abi), "deterministic"
        assert abi not in ABI_TO_ARCH, "a placeholder never shadows a real runtime ABI"
    major = int(lock["node"].split(".")[0])
    assert major >= 20, "Baileys 7 requires Node >= 20"
    with tempfile.TemporaryDirectory() as directory:
        bad = Path(directory) / "x.deb"
        try:
            download("https://example.com/x.deb", bad, "0" * 64)
            raise AssertionError("an off-host URL must be refused")
        except RuntimeError_:
            pass
    print("node_runtime selftest: ok")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    fetch_parser = commands.add_parser("fetch")
    fetch_parser.add_argument("--out", type=Path, required=True)
    fetch_parser.add_argument("--cache", type=Path)
    fetch_parser.add_argument("--abi", default="arm64-v8a,x86_64")
    fetch_parser.add_argument("--placeholder-abi", default="armeabi-v7a,x86")
    resolve_parser = commands.add_parser("resolve")
    resolve_parser.add_argument("--index-dir", type=Path, required=True)
    commands.add_parser("selftest")
    args = parser.parse_args()
    try:
        if args.command == "fetch":
            abis = [abi.strip() for abi in args.abi.split(",") if abi.strip()]
            unknown = [abi for abi in abis if abi not in ABI_TO_ARCH]
            if unknown:
                raise RuntimeError_(f"Unsupported ABI {unknown}.")
            placeholders = [abi.strip() for abi in args.placeholder_abi.split(",") if abi.strip()]
            if any(abi not in PLACEHOLDER_MACHINE for abi in placeholders):
                raise RuntimeError_(f"Unsupported placeholder ABI {placeholders}.")
            report = fetch(args.out, args.cache or args.out / "cache", abis)
            for abi, entry in write_placeholders(args.out, placeholders).items():
                print(f"{abi}: placeholder {PLACEHOLDER_OUTPUT}, {entry['bytes']} bytes")
            for abi, entries in report["abis"].items():
                total = sum(entry["bytes"] for entry in entries.values())
                unaligned = [name for name, entry in entries.items() if (entry["loadAlign"] or 0) < 16384]
                print(f"{abi}: {len(entries)} files, {total} bytes; PT_LOAD align < 16 KiB: {unaligned or 'none'}")
        elif args.command == "resolve":
            resolve(args.index_dir)
        else:
            selftest()
    except RuntimeError_ as error:
        print(f"node_runtime: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

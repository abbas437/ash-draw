#!/usr/bin/env python3
"""Validate a DXF with ezdxf. Prints ONE JSON line. Exit 0 = clean audit, 1 = audit errors, 2 = exception."""
import json
import sys
from collections import Counter


def main(path):
    import ezdxf
    from ezdxf import recover

    recovered = False
    try:
        doc = ezdxf.readfile(path)
        auditor = doc.audit()
    except (ezdxf.DXFError, IOError, UnicodeDecodeError):
        doc, auditor = recover.readfile(path)
        recovered = True
    errors = list(auditor.errors)
    out = {
        "ok": True,
        "version": doc.dxfversion,
        "audit_errors": len(errors),
        "audit_messages": [str(e.message) for e in errors[:10]],
        "counts": dict(Counter(e.dxftype() for e in doc.modelspace())),
        "layers": [l.dxf.name for l in doc.layers],
        "blocks": len(doc.blocks),
    }
    if recovered:
        out["recovered"] = True
    print(json.dumps(out))
    return 0 if not errors else 1


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: validate_dxf.py <file.dxf>")
        sys.exit(main(sys.argv[1]))
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        sys.exit(2)

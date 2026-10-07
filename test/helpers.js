import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const fixture = (name) => readFileSync(path.join(FIX, name));
export const expected = JSON.parse(readFileSync(path.join(FIX, 'expected.json'), 'utf8'));

/** round all numbers so geometry compares with a tolerance; drop ids */
export function norm(value, digits = 7) {
  if (typeof value === 'number') return Math.round(value * 10 ** digits) / 10 ** digits + 0;
  if (Array.isArray(value)) return value.map((v) => norm(v, digits));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (k === 'id' || k === 'parent') continue;
      out[k] = norm(value[k], digits);
    }
    return out;
  }
  return value;
}

let ezdxfOk;
export function ezdxfAvailable() {
  if (ezdxfOk === undefined) {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const r = spawnSync(py, ['-c', 'import ezdxf'], { encoding: 'utf8' });
    ezdxfOk = r.status === 0 ? py : false;
  }
  return ezdxfOk;
}

/** audit a DXF file with ezdxf; returns the JSON line the validator prints */
export function validateWithEzdxf(file) {
  const py = ezdxfAvailable();
  const script = fileURLToPath(new URL('./validate_dxf.py', import.meta.url));
  const r = spawnSync(py, [script, file], { encoding: 'utf8' });
  const line = r.stdout.trim().split('\n').pop();
  return { status: r.status, ...JSON.parse(line) };
}

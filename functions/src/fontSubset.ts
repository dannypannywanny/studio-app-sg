// Font subsetting with HarfBuzz (harfbuzzjs's raw harfbuzz-subset.wasm, no JS wrapper). pdf-lib's own
// subsetter (@pdf-lib/fontkit) drops glyphs from Noto Sans SC, so invoices embed a font we have already
// cut down to the characters they use, and pdf-lib embeds that small font whole.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// The functions tsconfig has no DOM/WebAssembly lib; these are the only pieces used.
const Wasm = (globalThis as unknown as {
  WebAssembly: {
    Module: new (bytes: Uint8Array) => object;
    Instance: new (module: object, imports: object) => { exports: unknown };
  };
}).WebAssembly;

interface HbExports {
  memory: { buffer: ArrayBuffer };
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, lengthPtr: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

const HB_MEMORY_MODE_READONLY = 1;

/** A font loaded once into HarfBuzz; `subset` returns a standalone TTF with just the given characters. */
export interface Subsetter {
  subset(text: string): Uint8Array;
}

// The functions folder is the cwd both in Cloud Functions (deploy root) and under `pnpm test`.
const fromFunctions = createRequire(resolve(process.cwd(), 'package.json'));

export function createSubsetter(fontBytes: Uint8Array): Subsetter {
  const wasm = readFileSync(fromFunctions.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm'));
  const hb = new Wasm.Instance(new Wasm.Module(wasm), {}).exports as unknown as HbExports;

  // The font stays in wasm memory for the life of the instance; HarfBuzz reads it in place.
  const fontPtr = hb.malloc(fontBytes.byteLength);
  new Uint8Array(hb.memory.buffer, fontPtr, fontBytes.byteLength).set(fontBytes);
  const blob = hb.hb_blob_create(fontPtr, fontBytes.byteLength, HB_MEMORY_MODE_READONLY, 0, 0);
  const face = hb.hb_face_create(blob, 0);

  return {
    subset(text: string): Uint8Array {
      const input = hb.hb_subset_input_create_or_fail();
      if (!input) throw new Error('HarfBuzz: could not create subset input');
      try {
        const unicodes = hb.hb_subset_input_unicode_set(input);
        for (const ch of new Set(text)) hb.hb_set_add(unicodes, ch.codePointAt(0)!);
        const sub = hb.hb_subset_or_fail(face, input);
        if (!sub) throw new Error('HarfBuzz: subsetting failed');
        const out = hb.hb_face_reference_blob(sub);
        try {
          const ptr = hb.hb_blob_get_data(out, 0);
          const len = hb.hb_blob_get_length(out);
          // Copy out: memory.buffer can be replaced when wasm memory grows.
          return new Uint8Array(hb.memory.buffer, ptr, len).slice();
        } finally {
          hb.hb_blob_destroy(out);
          hb.hb_face_destroy(sub);
        }
      } finally {
        hb.hb_subset_input_destroy(input);
      }
    },
  };
}

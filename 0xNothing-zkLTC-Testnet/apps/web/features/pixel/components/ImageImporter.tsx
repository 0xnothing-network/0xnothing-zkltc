"use client";

import { useEffect, useRef, useState } from "react";
import { importImageFile, type PixelImportMode } from "@/lib/pixelImport";

interface ImageImporterProps {
  gridSize: number;
  onApply: (pixelData: string[][]) => void;
  onClose: () => void;
}

export function ImageImporter({ gridSize, onApply, onClose }: ImageImporterProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<PixelImportMode>("fit");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const chooseFile = (nextFile: File | undefined) => {
    if (!nextFile) return;
    if (preview) URL.revokeObjectURL(preview);
    setFile(nextFile);
    setPreview(URL.createObjectURL(nextFile));
    setError(null);
  };

  const apply = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onApply(await importImageFile(file, { gridSize, mode }));
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not import this image");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="pixel-import-title">
      <div className="w-full max-w-lg rounded-2xl border border-(--line) bg-(--surface-2) p-5 shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div><p className="text-xs uppercase tracking-[0.2em] text-(--accent-text)">Your artwork</p><h2 id="pixel-import-title" className="mt-1 text-xl font-bold text-(--text-1)">Import image</h2></div>
          <button onClick={onClose} className="text-xl text-(--text-3) hover:text-(--text-1)" aria-label="Close">×</button>
        </div>
        <button onClick={() => inputRef.current?.click()} className="flex min-h-40 w-full items-center justify-center rounded-xl border border-dashed border-(--line-strong) bg-(--bg) p-4 text-sm text-(--text-2) hover:border-(--accent)">
          {preview ? (
            <div
              role="img"
              aria-label="Selected source"
              className="h-48 w-full bg-contain bg-center bg-no-repeat"
              style={{ backgroundImage: `url(${preview})` }}
            />
          ) : "Choose PNG, JPEG, or WebP"}
        </button>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => chooseFile(event.target.files?.[0])} />
        <div className="mt-4 flex gap-2">
          {(["fit", "fill"] as const).map((value) => <button key={value} onClick={() => setMode(value)} className={`flex-1 rounded-lg px-3 py-2 text-xs uppercase tracking-wider ${mode === value ? "bg-(--accent) text-(--text-1)" : "bg-(--surface-1) text-(--text-3)"}`}>{value}</button>)}
        </div>
        <p className="mt-3 text-xs text-(--text-3)">{mode === "fit" ? "Keeps the full image with transparent padding." : "Fills the grid and crops the edges."}</p>
        {error && <p className="mt-3 text-xs text-(--negative)">{error}</p>}
        <div className="mt-5 flex justify-end gap-2"><button onClick={onClose} className="rounded-lg px-4 py-2 text-xs text-(--text-2)">Cancel</button><button disabled={!file || busy} onClick={apply} className="rounded-lg bg-(--accent) px-4 py-2 text-xs font-bold text-(--text-1) disabled:cursor-not-allowed disabled:opacity-40">{busy ? "Converting…" : "Apply to artwork"}</button></div>
      </div>
    </div>
  );
}

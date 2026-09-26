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
      <div className="w-full max-w-lg rounded-2xl border border-[#2D2D44] bg-[#111122] p-5 shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div><p className="text-[10px] uppercase tracking-[0.2em] text-indigo-300">Your artwork</p><h2 id="pixel-import-title" className="mt-1 text-xl font-bold text-white">Import image</h2></div>
          <button onClick={onClose} className="text-xl text-[#64748B] hover:text-white" aria-label="Close">×</button>
        </div>
        <button onClick={() => inputRef.current?.click()} className="flex min-h-40 w-full items-center justify-center rounded-xl border border-dashed border-[#3A3A5A] bg-[#0B0B18] p-4 text-sm text-[#94A3B8] hover:border-indigo-400">
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
          {(["fit", "fill"] as const).map((value) => <button key={value} onClick={() => setMode(value)} className={`flex-1 rounded-lg px-3 py-2 text-xs uppercase tracking-wider ${mode === value ? "bg-indigo-500 text-white" : "bg-[#1A1A2E] text-[#64748B]"}`}>{value}</button>)}
        </div>
        <p className="mt-3 text-xs text-[#64748B]">{mode === "fit" ? "Keeps the full image with transparent padding." : "Fills the grid and crops the edges."}</p>
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2"><button onClick={onClose} className="rounded-lg px-4 py-2 text-xs text-[#94A3B8]">Cancel</button><button disabled={!file || busy} onClick={apply} className="rounded-lg bg-indigo-500 px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">{busy ? "Converting…" : "Apply to artwork"}</button></div>
      </div>
    </div>
  );
}

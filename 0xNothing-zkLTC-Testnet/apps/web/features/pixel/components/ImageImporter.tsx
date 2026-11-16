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

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      // aria-modal: keep Tab and Shift+Tab inside the dialog.
      const dialog = dialogRef.current;
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])"),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="pixel-import-title" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div ref={dialogRef} className="w-full max-w-lg rounded-2xl border border-(--line) bg-(--surface-2) p-5 shadow-(--e-3)">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div><p className="text-xs text-(--text-3)">Your artwork</p><h2 id="pixel-import-title" className="mt-1 text-xl font-bold text-(--text-1)">Import image</h2></div>
          <button type="button" disabled={busy} onClick={onClose} className="relative text-xl text-(--text-3) hover:text-(--text-1) after:absolute after:-inset-x-3.5 after:-inset-y-1.5" aria-label="Close"><span aria-hidden="true">×</span></button>
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
          {(["fit", "fill"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} aria-describedby="pixel-import-mode-help" onClick={() => setMode(value)} className={`flex-1 min-h-10 rounded-lg border border-transparent px-3 py-2 text-xs uppercase ${mode === value ? "bg-(--accent)/20 text-(--accent-text)" : "bg-(--surface-1) text-(--text-3)"}`}>{value}</button>)}
        </div>
        <p id="pixel-import-mode-help" className="mt-3 text-xs text-(--text-3)">{mode === "fit" ? "Keeps the full image with transparent padding." : "Fills the grid and crops the edges."}</p>
        {error && <p className="mt-3 text-xs text-(--negative)" role="alert">{error}</p>}
        <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className="pixel-btn pixel-btn-secondary">Cancel</button><button type="button" aria-busy={busy || undefined} disabled={!file || busy} onClick={apply} className="pixel-btn pixel-btn-indigo">{busy ? "Converting…" : "Apply to artwork"}</button></div>
      </div>
    </div>
  );
}

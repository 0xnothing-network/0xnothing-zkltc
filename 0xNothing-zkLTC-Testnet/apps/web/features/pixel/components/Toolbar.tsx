"use client";

import { memo, useState, useEffect } from "react";

interface ToolbarProps {
  selectedColor: string;
  onColorChange: (color: string) => void;
  gridSize: number;
  onGridSizeChange: (size: number) => void;
  onClear: () => void;
  onImport: () => void;
}

const PALETTE_COLORS = [
  "#000000", "#ffffff", "#808080", "#c0c0c0",
  "#ff0000", "#ee4b2b", "#ff4444", "#aa0000",
  "#ff8800", "#ffcc00", "#00cc00", "#008800",
  "#0000ff", "#0088ff", "#00aaff", "#9400d3",
  "#ff00ff", "#ff69b4", "#8b4513", "#333333",
  "#39ff14", "#00ffff", "#ffff00", "#f5deb3",
  "#deb887", "#a0522d", "#2f4f4f", "#191970",
  "#800000", "#ffd700", "#006400", "#00008b",
];

const GRID_OPTIONS = [8, 16, 32, 64, 128, 256];

export const Toolbar = memo(function Toolbar({
  selectedColor,
  onColorChange,
  gridSize,
  onGridSizeChange,
  onClear,
  onImport,
}: ToolbarProps) {
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [customHex, setCustomHex] = useState(selectedColor);

  useEffect(() => { setCustomHex(selectedColor); }, [selectedColor]);

  const handleColorSelect = (color: string) => {
    onColorChange(color);
    if (!recentColors.includes(color) && color !== "transparent") {
      setRecentColors((prev) => [color, ...prev.slice(0, 7)]);
    }
  };

  return (
    <div
      className="pixel-tools-panel animate-fadeInUp bg-(--surface-1) rounded-2xl p-3 sm:p-5 border border-(--line) flex flex-col gap-4 sm:gap-6"
    >
      <>
          <button
            onClick={onImport}
            className="w-full rounded-xl border border-(--accent)/40 bg-(--accent)/10 py-3 text-xs font-bold uppercase tracking-wider text-(--accent-text) transition-colors hover:bg-(--accent)/20"
          >
            Import Image
          </button>
          {/* Color Palette Section */}
          <div>
            <p
              className="text-(--text-3) text-xs uppercase tracking-wider mb-2"
              style={{ fontFamily: "var(--font-ui)" }}
            >
              Color Palette
            </p>
            <div className="grid grid-cols-8 sm:grid-cols-8 gap-1.5 mb-3">
              {PALETTE_COLORS.map((color) => (
                <ColorButton
                  key={color}
                  color={color}
                  isSelected={selectedColor === color}
                  onClick={() => handleColorSelect(color)}
                />
              ))}
            </div>

            {/* Current color preview */}
            <div className="flex items-center gap-2.5 mb-3">
              <div
                className="w-10 h-10 rounded-xl border border-(--text-1)/10 flex-shrink-0"
                style={{ backgroundColor: selectedColor }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-(--text-1) text-xs font-medium mb-0.5">
                  {selectedColor}
                </p>
                <p
                  className="text-(--text-3) text-xs uppercase"
                  style={{ fontFamily: "var(--font-ui)" }}
                >
                  Current
                </p>
              </div>
            </div>

            {/* Custom color input */}
            <div>
              <p
                className="text-(--text-3) text-xs uppercase tracking-wider mb-1.5"
                style={{ fontFamily: "var(--font-ui)" }}
              >
                Custom Color
              </p>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={customHex}
                  onChange={(e) => {
                    setCustomHex(e.target.value);
                    handleColorSelect(e.target.value);
                  }}
                className="w-11 h-10 sm:w-10 sm:h-9 rounded-lg cursor-pointer border border-(--line) bg-transparent flex-shrink-0"
                />
                <input
                  type="text"
                  value={customHex}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCustomHex(val);
                    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                      handleColorSelect(val);
                    }
                  }}
                  placeholder="#RRGGBB"
                  maxLength={7}
                  className="flex-1 min-w-0 w-full bg-(--surface-2) border border-(--line) rounded-xl px-3 py-2.5 sm:py-2 text-(--text-1) text-xs placeholder-(--text-3) focus:outline-none focus:border-(--accent) transition-all uppercase"
                  style={{ fontFamily: "var(--font-num)" }}
                />
              </div>
            </div>
          </div>

          {/* Recent colors */}
          {recentColors.length > 0 && (
            <div>
              <p
                className="text-(--text-3) text-xs uppercase tracking-wider mb-2"
                style={{ fontFamily: "var(--font-ui)" }}
              >
                Recent
              </p>
              <div className="flex gap-1.5 flex-wrap">
                {recentColors.map((color, i) => (
                  <button
                    key={`${color}-${i}`}
                    onClick={() => handleColorSelect(color)}
                    className="w-6 h-6 rounded-md transition-all duration-100 hover:scale-110"
                    style={{
                      backgroundColor: color,
                      outline: selectedColor === color ? "2px solid var(--text-1)" : "2px solid transparent",
                      outlineOffset: "1px",
                    }}
                    title={color}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Grid Size Selector */}
          <div>
            <p
              className="text-(--text-3) text-xs uppercase tracking-wider mb-2"
              style={{ fontFamily: "var(--font-ui)" }}
            >
              Grid Size
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {GRID_OPTIONS.map((size) => (
                <button
                  key={size}
                  onClick={() => onGridSizeChange(size)}
                  className={
                    "flex-1 py-2.5 sm:py-2 rounded-xl text-xs font-bold transition-all " +
                    (gridSize === size
                      ? "bg-(--accent) text-(--accent-ink)"
                      : "bg-(--surface-2) border border-(--line) text-(--text-3) hover:bg-(--surface-1) hover:text-(--text-1)")
                  }
                  style={{ fontFamily: "var(--font-ui)" }}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          {/* Clear */}
          <button
            onClick={onClear}
            className="w-full py-3 sm:py-2.5 rounded-xl bg-(--negative)/10 border border-(--negative)/20 text-(--negative) text-xs font-bold uppercase tracking-wider hover:bg-(--negative)/20 hover:border-(--negative)/30 active:translate-y-[1px] transition-all flex items-center justify-center gap-1.5"
            style={{ fontFamily: "var(--font-ui)" }}
          >
            <svg
              width="10"
              height="10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"
              />
            </svg>
            Clear Canvas
          </button>
      </>
    </div>
  );
});

function ColorButton({
  color,
  isSelected,
  onClick,
}: {
  color: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="pixel-color-button aspect-square min-h-8 rounded sm:min-h-0"
      style={{
        backgroundColor: color,
        outline: isSelected ? "2px solid var(--text-1)" : "2px solid transparent",
        outlineOffset: "1px",
      }}
      title={color}
    />
  );
}

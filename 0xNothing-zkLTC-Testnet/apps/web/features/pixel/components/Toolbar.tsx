"use client";

import { memo, useState, useEffect } from "react";

interface ToolbarProps {
  selectedColor: string;
  onColorChange: (color: string) => void;
  gridSize: number;
  onGridSizeChange: (size: number) => void;
  onClear: () => void;
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

const GRID_OPTIONS = [8, 16, 32, 64];

export const Toolbar = memo(function Toolbar({
  selectedColor,
  onColorChange,
  gridSize,
  onGridSizeChange,
  onClear,
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
      className="animate-fadeInUp bg-[#1A1A2E] rounded-2xl p-3 sm:p-5 border border-[#2D2D44] flex flex-col gap-4 sm:gap-6"
    >
      <>
          {/* Color Palette Section */}
          <div>
            <p
              className="text-[#64748B] text-[11px] uppercase tracking-wider mb-2"
              style={{ fontFamily: "var(--font-departure)" }}
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
                className="w-10 h-10 rounded-xl border border-white/10 flex-shrink-0"
                style={{ backgroundColor: selectedColor }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-white text-xs font-medium mb-0.5">
                  {selectedColor}
                </p>
                <p
                  className="text-[#374151] text-[10px] uppercase"
                  style={{ fontFamily: "var(--font-departure)" }}
                >
                  Current
                </p>
              </div>
            </div>

            {/* Custom color input */}
            <div>
              <p
                className="text-[#64748B] text-[11px] uppercase tracking-wider mb-1.5"
                style={{ fontFamily: "var(--font-departure)" }}
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
                className="w-11 h-10 sm:w-10 sm:h-9 rounded-lg cursor-pointer border border-[#2D2D44] bg-transparent flex-shrink-0"
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
                  className="flex-1 bg-[#0F0F23] border border-[#2D2D44] rounded-xl px-3 py-2.5 sm:py-2 text-white text-xs placeholder-[#374151] focus:outline-none focus:border-indigo-500 transition-all uppercase"
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              </div>
            </div>
          </div>

          {/* Recent colors */}
          {recentColors.length > 0 && (
            <div>
              <p
                className="text-[#64748B] text-[11px] uppercase tracking-wider mb-2"
                style={{ fontFamily: "var(--font-departure)" }}
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
                      outline: selectedColor === color ? "2px solid white" : "2px solid transparent",
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
              className="text-[#64748B] text-[11px] uppercase tracking-wider mb-2"
              style={{ fontFamily: "var(--font-departure)" }}
            >
              Grid Size
            </p>
            <div className="flex gap-1.5">
              {GRID_OPTIONS.map((size) => (
                <button
                  key={size}
                  onClick={() => onGridSizeChange(size)}
                  className={
                    "flex-1 py-2.5 sm:py-2 rounded-xl text-xs font-bold transition-all " +
                    (gridSize === size
                      ? "bg-indigo-500 text-white"
                      : "bg-[#0F0F23] border border-[#2D2D44] text-[#64748B] hover:bg-[#1A1A2E] hover:text-white")
                  }
                  style={{ fontFamily: "var(--font-departure)" }}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          {/* Clear */}
          <button
            onClick={onClear}
            className="w-full py-3 sm:py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-bold uppercase tracking-wider hover:bg-red-500/20 hover:border-red-500/30 active:translate-y-[1px] transition-all flex items-center justify-center gap-1.5"
            style={{ fontFamily: "var(--font-departure)" }}
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
        outline: isSelected ? "2px solid white" : "2px solid transparent",
        outlineOffset: "1px",
      }}
      title={color}
    />
  );
}

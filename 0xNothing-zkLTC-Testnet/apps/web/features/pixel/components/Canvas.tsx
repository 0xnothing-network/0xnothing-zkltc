"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { downloadAsPNG, downloadAsJSON, pixelDataToJSON } from "@/lib/gridParser";

interface CanvasProps {
  gridSize: number;
  pixelData: string[][];
  setPixelData: React.Dispatch<React.SetStateAction<string[][]>>;
  selectedColor: string;
  onColorPick?: (color: string) => void;
  onStrokeStart?: (dataBeforeStroke: string[][]) => void;
  onUndo?: () => void;
  canUndo?: boolean;
}

type Tool = "pencil" | "eraser" | "fill" | "picker";
type Symmetry = "none" | "horizontal" | "vertical" | "both";
type GridPoint = { x: number; y: number };

const BRUSH_SIZES = [1, 2, 3, 4];
const SUBDIVISION_OPTIONS = [0, 2, 4, 8];

function rasterizeGridLine(start: GridPoint, end: GridPoint): GridPoint[] {
  const points: GridPoint[] = [];
  let x = start.x;
  let y = start.y;
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  const stepX = start.x < end.x ? 1 : -1;
  const stepY = start.y < end.y ? 1 : -1;
  let error = dx - dy;

  while (true) {
    points.push({ x, y });
    if (x === end.x && y === end.y) break;
    const doubledError = error * 2;
    if (doubledError > -dy) {
      error -= dy;
      x += stepX;
    }
    if (doubledError < dx) {
      error += dx;
      y += stepY;
    }
  }
  return points;
}

export function Canvas({
  gridSize,
  pixelData,
  setPixelData,
  selectedColor,
  onColorPick,
  onStrokeStart,
  onUndo,
  canUndo,
}: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const previewRafRef = useRef<number | null>(null);
  const pendingPreviewRef = useRef<GridPoint | null>(null);
  const isDrawingRef = useRef(false);
  const isPanningRef = useRef(false);
  const lastPaintPointRef = useRef<GridPoint | null>(null);
  const strokeHistoryCapturedRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const activePointerRef = useRef<number | null>(null);
  const currentToolRef = useRef<Tool>("pencil");
  const selectedColorRef = useRef(selectedColor);
  const pixelDataRef = useRef(pixelData);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [currentTool, setCurrentTool] = useState<Tool>("pencil");
  const [brushSize, setBrushSize] = useState(1);
  const [symmetry, setSymmetry] = useState<Symmetry>("none");
  const [subdivision, setSubdivision] = useState(0);

  const brushSizeRef = useRef(brushSize);
  const symmetryRef = useRef(symmetry);

  useEffect(() => { currentToolRef.current = currentTool; }, [currentTool]);
  useEffect(() => { selectedColorRef.current = selectedColor; }, [selectedColor]);
  useEffect(() => { brushSizeRef.current = brushSize; }, [brushSize]);
  useEffect(() => { symmetryRef.current = symmetry; }, [symmetry]);

  const getGridCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return null;
    const rect = canvas.getBoundingClientRect();
    const containerSize = Math.min(container.clientWidth, container.clientHeight);
    const cs = Math.floor(containerSize / gridSize);
    const gridDisplaySize = cs * gridSize * zoom;
    const offsetX = (container.clientWidth - gridDisplaySize) / 2 - pan.x * zoom;
    const offsetY = (container.clientHeight - gridDisplaySize) / 2 - pan.y * zoom;
    const clickX = clientX - rect.left;
    const clickY = clientY - rect.top;
    const gridX = Math.floor((clickX - offsetX) / (cs * zoom));
    const gridY = Math.floor((clickY - offsetY) / (cs * zoom));
    return { x: gridX, y: gridY, cs, offsetX, offsetY, gridDisplaySize };
  }, [gridSize, zoom, pan]);

  const drawGrid = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const containerSize = Math.min(container.clientWidth, container.clientHeight);
      const cs = Math.floor(containerSize / gridSize);
      const gridDisplaySize = cs * gridSize * zoom;
      const offsetX = (container.clientWidth - gridDisplaySize) / 2 - pan.x * zoom;
      const offsetY = (container.clientHeight - gridDisplaySize) / 2 - pan.y * zoom;

      if (canvas.width !== container.clientWidth || canvas.height !== container.clientHeight) {
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
      }

      ctx.fillStyle = "#050505";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "#0f0f0f";
      ctx.fillRect(offsetX, offsetY, gridDisplaySize, gridDisplaySize);

      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const color = pixelDataRef.current[y]?.[x];
          if (color && color !== "transparent") {
            ctx.fillStyle = color;
            const px = offsetX + x * cs * zoom;
            const py = offsetY + y * cs * zoom;
            ctx.fillRect(px, py, cs * zoom, cs * zoom);

            ctx.fillStyle = "rgba(255,255,255,0.12)";
            ctx.fillRect(px, py, cs * zoom, 1);
            ctx.fillRect(px, py, 1, cs * zoom);

            ctx.fillStyle = "rgba(0,0,0,0.18)";
            ctx.fillRect(px, py + cs * zoom - 1, cs * zoom, 1);
            ctx.fillRect(px + cs * zoom - 1, py, 1, cs * zoom);
          }
        }
      }

      ctx.strokeStyle = zoom >= 1.5 ? "#303030" : "#242424";
      ctx.lineWidth = zoom >= 1.5 ? 1 : 0.5;
      for (let i = 0; i <= gridSize; i++) {
        const px = offsetX + i * cs * zoom;
        ctx.beginPath();
        ctx.moveTo(px, offsetY);
        ctx.lineTo(px, offsetY + gridDisplaySize);
        ctx.stroke();

        const py = offsetY + i * cs * zoom;
        ctx.beginPath();
        ctx.moveTo(offsetX, py);
        ctx.lineTo(offsetX + gridDisplaySize, py);
        ctx.stroke();
      }

      const centerH = offsetX + gridDisplaySize / 2;
      const centerV = offsetY + gridDisplaySize / 2;

      if (symmetry === "horizontal" || symmetry === "both") {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(centerH, offsetY);
        ctx.lineTo(centerH, offsetY + gridDisplaySize);
        ctx.stroke();
      }

      if (symmetry === "vertical" || symmetry === "both") {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(offsetX, centerV);
        ctx.lineTo(offsetX + gridDisplaySize, centerV);
        ctx.stroke();
      }

      if (subdivision > 0) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        const subCount = gridSize / subdivision;
        for (let i = 1; i < subCount; i++) {
          const px = offsetX + i * subdivision * cs * zoom;
          ctx.beginPath();
          ctx.moveTo(px, offsetY);
          ctx.lineTo(px, offsetY + gridDisplaySize);
          ctx.stroke();

          const py = offsetY + i * subdivision * cs * zoom;
          ctx.beginPath();
          ctx.moveTo(offsetX, py);
          ctx.lineTo(offsetX + gridDisplaySize, py);
          ctx.stroke();
        }
      }

      ctx.setLineDash([]);
    });
  }, [gridSize, zoom, pan, symmetry, subdivision]);

  const drawPreview = useCallback((gridX: number, gridY: number) => {
    const previewCanvas = previewCanvasRef.current;
    const container = containerRef.current;
    if (!previewCanvas || !container) return;
    const pctx = previewCanvas.getContext("2d");
    if (!pctx) return;

    const containerSize = Math.min(container.clientWidth, container.clientHeight);
    const cs = Math.floor(containerSize / gridSize);
    const gridDisplaySize = cs * gridSize * zoom;
    const offsetX = (container.clientWidth - gridDisplaySize) / 2 - pan.x * zoom;
    const offsetY = (container.clientHeight - gridDisplaySize) / 2 - pan.y * zoom;

    if (previewCanvas.width !== container.clientWidth || previewCanvas.height !== container.clientHeight) {
      previewCanvas.width = container.clientWidth;
      previewCanvas.height = container.clientHeight;
    }

    pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

    const color = selectedColorRef.current;
    const tool = currentToolRef.current;
    const half = Math.floor(brushSizeRef.current / 2);

    const paintPixel = (px: number, py: number) => {
      if (px < 0 || px >= gridSize || py < 0 || py >= gridSize) return;
      const drawX = offsetX + px * cs * zoom;
      const drawY = offsetY + py * cs * zoom;
      if (tool === "eraser") {
        pctx.fillStyle = "rgba(255, 80, 80, 0.4)";
        pctx.strokeStyle = "rgba(255, 80, 80, 0.8)";
      } else {
        pctx.fillStyle = color + "60";
        pctx.strokeStyle = color + "cc";
      }
      pctx.fillRect(drawX, drawY, cs * zoom, cs * zoom);
      pctx.lineWidth = 1.5;
      pctx.strokeRect(drawX + 0.5, drawY + 0.5, cs * zoom - 1, cs * zoom - 1);
    };

    const paintBrush = (cx: number, cy: number) => {
      for (let dy = -half; dy < brushSizeRef.current - half; dy++) {
        for (let dx = -half; dx < brushSizeRef.current - half; dx++) {
          paintPixel(cx + dx, cy + dy);
        }
      }
    };

    paintBrush(gridX, gridY);

    const sym = symmetryRef.current;
    if (sym !== "none") {
      const mirrorH = gridSize - 1 - gridX;
      const mirrorV = gridSize - 1 - gridY;
      if (sym === "horizontal" || sym === "both") {
        paintBrush(mirrorH, gridY);
      }
      if (sym === "vertical" || sym === "both") {
        paintBrush(gridX, mirrorV);
      }
      if (sym === "both") {
        paintBrush(mirrorH, mirrorV);
      }
    }
  }, [gridSize, zoom, pan]);

  const clearPreview = useCallback(() => {
    pendingPreviewRef.current = null;
    if (previewRafRef.current !== null) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
    const previewCanvas = previewCanvasRef.current;
    if (!previewCanvas) return;
    const context = previewCanvas.getContext("2d");
    context?.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  }, []);

  const schedulePreview = useCallback((x: number, y: number) => {
    pendingPreviewRef.current = { x, y };
    if (previewRafRef.current !== null) return;
    previewRafRef.current = requestAnimationFrame(() => {
      previewRafRef.current = null;
      const point = pendingPreviewRef.current;
      pendingPreviewRef.current = null;
      if (point) drawPreview(point.x, point.y);
    });
  }, [drawPreview]);

  useEffect(() => {
    pixelDataRef.current = pixelData;
    drawGrid();
  }, [drawGrid, pixelData]);

  useEffect(() => {
    const handleResize = () => drawGrid();
    window.addEventListener("resize", handleResize, { passive: true });
    return () => {
      window.removeEventListener("resize", handleResize);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (previewRafRef.current !== null) {
        cancelAnimationFrame(previewRafRef.current);
        previewRafRef.current = null;
      }
      pendingPreviewRef.current = null;
    };
  }, [drawGrid]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      const editingText = target instanceof HTMLElement
        && (target.isContentEditable || target.matches("input, textarea, select"));
      if (!editingText && canUndo && onUndo && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        onUndo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canUndo, onUndo]);

  const captureStrokeHistory = useCallback(() => {
    if (strokeHistoryCapturedRef.current) return;
    onStrokeStart?.(pixelDataRef.current);
    strokeHistoryCapturedRef.current = true;
  }, [onStrokeStart]);

  const floodFill = useCallback((startX: number, startY: number, fillColor: string) => {
    const source = pixelDataRef.current;
    const targetColor = source[startY]?.[startX] || "transparent";
    if (targetColor === fillColor) return;

    const newData = source.map(row => [...row]);
    const stack: [number, number][] = [[startX, startY]];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      const key = `${x},${y}`;
      if (visited.has(key)) continue;
      visited.add(key);

      if (
        x < 0 || x >= gridSize ||
        y < 0 || y >= gridSize ||
        (newData[y]?.[x] || "transparent") !== targetColor
      ) continue;

      newData[y][x] = fillColor;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }

    pixelDataRef.current = newData;
    setPixelData(newData);
  }, [gridSize, setPixelData]);

  const paintPixels = useCallback((
    points: readonly GridPoint[],
    tool: Tool,
    color: string,
    beforeChange?: () => void,
  ) => {
    const fillColor = tool === "eraser" ? "transparent" : color;
    const activeBrushSize = brushSizeRef.current;
    const activeSymmetry = symmetryRef.current;
    const half = Math.floor(activeBrushSize / 2);
    const coordinates = new Set<number>();

    const collectPixel = (px: number, py: number) => {
      if (px < 0 || px >= gridSize || py < 0 || py >= gridSize) return;
      if (pixelDataRef.current[py]?.[px] === fillColor) return;
      coordinates.add(py * gridSize + px);
    };

    for (const point of points) {
      for (let dy = -half; dy < activeBrushSize - half; dy++) {
        for (let dx = -half; dx < activeBrushSize - half; dx++) {
          const cx = point.x + dx;
          const cy = point.y + dy;
          collectPixel(cx, cy);

          if (activeSymmetry !== "none") {
            const mirrorH = gridSize - 1 - cx;
            const mirrorV = gridSize - 1 - cy;
            if (activeSymmetry === "horizontal" || activeSymmetry === "both") {
              collectPixel(mirrorH, cy);
            }
            if (activeSymmetry === "vertical" || activeSymmetry === "both") {
              collectPixel(cx, mirrorV);
            }
            if (activeSymmetry === "both") {
              collectPixel(mirrorH, mirrorV);
            }
          }
        }
      }
    }

    if (coordinates.size === 0) return;
    beforeChange?.();
    setPixelData(prev => {
      const next = [...prev];
      const clonedRows = new Set<number>();
      let changed = false;
      for (const coordinate of coordinates) {
        const py = Math.floor(coordinate / gridSize);
        const px = coordinate % gridSize;
        if (prev[py]?.[px] === fillColor) continue;
        if (!clonedRows.has(py)) {
          next[py] = [...prev[py]];
          clonedRows.add(py);
        }
        next[py][px] = fillColor;
        changed = true;
      }
      if (changed) pixelDataRef.current = next;
      return changed ? next : prev;
    });
  }, [gridSize, setPixelData]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== null && activePointerRef.current !== e.pointerId) return;
    activePointerRef.current = e.pointerId;
    strokeHistoryCapturedRef.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);

    if (e.pointerType === "mouse" && (e.button === 1 || e.button === 2)) {
      e.preventDefault();
      isPanningRef.current = true;
      lastPaintPointRef.current = null;
      panStartRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    const coords = getGridCoords(e.clientX, e.clientY);
    if (!coords || coords.x < 0 || coords.x >= gridSize || coords.y < 0 || coords.y >= gridSize) return;

    isDrawingRef.current = true;
    const tool = currentToolRef.current;

    if (tool === "fill") {
      isDrawingRef.current = false;
      lastPaintPointRef.current = null;
      const targetColor = pixelDataRef.current[coords.y]?.[coords.x] || "transparent";
      if (targetColor === selectedColorRef.current) return;
      captureStrokeHistory();
      floodFill(coords.x, coords.y, selectedColorRef.current);
      return;
    }

    if (tool === "picker") {
      isDrawingRef.current = false;
      lastPaintPointRef.current = null;
      const pickedColor = pixelDataRef.current[coords.y]?.[coords.x];
      if (pickedColor && pickedColor !== "transparent" && onColorPick) {
        onColorPick(pickedColor);
      }
      return;
    }

    const point = { x: coords.x, y: coords.y };
    lastPaintPointRef.current = point;
    paintPixels([point], tool, selectedColorRef.current, captureStrokeHistory);
  }, [captureStrokeHistory, getGridCoords, gridSize, floodFill, paintPixels, onColorPick]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== null && activePointerRef.current !== e.pointerId) return;

    if (isPanningRef.current) {
      const dx = (e.clientX - panStartRef.current.x) / zoom;
      const dy = (e.clientY - panStartRef.current.y) / zoom;
      panStartRef.current = { x: e.clientX, y: e.clientY };
      setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      return;
    }

    const coords = getGridCoords(e.clientX, e.clientY);

    if (!isDrawingRef.current) {
      if (coords) {
        if (coords.x >= 0 && coords.x < gridSize && coords.y >= 0 && coords.y < gridSize) {
          schedulePreview(coords.x, coords.y);
        } else {
          clearPreview();
        }
      }
      return;
    }

    if (!coords || coords.x < 0 || coords.x >= gridSize || coords.y < 0 || coords.y >= gridSize) {
      lastPaintPointRef.current = null;
      return;
    }

    const tool = currentToolRef.current;
    if (tool === "pencil" || tool === "eraser") {
      const currentPoint = { x: coords.x, y: coords.y };
      const previousPoint = lastPaintPointRef.current ?? currentPoint;
      paintPixels(
        rasterizeGridLine(previousPoint, currentPoint),
        tool,
        selectedColorRef.current,
        captureStrokeHistory,
      );
      lastPaintPointRef.current = currentPoint;
    }
  }, [captureStrokeHistory, clearPreview, getGridCoords, zoom, gridSize, paintPixels, schedulePreview]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== e.pointerId) return;
    isDrawingRef.current = false;
    isPanningRef.current = false;
    lastPaintPointRef.current = null;
    strokeHistoryCapturedRef.current = false;
    activePointerRef.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const handlePointerLeave = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== null && activePointerRef.current !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    isDrawingRef.current = false;
    isPanningRef.current = false;
    lastPaintPointRef.current = null;
    strokeHistoryCapturedRef.current = false;
    activePointerRef.current = null;
    clearPreview();
  }, [clearPreview]);

  return (
    <div className="flex w-full flex-col items-center gap-3">
      {/* Toolbar Bar */}
      <div className="canvas-tool-strip flex w-full max-w-[min(100%,640px)] flex-nowrap items-center gap-1.5 overflow-x-auto overscroll-x-contain pb-1 sm:flex-wrap sm:justify-center">
        {/* Tools */}
        <div className="flex flex-shrink-0 gap-0.5 bg-[#1A1A2E] rounded-xl p-1 border border-[#2D2D44]">
          <ToolButton active={currentTool === "pencil"} onClick={() => setCurrentTool("pencil")} title="Pencil">
            <PencilIcon />
          </ToolButton>
          <ToolButton active={currentTool === "eraser"} onClick={() => setCurrentTool("eraser")} title="Eraser">
            <EraserIcon />
          </ToolButton>
          <ToolButton active={currentTool === "fill"} onClick={() => setCurrentTool("fill")} title="Fill">
            <FillIcon />
          </ToolButton>
          <ToolButton active={currentTool === "picker"} onClick={() => setCurrentTool("picker")} title="Color Picker">
            <PickerIcon />
          </ToolButton>

          <div className="w-px h-6 bg-[#2D2D44] mx-0.5 self-center" />

          <button
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-100 ${canUndo ? "text-[#94A3B8] hover:text-white hover:bg-white/5" : "text-[#374151] cursor-not-allowed"}`}
          >
            <UndoIcon />
          </button>
        </div>

        {/* Zoom */}
        <div className="flex flex-shrink-0 items-center gap-0.5 bg-[#1A1A2E] rounded-xl p-1 border border-[#2D2D44]">
          <button
            onClick={() => setZoom(z => Math.max(z / 1.5, 0.5))}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[#94A3B8] hover:text-white hover:bg-white/5 transition-all"
            title="Zoom Out"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <span className="text-[#94A3B8] text-[10px] w-10 text-center font-mono bg-white/5 rounded-md py-1" style={{ fontFamily: "var(--font-departure)" }}>
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom(z => Math.min(z * 1.5, 10))}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[#94A3B8] hover:text-white hover:bg-white/5 transition-all"
            title="Zoom In"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[#94A3B8] hover:text-white hover:bg-white/5 transition-all text-[10px] font-bold"
            title="Reset View"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            R
          </button>
        </div>

        {/* Brush Size */}
        <div className="flex flex-shrink-0 items-center gap-0.5 bg-[#1A1A2E] rounded-xl p-1 border border-[#2D2D44]">
          <span className="text-[#64748B] text-[9px] px-1 font-mono self-center" style={{ fontFamily: "var(--font-departure)" }}>SZ</span>
          {BRUSH_SIZES.map(size => (
            <button
              key={size}
              onClick={() => setBrushSize(size)}
              title={`Brush ${size}x${size}`}
              className={`w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold transition-all ${
                brushSize === size ? "bg-indigo-500/20 text-indigo-300" : "text-[#64748B] hover:text-white hover:bg-white/5"
              }`}
              style={{ fontFamily: "var(--font-departure)" }}
            >
              {size}
            </button>
          ))}
        </div>

        {/* Symmetry */}
        <div className="flex flex-shrink-0 items-center gap-0.5 bg-[#1A1A2E] rounded-xl p-1 border border-[#2D2D44]">
          <SymmetryButton active={symmetry === "horizontal"} onClick={() => setSymmetry(s => s === "horizontal" ? "none" : "horizontal")} title="Symmetry Horizontal">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v20" />
              <path d="M8 6l4-4 4 4" />
              <path d="M8 18l4 4 4-4" />
            </svg>
          </SymmetryButton>
          <SymmetryButton active={symmetry === "vertical"} onClick={() => setSymmetry(s => s === "vertical" ? "none" : "vertical")} title="Symmetry Vertical">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2 12h20" />
              <path d="M6 8l-4 4 4 4" />
              <path d="M18 8l4 4-4 4" />
            </svg>
          </SymmetryButton>
          <SymmetryButton active={symmetry === "both"} onClick={() => setSymmetry(s => s === "both" ? "none" : "both")} title="Symmetry Both">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v20" />
              <path d="M2 12h20" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
            </svg>
          </SymmetryButton>
        </div>

        {/* Subdivision */}
        <div className="flex flex-shrink-0 items-center gap-0.5 bg-[#1A1A2E] rounded-xl p-1 border border-[#2D2D44]">
          <span className="text-[#64748B] text-[9px] px-1 font-mono self-center" style={{ fontFamily: "var(--font-departure)" }}>GRID</span>
          {SUBDIVISION_OPTIONS.map(opt => (
            <button
              key={opt}
              onClick={() => setSubdivision(opt)}
              title={opt === 0 ? "No grid" : `${opt}x${opt} sub-grid`}
              className={`w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold transition-all ${
                subdivision === opt ? "bg-indigo-500/20 text-indigo-300" : "text-[#64748B] hover:text-white hover:bg-white/5"
              }`}
              style={{ fontFamily: "var(--font-departure)" }}
            >
              {opt === 0 ? "-" : opt}
            </button>
          ))}
        </div>

        <ExportMenu pixelData={pixelData} gridSize={gridSize} />
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="pixel-canvas-frame relative flex w-full max-w-[min(100%,520px)] items-center justify-center overflow-hidden rounded-xl border border-[#2D2D44] bg-[#0F0F23] shadow-2xl shadow-black/20"
        style={{
          aspectRatio: "1 / 1",
          touchAction: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            imageRendering: "pixelated",
            cursor: currentTool === "fill" ? "cell" : currentTool === "picker" ? "crosshair" : "crosshair",
            width: "100%",
            height: "100%",
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onWheel={e => { e.preventDefault(); setZoom(z => e.deltaY < 0 ? Math.min(z * 1.2, 10) : Math.max(z / 1.2, 0.5)); }}
          onContextMenu={e => e.preventDefault()}
        />
        <canvas
          ref={previewCanvasRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            imageRendering: "pixelated",
          }}
        />
      </div>

      <p className="text-center text-[#64748B] text-[10px]" style={{ fontFamily: "var(--font-departure)" }}>
        Drag to draw <span className="hidden sm:inline">&middot; Scroll to zoom &middot; Right-click to pan</span>
      </p>
    </div>
  );
}

function ToolButton({ children, active, onClick, title }: { children: React.ReactNode; active: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-100 ${
        active ? "bg-indigo-500/20 text-indigo-300" : "text-[#64748B] hover:text-white hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

function SymmetryButton({ children, active, onClick, title }: { children: React.ReactNode; active: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-100 ${
        active ? "bg-indigo-500/20 text-indigo-300" : "text-[#64748B] hover:text-white hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

function EraserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </svg>
  );
}

function FillIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z" />
      <path d="m5 2 5 5" />
      <path d="M2 13h15" />
      <path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z" />
    </svg>
  );
}

function PickerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m2 22 1-1h3l9-9" />
      <path d="M3 21v-3l9-9" />
      <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  );
}

function ExportMenu({ pixelData, gridSize }: { pixelData: string[][]; gridSize: number }) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 12 });
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasDrawing = pixelData.some(row => row.some(cell => cell !== "transparent"));

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        ref.current &&
        !ref.current.contains(target) &&
        (!menuRef.current || !menuRef.current.contains(target))
      ) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const updateMenuPosition = useCallback(() => {
    const button = ref.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const menuWidth = 184;
    setMenuPosition({
      top: Math.min(rect.bottom + 8, window.innerHeight - 150),
      right: Math.max(12, window.innerWidth - rect.right),
    });
    if (rect.left + menuWidth > window.innerWidth - 12) {
      setMenuPosition({
        top: Math.min(rect.bottom + 8, window.innerHeight - 150),
        right: 12,
      });
    }
  }, []);

  const toggleOpen = useCallback(() => {
    updateMenuPosition();
    setOpen((value) => !value);
  }, [updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition, { passive: true });
    window.addEventListener("scroll", updateMenuPosition, { passive: true });
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition);
    };
  }, [open, updateMenuPosition]);

  const actions = [
    {
      label: "COPY GRID DATA",
      icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>,
      onClick: () => { navigator.clipboard.writeText(pixelDataToJSON(pixelData, gridSize)); setOpen(false); },
    },
    {
      label: "PNG IMAGE",
      icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>,
      onClick: () => { downloadAsPNG(pixelData, gridSize); setOpen(false); },
    },
    {
      label: "DOWNLOAD GRID DATA",
      icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>,
      onClick: () => { downloadAsJSON(pixelData, gridSize); setOpen(false); },
    },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggleOpen}
        className="pixel-btn pixel-btn-secondary pixel-btn-sm flex items-center gap-1 text-[#64748B] hover:text-white"
        style={{ fontFamily: "var(--font-departure)" }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        EXPORT
        <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: "transform 80ms", transform: open ? "rotate(180deg)" : "" }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <>
          <div
            ref={menuRef}
            className="hidden sm:block fixed z-[90] w-[184px] rounded-lg border border-[#2D2D44] bg-[#1A1A2E] shadow-[4px_4px_0_0_#060614]"
            style={{
              top: menuPosition.top,
              right: menuPosition.right,
            }}
          >
            <ExportActions actions={actions} hasDrawing={hasDrawing} />
          </div>

          <div
            className="fixed inset-0 z-[90] flex items-end bg-black/50 backdrop-blur-sm p-3 sm:hidden"
            onClick={() => setOpen(false)}
          >
            <div
              className="w-full overflow-hidden rounded-2xl border border-[#2D2D44] bg-[#13133A] shadow-2xl shadow-black/40"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[#2D2D44] px-4 py-3">
                <div>
                  <p
                    className="text-[10px] font-bold uppercase tracking-wider text-[#8888ff]"
                    style={{ fontFamily: "var(--font-departure)" }}
                  >
                    Export
                  </p>
                  <p
                    className="mt-0.5 text-xs text-[#94A3B8]"
                    style={{ fontFamily: "var(--font-departure)" }}
                  >
                    Save or copy your pixel grid
                  </p>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#2D2D44] text-[#94A3B8] active:translate-y-px"
                  aria-label="Close export menu"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </div>
              <ExportActions actions={actions} hasDrawing={hasDrawing} mobile />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ExportActions({
  actions,
  hasDrawing,
  mobile,
}: {
  actions: Array<{ label: string; icon: React.ReactNode; onClick: () => void }>;
  hasDrawing: boolean;
  mobile?: boolean;
}) {
  return (
    <div>
      {actions.map((item, i, arr) => (
        <div key={item.label}>
          <button
            onClick={item.onClick}
            disabled={!hasDrawing}
            className={
              mobile
                ? "flex w-full items-center gap-3 px-4 py-4 text-left text-[#CBD5E1] transition-colors active:bg-white/5 disabled:cursor-not-allowed disabled:opacity-30"
                : "flex w-full items-center gap-2 px-3 py-2.5 text-left text-[#94A3B8] transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            }
            style={{
              fontFamily: "var(--font-departure)",
              fontSize: mobile ? 11 : 9,
              fontWeight: 700,
              letterSpacing: "0.05em",
            }}
          >
            <span className={mobile ? "flex h-8 w-8 items-center justify-center rounded-lg bg-[#0F0F23] text-[#8888ff]" : ""}>
              {item.icon}
            </span>
            {item.label}
          </button>
          {i < arr.length - 1 && <div className="h-px bg-[#2D2D44]" />}
        </div>
      ))}
    </div>
  );
}

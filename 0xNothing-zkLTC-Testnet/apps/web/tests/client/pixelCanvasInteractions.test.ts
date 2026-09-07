import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModule } from "../helpers/evaluateModule.ts";

type Element = { type: string | ((props: Record<string, unknown>) => Element); props: Record<string, unknown> };
type Ref = { current: unknown };
const jsx = (type: Element["type"], props: Element["props"]) => ({ type, props });
function find(root: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map((item) => find(item, predicate)).find(Boolean);
  if (!root || typeof root !== "object" || !("props" in root)) return undefined;
  const element = root as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}

test("symmetry hover preview matches painted cells for every brush size, including even brushes and edges", () => {
  for (const brushSize of [1, 2, 3, 4]) {
    for (const symmetry of ["none", "horizontal", "vertical", "both"]) {
      for (const point of [{ x: 3, y: 4 }, { x: 0, y: 0 }]) {
        let stateIndex = 0;
        let pixels = Array.from({ length: 8 }, () => Array<string>(8).fill("transparent"));
        const preview = new Set<string>();
        const frames: (() => void)[] = [];
        const { Canvas } = evaluateModule<{ Canvas: (props: Record<string, unknown>) => Element }>(
          new URL("../../features/pixel/components/Canvas.tsx", import.meta.url),
          {
            react: {
              useRef: (current: unknown) => ({ current }), useEffect: () => {},
              useCallback: (fn: unknown) => fn,
              useState: (initial: unknown) => [[1, { x: 0, y: 0 }, "pencil", brushSize, symmetry, 0][stateIndex++] ?? initial, () => {}],
            },
            "react/jsx-runtime": { jsx, jsxs: jsx },
            "@/lib/gridParser": {}, "@/components/Toast": { useToast: () => ({}) },
          },
          { requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {} },
        );
        const tree = Canvas({
          gridSize: 8, pixelData: pixels, selectedColor: "#ff0000",
          setPixelData: (update: string[][] | ((prev: string[][]) => string[][])) => { pixels = typeof update === "function" ? update(pixels) : update; },
        });
        const main = find(tree, (element) => element.type === "canvas" && typeof element.props.onPointerMove === "function")!;
        const overlay = find(tree, (element) => element.type === "canvas" && !element.props.onPointerMove)!;
        const container = find(tree, (element) => typeof element.props.className === "string" && element.props.className.startsWith("pixel-canvas-frame"))!;
        (container.props.ref as Ref).current = { clientWidth: 80, clientHeight: 80 };
        (main.props.ref as Ref).current = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
        (overlay.props.ref as Ref).current = {
          width: 80, height: 80,
          getContext: () => ({ clearRect() {}, strokeRect() {}, fillRect: (x: number, y: number) => preview.add(`${x / 10},${y / 10}`) }),
        };
        const pointer = { pointerId: 1, pointerType: "mouse", button: 0, clientX: point.x * 10 + 5, clientY: point.y * 10 + 5, currentTarget: {} };
        (main.props.onPointerMove as (event: unknown) => void)(pointer);
        for (const frame of frames) frame();
        (main.props.onPointerDown as (event: unknown) => void)(pointer);
        const painted = new Set<string>();
        pixels.forEach((row, y) => row.forEach((color, x) => { if (color !== "transparent") painted.add(`${x},${y}`); }));
        assert.deepEqual([...preview].sort(), [...painted].sort(), `${brushSize}px ${symmetry} at ${point.x},${point.y}`);
      }
    }
  }
});

test("copy-grid export keeps the menu usable on clipboard failure and closes only after success", async () => {
  for (const outcome of ["blocked", "missing", "success"]) {
    let exportMode = false;
    let stateIndex = 0;
    const closes: unknown[] = [];
    const errors: string[] = [];
    const copied: string[] = [];
    let finishCopy!: () => void;
    const copyReady = new Promise<void>((resolve) => { finishCopy = resolve; });
    const { Canvas } = evaluateModule<{ Canvas: (props: Record<string, unknown>) => Element }>(
      new URL("../../features/pixel/components/Canvas.tsx", import.meta.url),
      {
        react: {
          useRef: (current: unknown) => ({ current }), useEffect: () => {}, useCallback: (fn: unknown) => fn,
          useState: (initial: unknown) => {
            const isOpenState = exportMode && stateIndex++ === 0;
            return [isOpenState ? true : initial, (value: unknown) => { if (isOpenState) closes.push(value); }];
          },
        },
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "@/lib/gridParser": { pixelDataToJSON: () => "grid-data" },
        "@/components/Toast": { useToast: () => ({ error: (title: string) => errors.push(title) }) },
      },
      {
        navigator: outcome === "missing" ? {} : {
          clipboard: { writeText: async (text: string) => { await copyReady; if (outcome === "blocked") throw new Error("NotAllowedError"); copied.push(text); } },
        },
      },
    );
    const tree = Canvas({ gridSize: 1, pixelData: [["#ff0000"]], selectedColor: "#ff0000", setPixelData() {} });
    const menu = find(tree, (element) => typeof element.type === "function" && "pixelData" in element.props)!;
    exportMode = true;
    const menuTree = (menu.type as (props: Record<string, unknown>) => Element)(menu.props);
    const actions = find(menuTree, (element) => Array.isArray(element.props.actions))!.props.actions as Array<{ label: string; onClick: () => Promise<void> }>;
    const pendingCopy = actions.find((action) => action.label === "COPY GRID DATA")!.onClick();
    assert.deepEqual(closes, [], "the menu remains open while the clipboard operation is pending");
    finishCopy();
    await assert.doesNotReject(async () => pendingCopy);
    if (outcome === "success") {
      assert.deepEqual(copied, ["grid-data"]);
      assert.deepEqual(closes, [false]);
      assert.deepEqual(errors, []);
    } else {
      assert.deepEqual(closes, []);
      assert.equal(errors.length, 1);
      assert.deepEqual(copied, []);
    }
  }
});

"use client";

import { memo, useEffect, useRef } from "react";

const DPR_LIMIT = 1.5;
const PARTICLE_COUNT = 42;
const HALO_IDLE_DELAY = 100;
const SPAWN_DISTANCE = 11;

type Particle = {
  active: boolean;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  size: number;
  age: number;
  lifetime: number;
  opacity: number;
};

const COLORS = {
  pump: { red: 119, green: 255, blue: 177, haloAlpha: 0.05, pixelAlpha: 0.15 },
  fi: { red: 181, green: 240, blue: 206, haloAlpha: 0.04, pixelAlpha: 0.12 },
} as const;

function PixelMistComponent({ product }: { product: "fi" | "pump" }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const finePointer = window.matchMedia("(any-hover: hover) and (any-pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const color = COLORS[product];
    const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => ({
      active: false,
      x: 0,
      y: 0,
      velocityX: 0,
      velocityY: 0,
      size: 0,
      age: 0,
      lifetime: 0,
      opacity: 0,
    }));

    let enabled = finePointer.matches && !reducedMotion.matches;
    let frame = 0;
    let width = 0;
    let height = 0;
    let lastFrameTime = 0;
    let lastMoveTime = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let previousX = 0;
    let previousY = 0;
    let spawnRemainder = 0;
    let haloTarget = 0;
    let haloOpacity = 0;
    let particleCursor = 0;
    let randomState = product === "pump" ? 0x9e3779b9 : 0x85ebca6b;
    let hasPointer = false;

    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 4294967296;
    };

    const rgba = (alpha: number) =>
      `rgba(${color.red}, ${color.green}, ${color.blue}, ${alpha})`;

    const spawnParticle = (x: number, y: number, directionX: number, directionY: number) => {
      const particle = particles[particleCursor];
      particleCursor = (particleCursor + 1) % particles.length;
      const spread = (random() - 0.5) * 18;
      const perpendicularX = -directionY;
      const perpendicularY = directionX;
      const drift = 8 + random() * 18;

      particle.active = true;
      particle.x = x + perpendicularX * spread;
      particle.y = y + perpendicularY * spread;
      particle.velocityX = -directionX * drift + perpendicularX * (random() - 0.5) * 10;
      particle.velocityY = -directionY * drift + perpendicularY * (random() - 0.5) * 10;
      particle.size = random() < 0.72 ? 2 : 3;
      particle.age = 0;
      particle.lifetime = 0.45 + random() * 0.35;
      particle.opacity = color.pixelAlpha * (0.55 + random() * 0.45);
    };

    const emitAlongPath = (fromX: number, fromY: number, toX: number, toY: number) => {
      const deltaX = toX - fromX;
      const deltaY = toY - fromY;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance < 0.5) return;

      const directionX = deltaX / distance;
      const directionY = deltaY / distance;
      let travelled = SPAWN_DISTANCE - spawnRemainder;
      let emitted = 0;

      while (travelled <= distance && emitted < 5) {
        const progress = travelled / distance;
        spawnParticle(
          fromX + deltaX * progress,
          fromY + deltaY * progress,
          directionX,
          directionY,
        );
        travelled += SPAWN_DISTANCE;
        emitted += 1;
      }

      spawnRemainder = (spawnRemainder + distance) % SPAWN_DISTANCE;
    };

    const drawHalo = () => {
      if (haloOpacity < 0.002) return;

      const radius = 92;
      const gradient = context.createRadialGradient(
        currentX,
        currentY,
        0,
        currentX,
        currentY,
        radius,
      );
      gradient.addColorStop(0, rgba(haloOpacity * color.haloAlpha));
      gradient.addColorStop(0.38, rgba(haloOpacity * color.haloAlpha * 0.55));
      gradient.addColorStop(1, rgba(0));
      context.fillStyle = gradient;
      context.fillRect(currentX - radius, currentY - radius, radius * 2, radius * 2);
    };

    const updateAndDrawParticles = (elapsed: number) => {
      let activeCount = 0;
      const drag = Math.exp(-elapsed * 2.4);

      for (const particle of particles) {
        if (!particle.active) continue;

        particle.age += elapsed;
        if (particle.age >= particle.lifetime) {
          particle.active = false;
          continue;
        }

        activeCount += 1;
        particle.velocityX *= drag;
        particle.velocityY *= drag;
        particle.x += particle.velocityX * elapsed;
        particle.y += particle.velocityY * elapsed;

        const progress = particle.age / particle.lifetime;
        const fade = 1 - progress * progress;
        context.fillStyle = rgba(particle.opacity * fade);
        const x = Math.round(particle.x);
        const y = Math.round(particle.y);
        context.fillRect(x, y, particle.size, particle.size);
      }

      return activeCount;
    };

    const draw = (elapsed: number) => {
      context.clearRect(0, 0, width, height);
      if (!enabled || width === 0 || height === 0) return 0;
      drawHalo();
      return updateAndDrawParticles(elapsed);
    };

    const scheduleFrame = () => {
      if (!frame && enabled) frame = window.requestAnimationFrame(tick);
    };

    const tick = (time: number) => {
      frame = 0;
      const elapsed = lastFrameTime ? Math.min((time - lastFrameTime) / 1000, 0.05) : 1 / 60;
      lastFrameTime = time;

      if (lastMoveTime && time - lastMoveTime > HALO_IDLE_DELAY) haloTarget = 0;

      const positionBlend = 1 - Math.exp(-elapsed * 18);
      const opacityBlend = 1 - Math.exp(-elapsed * 12);
      currentX += (targetX - currentX) * positionBlend;
      currentY += (targetY - currentY) * positionBlend;
      haloOpacity += (haloTarget - haloOpacity) * opacityBlend;

      const activeCount = draw(elapsed);
      const pointerMoving = Math.abs(targetX - currentX) + Math.abs(targetY - currentY) > 0.12;
      const haloMoving = Math.abs(haloTarget - haloOpacity) > 0.002;

      if (activeCount > 0 || pointerMoving || haloMoving || haloTarget > 0) {
        frame = window.requestAnimationFrame(tick);
      } else {
        haloOpacity = 0;
        context.clearRect(0, 0, width, height);
      }
    };

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_LIMIT);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!enabled || event.pointerType === "touch") return;

      const now = performance.now();
      if (!hasPointer) {
        currentX = targetX = previousX = event.clientX;
        currentY = targetY = previousY = event.clientY;
        hasPointer = true;
      } else {
        emitAlongPath(previousX, previousY, event.clientX, event.clientY);
        previousX = event.clientX;
        previousY = event.clientY;
      }

      targetX = event.clientX;
      targetY = event.clientY;
      lastMoveTime = now;
      haloTarget = 1;
      scheduleFrame();
    };

    const settle = () => {
      haloTarget = 0;
      lastMoveTime = 0;
      scheduleFrame();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) settle();
    };

    const handleCapabilityChange = () => {
      enabled = finePointer.matches && !reducedMotion.matches;
      if (!enabled) {
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
        haloTarget = 0;
        haloOpacity = 0;
        for (const particle of particles) particle.active = false;
      }
      context.clearRect(0, 0, width, height);
    };

    resize();
    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", settle);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", settle);
    finePointer.addEventListener("change", handleCapabilityChange);
    reducedMotion.addEventListener("change", handleCapabilityChange);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      document.documentElement.removeEventListener("pointerleave", settle);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", settle);
      finePointer.removeEventListener("change", handleCapabilityChange);
      reducedMotion.removeEventListener("change", handleCapabilityChange);
    };
  }, [product]);

  return (
    <span className="pixel-mist" aria-hidden="true">
      <canvas ref={canvasRef} />
    </span>
  );
}

export const PixelMist = memo(PixelMistComponent);

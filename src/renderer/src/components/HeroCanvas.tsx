import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * The welcome-screen centerpiece: a 3D Archimedean spiral — the curve the
 * name comes from — rendered as a soft monochrome point cloud with a bright
 * line core. Rotates slowly, drifts toward the pointer, never steals focus
 * from the actions below.
 */
export function HeroCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 0.1, 100);
    camera.position.set(0, 1.6, 9);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    // ---------- spiral geometry ----------
    const group = new THREE.Group();
    scene.add(group);

    const TURNS = 6.5;
    const POINTS = 2600;
    const positions = new Float32Array(POINTS * 3);
    const sizes = new Float32Array(POINTS);
    for (let i = 0; i < POINTS; i += 1) {
      const t = i / (POINTS - 1);
      const angle = t * TURNS * Math.PI * 2;
      const r = 0.22 * angle; // Archimedean: r = a·θ
      const jitter = 0.03 * Math.sin(i * 12.9898) ; // deterministic shimmer
      positions[i * 3] = r * Math.cos(angle) + jitter;
      positions[i * 3 + 1] = (t - 0.5) * 0.6 + 0.05 * Math.sin(angle * 3);
      positions[i * 3 + 2] = r * Math.sin(angle) + jitter * 0.5;
      sizes[i] = 0.02 + 0.05 * (1 - t);
    }

    const pointsGeo = new THREE.BufferGeometry();
    pointsGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    pointsGeo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const pointsMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.028,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    group.add(new THREE.Points(pointsGeo, pointsMat));

    // Bright core line following the same curve
    const CORE_POINTS = 400;
    const corePositions = new Float32Array(CORE_POINTS * 3);
    for (let i = 0; i < CORE_POINTS; i += 1) {
      const t = i / (CORE_POINTS - 1);
      const angle = t * TURNS * Math.PI * 2;
      const r = 0.22 * angle;
      corePositions[i * 3] = r * Math.cos(angle);
      corePositions[i * 3 + 1] = (t - 0.5) * 0.6;
      corePositions[i * 3 + 2] = r * Math.sin(angle);
    }
    const coreGeo = new THREE.BufferGeometry();
    coreGeo.setAttribute("position", new THREE.BufferAttribute(corePositions, 3));
    const coreLine = new THREE.Line(
      coreGeo,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    group.add(coreLine);

    // A few orbiting "satellite" rings for depth
    const rings: THREE.Line[] = [];
    for (let k = 0; k < 2; k += 1) {
      const RING_POINTS = 160;
      const ringPositions = new Float32Array(RING_POINTS * 3);
      const radius = 2.4 + k * 0.9;
      for (let i = 0; i < RING_POINTS; i += 1) {
        const a = (i / (RING_POINTS - 1)) * Math.PI * 2;
        ringPositions[i * 3] = radius * Math.cos(a);
        ringPositions[i * 3 + 1] = (k === 0 ? 1 : -1) * (0.9 + 0.15 * k);
        ringPositions[i * 3 + 2] = radius * Math.sin(a);
      }
      const ringGeo = new THREE.BufferGeometry();
      ringGeo.setAttribute("position", new THREE.BufferAttribute(ringPositions, 3));
      const ring = new THREE.Line(
        ringGeo,
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 }),
      );
      rings.push(ring);
      group.add(ring);
    }

    // Follow the theme's text color so the spiral stays visible on light themes.
    const materials = [pointsMat, coreLine.material, ...rings.map((ring) => ring.material)] as THREE.PointsMaterial[];
    const applyThemeColor = () => {
      const token = getComputedStyle(document.documentElement).getPropertyValue("--text").trim();
      if (!token) return;
      const color = new THREE.Color(token);
      for (const material of materials) material.color.set(color);
    };
    applyThemeColor();
    window.addEventListener("archymedes-theme", applyThemeColor);

    // ---------- interaction & loop ----------
    let pointerX = 0;
    let pointerY = 0;
    const onPointer = (e: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointerX = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      pointerY = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    };
    host.addEventListener("pointermove", onPointer);

    const onResize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    };
    window.addEventListener("resize", onResize);

    let raf = 0;
    let running = true;
    const clock = new THREE.Clock();

    const animate = () => {
      if (!running) return;
      const dt = clock.getDelta();
      const t = clock.elapsedTime;

      group.rotation.y += dt * 0.18;
      group.rotation.x = Math.sin(t * 0.3) * 0.12 + pointerY * 0.1;
      group.rotation.z = pointerX * 0.06;

      // Gentle breathing on the point cloud
      pointsMat.opacity = 0.45 + 0.1 * Math.sin(t * 0.8);
      coreLine.material.opacity = 0.75 + 0.15 * Math.sin(t * 0.5 + 1);

      rings.forEach((ring, k) => {
        ring.rotation.y -= dt * (0.1 + k * 0.07);
        ring.rotation.x = Math.cos(t * 0.25 + k) * 0.3;
      });

      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("archymedes-theme", applyThemeColor);
      host.removeEventListener("pointermove", onPointer);
      renderer.dispose();
      pointsGeo.dispose();
      coreGeo.dispose();
      if (coreLine.material instanceof THREE.Material) coreLine.material.dispose();
      if (renderer.domElement.parentElement === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div className="hero-canvas" ref={hostRef} />;
}

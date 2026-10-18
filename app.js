(() => {
  const dropzone = document.getElementById("dropzone");
  const workspace = document.getElementById("workspace");
  const fileInput = document.getElementById("file-input");
  const bgImage = document.getElementById("bg-image");
  const canvas = document.getElementById("rope-canvas");
  const ctx = canvas.getContext("2d");
  const frame = document.getElementById("canvas-frame");
  const hint = document.getElementById("hint");

  const btnAdd = document.getElementById("btn-add");
  const btnShake = document.getElementById("btn-shake");
  const btnClear = document.getElementById("btn-clear");
  const shakeWrap = document.getElementById("shake-wrap");
  const dirPad = document.getElementById("dir-pad");
  const propsWrap = document.getElementById("props-wrap");
  const lengthSlider = document.getElementById("length-slider");
  const lengthValue = document.getElementById("length-value");
  const colorInput = document.getElementById("color-input");
  const thicknessSlider = document.getElementById("thickness-slider");
  const thicknessValue = document.getElementById("thickness-value");
  const elasticitySlider = document.getElementById("elasticity-slider");
  const elasticityValue = document.getElementById("elasticity-value");

  const DIR_VECTORS = {
    n: { x: 0, y: -1 },
    ne: { x: 0.707, y: -0.707 },
    e: { x: 1, y: 0 },
    se: { x: 0.707, y: 0.707 },
    s: { x: 0, y: 1 },
    sw: { x: -0.707, y: 0.707 },
    w: { x: -1, y: 0 },
    nw: { x: -0.707, y: -0.707 },
    random: null,
  };

  /** @type {Rope[]} */
  let ropes = [];
  let placing = false;
  let pendingPoint = null;
  let slackFactor = Number(lengthSlider.value);
  let ropeColor = colorInput.value;
  let ropeThickness = Number(thicknessSlider.value);
  let ropeElasticity = Number(elasticitySlider.value);
  let selectedRopeIndex = -1;
  let shakeDir = "random";
  let animId = 0;
  let lastTs = 0;
  let lastCanvasW = 0;
  let lastCanvasH = 0;

  // 俯视桌面：没有“往下垂”的重力，只有平面摩擦与阻尼
  const BASE_DAMPING = 0.94;
  const BASE_ITERATIONS = 22;
  const BASE_SEGMENTS = 32;

  class Point {
    constructor(x, y, pinned = false) {
      this.x = x;
      this.y = y;
      this.ox = x;
      this.oy = y;
      this.pinned = pinned;
      this.mass = 1;
    }
  }

  class Rope {
    /**
     * @param {{x:number,y:number}} a
     * @param {{x:number,y:number}} b
     * @param {number} slack
     * @param {{color?:string, thickness?:number, elasticity?:number, seed?:number}} style
     */
    constructor(a, b, slack, style = {}) {
      this.a = { ...a };
      this.b = { ...b };
      this.seed = style.seed ?? Math.random() * 1000;
      this.slack = slack;
      this.baseColor = style.color || pickRopeHex(this.seed);
      this.color = colorToPalette(this.baseColor);
      this.thickness = style.thickness ?? 3.2;
      this.elasticity = style.elasticity ?? 0.62;
      this.points = [];
      this.restLength = 0;
      this.rebuild(slack, true);
    }

    setColor(hex) {
      this.baseColor = hex;
      this.color = colorToPalette(hex);
    }

    setThickness(v) {
      this.thickness = v;
    }

    setElasticity(v) {
      this.elasticity = Math.max(0.05, Math.min(1, v));
    }

    straightDistance() {
      return Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y);
    }

    rebuild(slack, resetShape) {
      this.slack = slack;
      const dist = Math.max(8, this.straightDistance());
      const totalLen = dist * slack;
      const segments = Math.min(
        88,
        Math.max(BASE_SEGMENTS, Math.round(BASE_SEGMENTS + (slack - 1) * 14))
      );
      this.restLength = totalLen / segments;

      if (resetShape || this.points.length !== segments + 1) {
        const old = this.points;
        const path = planarLoosePath(this.a, this.b, segments, slack, this.seed);
        this.points = [];
        for (let i = 0; i <= segments; i++) {
          const pinned = i === 0 || i === segments;
          if (!resetShape && old[i] && !pinned) {
            this.points.push(old[i]);
            this.points[i].pinned = false;
          } else {
            this.points.push(new Point(path[i].x, path[i].y, pinned));
          }
        }
      }

      this.pinEnds();
    }

    pinEnds() {
      this.points[0].x = this.a.x;
      this.points[0].y = this.a.y;
      this.points[0].ox = this.a.x;
      this.points[0].oy = this.a.y;
      this.points[0].pinned = true;

      const last = this.points.length - 1;
      this.points[last].x = this.b.x;
      this.points[last].y = this.b.y;
      this.points[last].ox = this.b.x;
      this.points[last].oy = this.b.y;
      this.points[last].pinned = true;
    }

    setSlack(slack) {
      const prev = this.slack;
      this.rebuild(slack, false);
      // 变长：多余长度在桌面平面上摊开成弯折/小圈，两端不动
      if (slack > prev) {
        const grow = (slack - prev) * this.straightDistance();
        const pts = this.points;
        for (let i = 1; i < pts.length - 1; i++) {
          const t = i / (pts.length - 1);
          const prevP = pts[i - 1];
          const nextP = pts[i + 1];
          let tx = nextP.x - prevP.x;
          let ty = nextP.y - prevP.y;
          const tl = Math.hypot(tx, ty) || 1;
          tx /= tl;
          ty /= tl;
          // 法线方向摊开
          const nx = -ty;
          const ny = tx;
          const lobe = Math.sin(t * Math.PI * (2.2 + (this.seed % 2)));
          const swirl = Math.sin(t * Math.PI * 5 + this.seed) * 0.55;
          const amp = grow * (0.12 + 0.22 * Math.sin(Math.PI * t));
          pts[i].x += (nx * lobe + tx * swirl) * amp;
          pts[i].y += (ny * lobe + ty * swirl) * amp;
          // 抹掉旧速度，避免突然弹飞
          pts[i].ox = pts[i].x;
          pts[i].oy = pts[i].y;
        }
      }
    }

    /**
     * @param {number} strength
     * @param {{x:number,y:number}|null} dir 指定方向；null 为全向随机
     */
    shake(strength = 1, dir = null) {
      // 图片不动，只在桌面平面上给绳子冲量
      for (let i = 1; i < this.points.length - 1; i++) {
        const p = this.points[i];
        const t = i / (this.points.length - 1);
        const envelope = Math.sin(Math.PI * t);
        const amp = (120 + Math.random() * 280) * strength * envelope;

        let dx;
        let dy;
        if (dir) {
          // 主方向 + 少量横向扰动，仍像软绳
          const jitter = (Math.random() - 0.5) * 0.55;
          const px = -dir.y;
          const py = dir.x;
          dx = dir.x + px * jitter;
          dy = dir.y + py * jitter;
          const len = Math.hypot(dx, dy) || 1;
          dx /= len;
          dy /= len;
        } else {
          const ang = Math.random() * Math.PI * 2;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
        }

        p.ox = p.x - dx * amp * 0.018;
        p.oy = p.y - dy * amp * 0.018;
        p.x += dx * (4 + Math.random() * 10) * strength;
        p.y += dy * (4 + Math.random() * 10) * strength;
      }
    }

    update(dt) {
      const points = this.points;
      // 弹性高：更弹、阻尼更低；弹性低：更软塌、更快贴桌停下
      const e = this.elasticity;
      const dampFactor = BASE_DAMPING - e * 0.06 + (1 - e) * 0.04;
      const damp = Math.pow(Math.min(0.995, Math.max(0.86, dampFactor)), dt * 60);
      const stiffness = 0.22 + e * 0.78;
      const iterations = Math.round(10 + e * (BASE_ITERATIONS - 4));

      for (let i = 1; i < points.length - 1; i++) {
        const p = points[i];
        const vx = (p.x - p.ox) * damp;
        const vy = (p.y - p.oy) * damp;
        p.ox = p.x;
        p.oy = p.y;
        p.x += vx;
        p.y += vy;
      }

      this.pinEnds();

      for (let k = 0; k < iterations; k++) {
        for (let i = 0; i < points.length - 1; i++) {
          const p1 = points[i];
          const p2 = points[i + 1];
          let dx = p2.x - p1.x;
          let dy = p2.y - p1.y;
          let d = Math.hypot(dx, dy) || 0.0001;
          const diff = ((d - this.restLength) / d) * stiffness;
          const offsetX = dx * 0.5 * diff;
          const offsetY = dy * 0.5 * diff;

          if (!p1.pinned) {
            p1.x += offsetX;
            p1.y += offsetY;
          }
          if (!p2.pinned) {
            p2.x -= offsetX;
            p2.y -= offsetY;
          }
        }

        // 桌面自避让：近段互相轻轻推开，堆出自然弯曲而不是粘成一团
        if (k % 2 === 0 && this.slack > 1.15) {
          const minD = this.restLength * 0.85;
          for (let i = 1; i < points.length - 1; i++) {
            for (let j = i + 3; j < points.length - 1; j++) {
              const p = points[i];
              const q = points[j];
              let dx = q.x - p.x;
              let dy = q.y - p.y;
              let d = Math.hypot(dx, dy);
              if (d > 0.001 && d < minD) {
                const push = ((minD - d) / d) * 0.18;
                p.x -= dx * push;
                p.y -= dy * push;
                q.x += dx * push;
                q.y += dy * push;
              }
            }
          }
        }
      }

      this.pinEnds();
    }

    draw(context, highlight) {
      const pts = this.points;
      if (pts.length < 2) return;

      context.save();
      context.lineCap = "round";
      context.lineJoin = "round";

      // 贴桌面的轻微接触阴影（不是悬空下垂阴影）
      context.beginPath();
      context.moveTo(pts[0].x + 0.8, pts[0].y + 0.8);
      for (let i = 1; i < pts.length; i++) {
        context.lineTo(pts[i].x + 0.8, pts[i].y + 0.8);
      }
      context.strokeStyle = "rgba(0, 0, 0, 0.22)";
      context.lineWidth = this.thickness + 1.2;
      context.stroke();

      // 主绳
      const grad = context.createLinearGradient(
        pts[0].x,
        pts[0].y,
        pts[pts.length - 1].x,
        pts[pts.length - 1].y
      );
      grad.addColorStop(0, this.color.a);
      grad.addColorStop(0.5, this.color.b);
      grad.addColorStop(1, this.color.c);

      context.beginPath();
      context.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const xc = (pts[i].x + pts[i + 1].x) / 2;
        const yc = (pts[i].y + pts[i + 1].y) / 2;
        context.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
      }
      const n = pts.length;
      context.quadraticCurveTo(
        pts[n - 2].x,
        pts[n - 2].y,
        pts[n - 1].x,
        pts[n - 1].y
      );
      context.strokeStyle = grad;
      context.lineWidth = this.thickness;
      context.stroke();

      // 高光细线
      context.beginPath();
      context.moveTo(pts[0].x - 0.6, pts[0].y - 0.6);
      for (let i = 1; i < pts.length; i++) {
        context.lineTo(pts[i].x - 0.6, pts[i].y - 0.6);
      }
      context.strokeStyle = "rgba(255, 235, 210, 0.28)";
      context.lineWidth = Math.max(0.8, this.thickness * 0.28);
      context.stroke();

      if (highlight) {
        // 端点
        for (const p of [pts[0], pts[n - 1]]) {
          context.beginPath();
          context.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
          context.fillStyle = "rgba(255, 248, 238, 0.95)";
          context.fill();
          context.strokeStyle = "rgba(93, 184, 168, 0.95)";
          context.lineWidth = 2;
          context.stroke();
        }
      }

      context.restore();
    }
  }

  function pickRopeHex(seed) {
    const hexes = ["#8a5a34", "#6f8464", "#9a6460", "#78728a", "#c09a55"];
    return hexes[Math.floor(seed * 17) % hexes.length];
  }

  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(r, g, b) {
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return (
      "#" +
      [clamp(r), clamp(g), clamp(b)]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
    );
  }

  function shadeRgb(rgb, factor) {
    if (factor >= 1) {
      return {
        r: rgb.r + (255 - rgb.r) * (factor - 1),
        g: rgb.g + (255 - rgb.g) * (factor - 1),
        b: rgb.b + (255 - rgb.b) * (factor - 1),
      };
    }
    return { r: rgb.r * factor, g: rgb.g * factor, b: rgb.b * factor };
  }

  function colorToPalette(hex) {
    const rgb = hexToRgb(hex);
    const dark = shadeRgb(rgb, 0.72);
    const mid = shadeRgb(rgb, 1.08);
    const deep = shadeRgb(rgb, 0.55);
    return {
      a: rgbToHex(dark.r, dark.g, dark.b),
      b: rgbToHex(mid.r, mid.g, mid.b),
      c: rgbToHex(deep.r, deep.g, deep.b),
    };
  }

  function pseudoNoise(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }

  function targetRopes() {
    if (selectedRopeIndex >= 0 && ropes[selectedRopeIndex]) {
      return [ropes[selectedRopeIndex]];
    }
    return ropes;
  }

  function syncPropsFromRope(rope) {
    slackFactor = rope.slack;
    ropeColor = rope.baseColor;
    ropeThickness = rope.thickness;
    ropeElasticity = rope.elasticity;
    lengthSlider.value = String(rope.slack);
    lengthValue.textContent = `${rope.slack.toFixed(2)}×`;
    colorInput.value = rope.baseColor;
    thicknessSlider.value = String(rope.thickness);
    thicknessValue.textContent = rope.thickness.toFixed(1);
    elasticitySlider.value = String(rope.elasticity);
    elasticityValue.textContent = `${Math.round(rope.elasticity * 100)}%`;
  }

  /** 俯视桌面上的松软绳：两端固定，中间随机弯折铺开 */
  function planarLoosePath(a, b, segments, slack, seed) {
    const dist = Math.max(8, Math.hypot(b.x - a.x, b.y - a.y));
    const ux = (b.x - a.x) / dist;
    const uy = (b.y - a.y) / dist;
    const nx = -uy;
    const ny = ux;
    const excess = Math.max(0, slack - 1);

    // 几组不同频率的平面波浪，方向随机，像绳子随便扔在桌上
    const waves = [
      {
        freq: 1.1 + (seed % 1.4),
        amp: excess * dist * (0.18 + (seed % 0.12)),
        phase: seed * 1.7,
        mix: 0.55,
      },
      {
        freq: 2.4 + ((seed * 3) % 1.8),
        amp: excess * dist * (0.1 + ((seed * 2) % 0.1)),
        phase: seed * 4.2,
        mix: 0.35,
      },
      {
        freq: 4.1 + ((seed * 5) % 2.2),
        amp: excess * dist * 0.06,
        phase: seed * 9.1,
        mix: 0.25,
      },
    ];

    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      // 端点附近收束，中间最松
      const envelope = Math.sin(Math.PI * t);
      let x = a.x + (b.x - a.x) * t;
      let y = a.y + (b.y - a.y) * t;

      if (i > 0 && i < segments && excess > 0) {
        let lateral = 0;
        let along = 0;
        for (const w of waves) {
          const s = Math.sin(t * Math.PI * w.freq + w.phase);
          const c = Math.cos(t * Math.PI * w.freq * 0.7 + w.phase * 1.3);
          lateral += s * w.amp * w.mix;
          along += c * w.amp * w.mix * 0.35;
        }
        lateral += pseudoNoise(seed + i * 0.41) * excess * dist * 0.05;
        along += pseudoNoise(seed + i * 0.73 + 20) * excess * dist * 0.03;
        x += (nx * lateral + ux * along) * envelope;
        y += (ny * lateral + uy * along) * envelope;
      }
      pts.push({ x, y });
    }
    return pts;
  }

  function setButtonsEnabled(on) {
    btnAdd.disabled = !on;
    const hasRopes = on && ropes.length > 0;
    shakeWrap.hidden = !hasRopes;
    btnClear.disabled = !hasRopes;
    propsWrap.hidden = !hasRopes;
  }

  function loadImageFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    bgImage.onload = () => {
      // 上传成功后彻底移除上传区，不再保留
      dropzone.remove();
      workspace.hidden = false;
      ropes = [];
      selectedRopeIndex = -1;
      pendingPoint = null;
      placing = false;
      btnAdd.classList.remove("active");
      hint.hidden = true;
      setButtonsEnabled(true);
      requestAnimationFrame(() => {
        syncCanvasSize();
        startLoop();
        URL.revokeObjectURL(url);
      });
    };
    bgImage.src = url;
  }

  function syncCanvasSize() {
    const rect = bgImage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    if (lastCanvasW > 0 && lastCanvasH > 0 && (w !== lastCanvasW || h !== lastCanvasH)) {
      const sx = w / lastCanvasW;
      const sy = h / lastCanvasH;
      for (const rope of ropes) scaleRope(rope, sx, sy);
    }

    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lastCanvasW = w;
    lastCanvasH = h;
  }

  function scaleRope(rope, sx, sy) {
    rope.a.x *= sx;
    rope.a.y *= sy;
    rope.b.x *= sx;
    rope.b.y *= sy;
    for (const p of rope.points) {
      p.x *= sx;
      p.y *= sy;
      p.ox *= sx;
      p.oy *= sy;
    }
    rope.restLength *= (sx + sy) / 2;
  }

  function canvasPointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  function startLoop() {
    cancelAnimationFrame(animId);
    lastTs = 0;
    const tick = (ts) => {
      if (!lastTs) lastTs = ts;
      let dt = (ts - lastTs) / 1000;
      lastTs = ts;
      dt = Math.min(dt, 1 / 30);

      for (const rope of ropes) rope.update(dt);
      draw();
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
  }

  function draw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < ropes.length; i++) {
      ropes[i].draw(ctx, i === selectedRopeIndex);
    }

    if (pendingPoint) {
      ctx.beginPath();
      ctx.arc(pendingPoint.x, pendingPoint.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(93, 184, 168, 0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,248,238,0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // —— 交互（上传区只在首次使用；成功后会从 DOM 移除）——
  if (dropzone && fileInput) {
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("dragover");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      const file = e.dataTransfer?.files?.[0];
      loadImageFile(file);
    });
    fileInput.addEventListener("change", () => {
      loadImageFile(fileInput.files?.[0]);
    });
  }

  btnAdd.addEventListener("click", () => {
    placing = !placing;
    pendingPoint = null;
    btnAdd.classList.toggle("active", placing);
    hint.hidden = !placing;
    hint.textContent = "点击第一个端点";
    frame.classList.toggle("placing", placing);
  });

  dirPad.addEventListener("click", (e) => {
    const btn = e.target.closest(".dir-btn");
    if (!btn) return;
    shakeDir = btn.dataset.dir || "random";
    dirPad.querySelectorAll(".dir-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
  });

  btnShake.addEventListener("click", () => {
    if (!ropes.length) return;
    const dir = DIR_VECTORS[shakeDir] ?? null;
    for (const rope of ropes) {
      rope.shake(0.85 + Math.random() * 0.55, dir);
    }
    // 按所选方向轻微甩一下按钮
    const nudge = dir
      ? { transform: `translate(${dir.x * 5}px, ${dir.y * 5}px)` }
      : { transform: "rotate(6deg)" };
    btnShake.animate(
      [{ transform: "none" }, nudge, { transform: "none" }],
      { duration: 320, easing: "ease-out" }
    );
  });

  btnClear.addEventListener("click", () => {
    ropes = [];
    selectedRopeIndex = -1;
    pendingPoint = null;
    placing = false;
    btnAdd.classList.remove("active");
    hint.hidden = true;
    setButtonsEnabled(true);
  });

  lengthSlider.addEventListener("input", () => {
    slackFactor = Number(lengthSlider.value);
    lengthValue.textContent = `${slackFactor.toFixed(2)}×`;
    for (const rope of targetRopes()) rope.setSlack(slackFactor);
  });

  colorInput.addEventListener("input", () => {
    ropeColor = colorInput.value;
    for (const rope of targetRopes()) rope.setColor(ropeColor);
  });

  thicknessSlider.addEventListener("input", () => {
    ropeThickness = Number(thicknessSlider.value);
    thicknessValue.textContent = ropeThickness.toFixed(1);
    for (const rope of targetRopes()) rope.setThickness(ropeThickness);
  });

  elasticitySlider.addEventListener("input", () => {
    ropeElasticity = Number(elasticitySlider.value);
    elasticityValue.textContent = `${Math.round(ropeElasticity * 100)}%`;
    for (const rope of targetRopes()) rope.setElasticity(ropeElasticity);
  });

  function onPointerDown(e) {
    if (!bgImage.src) return;
    e.preventDefault();
    const p = canvasPointFromEvent(e);

    if (placing) {
      if (!pendingPoint) {
        pendingPoint = p;
        hint.textContent = "再点第二个端点，拉出软绳";
      } else {
        const rope = new Rope(pendingPoint, p, slackFactor, {
          color: ropeColor,
          thickness: ropeThickness,
          elasticity: ropeElasticity,
          seed: Math.random() * 1000,
        });
        ropes.push(rope);
        selectedRopeIndex = ropes.length - 1;
        pendingPoint = null;
        placing = false;
        btnAdd.classList.remove("active");
        hint.hidden = true;
        frame.classList.remove("placing");
        setButtonsEnabled(true);
        syncPropsFromRope(rope);
      }
      return;
    }

    // 选中最近的绳子（点到端点附近）
    let best = -1;
    let bestD = 28;
    for (let i = 0; i < ropes.length; i++) {
      const r = ropes[i];
      const d1 = Math.hypot(p.x - r.a.x, p.y - r.a.y);
      const d2 = Math.hypot(p.x - r.b.x, p.y - r.b.y);
      const d = Math.min(d1, d2);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      selectedRopeIndex = best;
      syncPropsFromRope(ropes[best]);
    }
  }

  canvas.addEventListener("mousedown", onPointerDown);
  canvas.addEventListener("touchstart", onPointerDown, { passive: false });

  window.addEventListener("resize", () => {
    if (!workspace.hidden) syncCanvasSize();
  });

  // 图片尺寸变化后再对齐一次
  const ro = new ResizeObserver(() => {
    if (!workspace.hidden) syncCanvasSize();
  });
  ro.observe(bgImage);
})();

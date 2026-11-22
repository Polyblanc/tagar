// models.js — procedural voxel models. Each factory returns { root, update(t, dt, camWorld) }.
// root sits on the tag: y up, model faces +z (toward the tag's printed bottom edge).
// Units inside a model are voxels; root.scale converts voxels -> tag widths.
import * as THREE from 'three';

// ---------------------------------------------------------------- voxel builder
// Voxels live on a grid; xo = 0.5 puts x on half-integers so a model can be exactly symmetric about x = 0.
export class Vox {
  constructor(xo = 0) { this.xo = xo; this.map = new Map(); }
  set(x, y, z, c, tag) { this.map.set(`${x},${y},${z}`, { x, y, z, c, tag }); return this; }
  del(x, y, z) { this.map.delete(`${x},${y},${z}`); return this; }
  has(x, y, z) { return this.map.has(`${x},${y},${z}`); }
  box(x0, x1, y0, y1, z0, z1, c, tag) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, c, tag);
    return this;
  }
  ellipsoid(cx, cy, cz, rx, ry, rz, c) {
    for (let i = Math.floor(cx - rx) - 1; i <= Math.ceil(cx + rx) + 1; i++) {
      const x = i + this.xo;
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++)
          if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1) this.set(x, y, z, c);
    }
    return this;
  }
  // fn(v) returns a new colour or null to leave it
  paint(fn) { for (const v of this.map.values()) { const c = fn(v); if (c != null) v.c = c; } return this; }
  carve(fn) { for (const [k, v] of this.map) if (fn(v)) this.map.delete(k); return this; }
  // One InstancedMesh = one draw call. userData.tags[tag] = instance indices (for blinking etc.)
  mesh(material, gap = 0.96) {
    const vs = [...this.map.values()];
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(gap, gap, gap), material, vs.length);
    const M = new THREE.Matrix4(), col = new THREE.Color(), tags = {};
    vs.forEach((v, i) => {
      m.setMatrixAt(i, M.makeTranslation(v.x, v.y, v.z));
      m.setColorAt(i, col.setHex(v.c));
      if (v.tag) (tags[v.tag] ??= []).push(i);
    });
    m.userData.tags = tags;
    return m;
  }
}

// Wrap a mesh built in model coordinates into a group whose origin is `pivot` (so it rotates about it).
function pivoted(mesh, [px, py, pz]) {
  const g = new THREE.Group();
  g.position.set(px, py, pz);
  mesh.position.set(-px, -py, -pz);
  g.add(mesh);
  return g;
}

const matte = () => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
const metal = () => new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.6 });
const camIn = (obj, camWorld) => obj.worldToLocal(camWorld.clone()); // camera position in obj's frame
const smooth = (x) => x * x * (3 - 2 * x);

// ================================================================ 1. VOXEL CAT
// Sits, tail whips, head locks onto the camera — full 360°, owl-style, no smoothing.
export function makeCat() {
  const C = { fur: 0xe8913a, dark: 0xa95a1c, cream: 0xf7e6c8, pink: 0xf29aa6, eye: 0x141414, glint: 0xffffff };
  const root = new THREE.Group();
  root.scale.setScalar(1 / 19); // ~19 voxels tall -> ~1 tag width

  // --- body (static)
  const body = new Vox(0.5)
    .ellipsoid(0, 2.5, -1.5, 4.3, 3, 4, C.fur)    // haunches
    .ellipsoid(0, 6.5, 0.5, 3.3, 4.6, 3, C.fur)   // upright torso
    .box(-2.5, -1.5, 0, 5, 2, 3, C.fur)           // front legs
    .box(1.5, 2.5, 0, 5, 2, 3, C.fur);
  body.box(-2.5, -1.5, 0, 0, 2, 4, C.cream).box(1.5, 2.5, 0, 0, 2, 4, C.cream); // front paws
  body.box(-4.5, -3.5, 0, 0, 0, 1, C.cream).box(3.5, 4.5, 0, 0, 0, 1, C.cream); // hind paws
  body.paint((v) => (v.z >= 2 && v.y >= 6 && Math.abs(v.x) <= 2 ? C.cream : null));            // chest bib
  body.paint((v) => (v.c === C.fur && Math.abs(v.x) >= 2.5 && v.y % 3 === 0 ? C.dark : null)); // flank stripes
  root.add(body.mesh(matte()));

  // --- head (rotates about its own centre column)
  const head = new Vox(0.5).box(-3.5, 3.5, 0, 5, -3, 3, C.fur);
  head.carve((v) => Math.abs(v.x) === 3.5 && Math.abs(v.z) === 3);                     // round the corners
  head.carve((v) => v.y === 5 && (Math.abs(v.x) === 3.5 || Math.abs(v.z) === 3));
  for (const s of [-1, 1]) {                                                            // ears
    head.box(s * 1.5, s * 1.5, 6, 6, -1, 1, C.fur).box(s * 2.5, s * 2.5, 6, 7, -1, 1, C.fur).set(s * 3.5, 6, 0, C.fur);
    head.set(s * 2.5, 6, 1, C.pink).set(s * 2.5, 7, 1, C.pink);
    head.set(s * 1.5, 2, 3, C.eye, 'eye').set(s * 1.5, 3, 3, C.eye, 'eye');            // eyes
    head.set(s * 2.5, 1, 3, C.cream);                                                   // cheeks
  }
  head.box(-1.5, 1.5, 0, 1, 4, 4, C.cream).set(-0.5, 1, 4, C.pink).set(0.5, 1, 4, C.pink); // muzzle + nose
  head.paint((v) => (v.y === 5 && Math.abs(v.x) <= 0.5 && v.z <= 2 ? C.dark : null));     // head stripe
  head.set(-0.5, 4, 3, C.dark).set(0.5, 4, 3, C.dark);                                    // forehead mark
  const headMesh = head.mesh(matte());
  const headG = new THREE.Group();
  headG.position.set(0, 10.5, 1);
  headG.add(headMesh);
  root.add(headG);

  // --- tail: chain of 10 segments, each parented to the previous one
  const tail = [];
  let parent = root;
  for (let i = 0; i < 10; i++) {
    const seg = new THREE.Group();
    seg.position.set(0, i === 0 ? 1 : 0, i === 0 ? -5.5 : -1);
    const tip = i >= 8;
    const v = new Vox(0.5).box(-0.5, 0.5, 0, tip ? 0 : 1, 0, 0, i % 2 ? C.dark : C.fur);
    if (i === 9) v.paint(() => C.cream);
    const mesh = v.mesh(matte());
    mesh.position.y = -0.5;
    seg.add(mesh);
    parent.add(seg);
    tail.push(seg);
    parent = seg;
  }

  const eyeIdx = headMesh.userData.tags.eye, col = new THREE.Color();
  let blinkState = false;
  return {
    root,
    update(t, dt, camWorld) {
      // Tail: travelling wave from base to tip; amplitude grows toward the tip -> "whip".
      tail.forEach((seg, i) => {
        seg.rotation.order = 'YXZ';
        seg.rotation.y = (0.12 + 0.06 * i) * Math.sin(5.5 * t - 0.7 * i);
        seg.rotation.x = i === 0 ? 0.1 : 0.13 + 0.06 * Math.sin(2.1 * t - 0.5 * i); // curl upward
      });
      // Head: point local +z straight at the camera. Rigid = no easing.
      const c = camIn(root, camWorld).sub(headG.position);
      const yaw = Math.atan2(c.x, c.z);
      const pitch = THREE.MathUtils.clamp(-Math.atan2(c.y, Math.hypot(c.x, c.z)), -1.0, 0.7);
      headG.rotation.set(pitch, yaw, 0, 'YXZ');
      // Blink ~every 4 s for 120 ms
      const blink = t % 4.1 < 0.12;
      if (blink !== blinkState) {
        blinkState = blink;
        for (const i of eyeIdx) headMesh.setColorAt(i, col.setHex(blink ? C.fur : C.eye));
        headMesh.instanceColor.needsUpdate = true;
      }
    },
  };
}

// ================================================================ 2. CLOCKWORK BIRD
// Everything moves in ticks: motion snaps fast, then holds, like an escapement.
export function makeBird() {
  const B = { brass: 0xc9a227, dark: 0x7a5a14, copper: 0xb8693a, steel: 0xb3bac2, ruby: 0xd0102c, black: 0x161616 };
  const root = new THREE.Group();
  root.scale.setScalar(1 / 15);
  const hop = new THREE.Group(); // everything rides on this for the hop
  root.add(hop);
  const mat = metal();

  // body: egg, tipped forward
  const body = new Vox(0.5).ellipsoid(0, 5.5, 0.5, 2.7, 2.8, 3.8, B.brass);
  body.paint((v) => (v.y <= 5 && v.z >= 1.5 && Math.abs(v.x) <= 1.5 ? B.copper : null));                 // belly plate
  body.paint((v) => (v.y >= 7 && Math.abs(v.x) === 0.5 && v.z % 2 === 0 ? B.dark : null));               // rivet seam
  for (const s of [-1, 1]) {
    body.box(s * 1.5, s * 1.5, 0, 3, 0, 0, B.steel);                                                     // legs
    body.box(s * 1.5, s * 1.5, 0, 0, 1, 2, B.steel).set(s * 1.5, 0, -1, B.steel);                        // toes
  }
  // tail: plates stepping up and back, fanning wider
  [[0.5, 6, -3], [1.5, 7, -4], [1.5, 8, -5], [2.5, 9, -6], [2.5, 10, -7]].forEach(([w, y, z]) => {
    for (let x = -w; x <= w; x++) body.set(x, y, z, Math.abs(x) % 2 === 0.5 ? B.brass : B.dark);
  });
  hop.add(body.mesh(mat));

  // head
  const head = new Vox(0.5).ellipsoid(0, 1.5, 0, 2.6, 2.3, 2.6, B.brass);
  head.box(-0.5, 0.5, 1, 2, 3, 3, B.steel).box(-0.5, 0.5, 1, 1, 4, 5, B.steel);                         // beak
  head.set(-2.5, 2, 0, B.ruby).set(2.5, 2, 0, B.ruby);                                                   // ruby eyes
  for (const x of [-0.5, 0.5]) head.set(x, 4, 0, B.copper).set(x, 4, -1, B.copper).set(x, 5, -1, B.copper).set(x, 5, -2, B.copper); // crest
  const headG = new THREE.Group();
  headG.position.set(0, 9, 2.5);
  headG.add(head.mesh(mat));
  hop.add(headG);

  // wings: swept-back feather plates, a small gear at each shoulder
  const wings = [], gears = [];
  const WING = [[1, -1, 2], [0, -3, 2], [-1, -5, 1], [-2, -6, -1]]; // [y, zFrom, zTo] rows in the wing plane
  for (const s of [-1, 1]) {
    const w = new Vox(0.5);
    for (const [y, z0, z1] of WING) for (let z = z0; z <= z1; z++) w.set(s * 0.5, y, z, z % 2 ? B.brass : B.dark);
    const wingG = new THREE.Group();
    wingG.position.set(s * 3, 7, 0.5);
    wingG.add(w.mesh(mat));
    const g = new Vox(0);
    for (let y = -3; y <= 3; y++) for (let z = -3; z <= 3; z++) {
      const r = Math.hypot(y, z), a = Math.atan2(z, y);
      if (r < 0.8) g.set(0, y, z, B.ruby);
      else if (r >= 1.4 && r <= 2.6) g.set(0, y, z, B.steel);
      else if (r > 2.6 && r <= 3.3 && Math.round(a / (Math.PI / 4)) % 2 === 0) g.set(0, y, z, B.steel); // teeth
    }
    const gearG = new THREE.Group();
    gearG.position.set(s * 1.0, 0.3, 0.8);
    gearG.scale.setScalar(0.4);
    gearG.add(g.mesh(mat));
    wingG.add(gearG);
    hop.add(wingG);
    wings.push([s, wingG]); gears.push([s, gearG]);
  }

  // wind-up key on the back
  const key = new Vox(0).box(0, 0, 0, 0, -2, 0, B.steel);
  for (let x = -3; x <= 3; x++) for (let y = -1; y <= 1; y++) {
    const ax = Math.abs(x);
    if (x === 0 ? y === 0 : (ax === 1 && y === 0) || ax >= 2) key.set(x, y, -3, B.copper);
  }
  const keyG = new THREE.Group();
  keyG.position.set(0, 7.5, -3);
  keyG.add(key.mesh(mat));
  hop.add(keyG);

  const ratchet = (t, rate) => { const p = t * rate, n = Math.floor(p); return n + smooth(Math.min(1, (p - n) * 6)); };
  const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  return {
    root,
    update(t) {
      keyG.rotation.z = ratchet(t, 2) * (Math.PI / 6);                           // 30° clicks, twice a second
      for (const [s, g] of gears) g.rotation.x = s * ratchet(t, 5) * (Math.PI / 8);
      // head: new pose every 0.7 s, snapped into place; sometimes a peck
      const n = Math.floor(t / 0.7), f = (t / 0.7) - n;
      const snap = smooth(Math.min(1, f * 5));
      const yawFrom = (hash(n - 1) - 0.5) * 1.8, yawTo = (hash(n) - 0.5) * 1.8;
      headG.rotation.order = 'YXZ';
      headG.rotation.y = yawFrom + (yawTo - yawFrom) * snap;
      headG.rotation.x = hash(n + 99) > 0.75 && f < 0.5 ? 0.6 : 0;
      // wings: a 0.9 s flurry every 5 s
      const ph = t % 5, flap = ph < 0.9 ? 0.9 * Math.abs(Math.sin(ph * Math.PI * 3.3)) : 0;
      for (const [s, w] of wings) w.rotation.z = s * flap;
      // hop every 3 s
      const hp = t % 3;
      hop.position.y = hp < 0.35 ? 2.2 * Math.sin((hp / 0.35) * Math.PI) : 0;
    },
  };
}

// ================================================================ 3. STIRNER, IN PROFILE
// A 2.5-D voxel cutout that always turns its side to you. Edit the sprite to taste.
// Keys: H hair  S skin  s skin shadow  E eye  C collar  K cravat  J coat  j coat highlight  P plinth  c cigarette  e ember
const STIRNER = [
  '......HHHHHHH...........',
  '....HHHHHHHHHHH.........',
  '...HHHHHHHHHHHHHH.......',
  '..HHHHHHHHHHHHHHHH......',
  '.HHHHHHHHHHHHHHHHH......',
  '.HHHHHHHHHHHHHHHH.......',
  '.HHHHHHHHHHSSSSS........',
  '.HHHHHHHHHSSSSSSS.......',
  '.HHHHHHHHHSSSSSSS.......',
  '.HHHHHHH..HHSSSSSS......',
  '.HHHHHHH..HHSHHHS.......',
  '.HHHHHHHssHHSSsES.......',
  '.HHHHHHHssHHSSSSSS......',
  '..HHHHHHssHHSSSSSSS.....',
  '..HHHHHHssHHSSSSSSSS....',
  '...HHHHHSSHHSSSSSSSSS...',
  '....HHHHSSHHSSSSSSss....',
  '.......SSSHHSSSSSS......',
  '.......SSSSSSSSSSSS.....',
  '.......SSSSSSSSSss......',
  '.......SSSSSSSSSSSScccce',
  '.......SSSSSSSSSSS......',
  '.......SSSSSSSSSS.......',
  '........SSSSSSSSSS......',
  '........SSSSSSSSSS......',
  '.........SSSSSsss.......', // ---- head above this line (rows 0–25), body below
  '........SSsssCCC........',
  '.......CCSSSSCCC........',
  '......CCCCKKKKKKC.......',
  '.....JJJJJKKKKKKKJ......',
  '....JJJJJJJKKKKKJJJ.....',
  '...JJJJJJJJJjjJJJJJJ....',
  '..JJJJJJJJJJJjjJJJJJ....',
  '..JJJJJJJJJJJJJJJJJJ....',
  '.JJJJjjjjjjjjjjjjjjS....',
  '.JJJJjjjjjjjjjjjjjjj....',
  '.JJJJJJJJJJJJJJJJJJJ....',
  '.JJJJJJJJJJJJJJJJJJJ....',
  'PPPPPPPPPPPPPPPPPPPPPPPP',
  'PPPPPPPPPPPPPPPPPPPPPPPP',
];
const HEAD_ROWS = 26;
const PAL = { H: [0x3b2a1e, 4], S: [0xe9c3a0, 4], s: [0xc99b78, 4], E: [0x1a1a1a, 4], C: [0xf2efe6, 6], K: [0x111111, 6],
  J: [0x26303f, 6], j: [0x3a4658, 6], P: [0x8a8580, 8], c: [0xf4f1ea, 1] }; // [colour, depth in voxels]

export function makeStirner() {
  const root = new THREE.Group();
  root.scale.setScalar(1 / 34);
  const turn = new THREE.Group(); // the part that billboards
  root.add(turn);
  const rows = STIRNER.length, cx = 11;
  const head = new Vox(0), body = new Vox(0);
  let ember = null;
  STIRNER.forEach((line, r) => [...line].forEach((ch, c) => {
    if (ch === 'e') { ember = [c - cx, rows - 1 - r]; return; }
    const p = PAL[ch]; if (!p) return;
    const [color, depth] = p, z0 = -Math.floor(depth / 2);
    for (let z = z0; z < z0 + depth; z++) (r < HEAD_ROWS ? head : body).set(c - cx, rows - 1 - r, z, color);
  }));
  turn.add(body.mesh(matte(), 1)); // gap 1 = solid: reads as a cut-out
  const neck = [0, rows - HEAD_ROWS, 0]; // head pivots at the neck
  const headG = pivoted(head.mesh(matte(), 1), neck);
  turn.add(headG);
  const emberMat = new THREE.MeshStandardMaterial({ color: 0xff6a1a, emissive: 0xff4400, emissiveIntensity: 1 });
  const emberMesh = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.96, 0.96), emberMat);
  emberMesh.position.set(ember[0] - neck[0], ember[1] - neck[1], 0);
  headG.add(emberMesh);

  // smoke: a small pool of voxels that rise, grow and fade
  const puffs = [];
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xdddddd, transparent: true, opacity: 0, depthWrite: false }));
    m.visible = false; turn.add(m); puffs.push({ m, age: 99 });
  }
  let nextPuff = 0, nextSlot = 0;
  const tmp = new THREE.Vector3();

  return {
    root,
    update(t, dt, camWorld) {
      // Billboard about the vertical axis so local +z (the side of the sprite) faces the camera.
      const c = camIn(root, camWorld);
      turn.rotation.y = Math.atan2(c.x, c.z);
      // Proud chin, slow breathing
      headG.rotation.z = 0.06 + 0.04 * Math.sin(t * 0.7);
      headG.position.y = neck[1] + 0.25 * Math.sin(t * 1.6);
      emberMat.emissiveIntensity = 0.7 + 0.5 * Math.abs(Math.sin(t * 9) * Math.sin(t * 3.7));
      // Smoke
      if (t > nextPuff) {
        nextPuff = t + 0.35;
        const p = puffs[nextSlot++ % puffs.length];
        emberMesh.getWorldPosition(tmp); turn.worldToLocal(tmp);
        p.m.position.copy(tmp); p.age = 0; p.drift = (Math.random() - 0.5) * 0.6; p.m.visible = true;
      }
      for (const p of puffs) {
        if (p.age > 2.6) { p.m.visible = false; continue; }
        p.age += dt;
        p.m.position.y += 1.6 * dt; p.m.position.x += (0.3 + p.drift) * dt; p.m.position.z += p.drift * dt;
        p.m.scale.setScalar(0.5 + p.age * 0.5);
        p.m.material.opacity = 0.6 * (1 - p.age / 2.6);
      }
    },
  };
}

export const MODELS = { cat: makeCat, bird: makeBird, stirner: makeStirner };
